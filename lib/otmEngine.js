/**
 * Montra OTM engine — key-authenticated one-time message API.
 *
 * One message per request (instant or scheduled) with a hard 600-character cap.
 * The endpoint never accepts the dashboard token: callers prove access with the
 * predefined MONTRA_OTM_KEY, supplied as X-OTM-Key, ?key=, or a JSON key field.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const syncStore = require('./syncStore');
const timeEngine = require('./timeEngine');
const { parseScheduleTime } = require('./statusScheduler');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'otmJobs.json');
const AUDIT_FILE = path.join(DATA_DIR, 'tgAudit.jsonl');

const MAX_MESSAGE_CHARS = 600;
const MAX_JOBS = 500;
const MAX_IDEMPOTENCY = 500;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_VARS = 25;
const MAX_VAR_CHARS = 300;
const MAX_IDEMPOTENCY_CHARS = 80;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60 * 1000;
const POLL_MS = 15 * 1000;
const MIN_KEY_CHARS = 8;
const KEY_ENVS = ['MONTRA_OTM_KEY', 'OTM_KEY'];

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function charLength(value) {
  return Array.from(String(value ?? '')).length;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function formatPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits ? `+${digits}` : 'recipient';
}

class OtmEngine {
  constructor() {
    this.sender = null;
    this.jobs = [];
    this.idempotency = {};
    this._timer = null;
    this._busy = false;
    this._load();
  }

  keyInfo() {
    for (const name of KEY_ENVS) {
      const value = String(process.env[name] || '').trim();
      if (!value) continue;
      if (value.length < MIN_KEY_CHARS) return { configured: false, source: name, reason: 'too_short', key: null };
      return { configured: true, source: name, reason: null, key: value };
    }
    return { configured: false, source: null, reason: 'missing', key: null };
  }

  isConfigured() {
    return this.keyInfo().configured;
  }

  verifyKey(supplied) {
    const info = this.keyInfo();
    if (!info.configured) {
      return {
        ok: false,
        status: 503,
        code: 'otm_not_configured',
        message: info.reason === 'too_short'
          ? `The OTM key is too short. Set ${info.source} to at least ${MIN_KEY_CHARS} characters.`
          : 'The OTM API is not configured. Set MONTRA_OTM_KEY in .env first.'
      };
    }
    const value = String(supplied || '').trim();
    if (!value) {
      return { ok: false, status: 401, code: 'missing_key', message: 'The OTM key is missing. Add X-OTM-Key, ?key=, or a JSON key field.' };
    }
    if (!crypto.timingSafeEqual(sha256(value), sha256(info.key))) {
      return { ok: false, status: 401, code: 'invalid_key', message: 'The OTM key is not valid.' };
    }
    return { ok: true };
  }

  helpText() {
    return [
      'Montra OTM API — send one WhatsApp message per request (instant or scheduled).',
      '',
      'Link (GET):',
      '  /api/otm?key=YOUR_OTM_KEY&to=254712345678&message=Hello%20{name}',
      '  Add &scheduleAt=+30m to schedule it instead of sending now.',
      '',
      'JSON (POST):',
      '  POST /api/otm',
      '  Content-Type: application/json',
      '  X-OTM-Key: YOUR_OTM_KEY',
      '  {',
      '    "to": "254712345678",',
      '    "message": "Hi {name}, your code is {code}.",',
      '    "vars": { "code": "A1B2" },',
      '    "scheduleAt": "2026-10-28T09:00:00Z"',
      '  }',
      '',
      `Limit: ${MAX_MESSAGE_CHARS} characters after variable substitution.`,
      'Variables: {name} {phone} {jid} {time} {date} {day} {timestamp} plus any vars you pass.',
      'to: phone number (7–15 digits) or a WhatsApp chat/group JID. Channels and broadcast lists are receive-only.',
      'scheduleAt: ISO date/time, HH:MM, or +30m / +2h / +1d. Wall-clock times use the configured MONTRA_TIMEZONE. Omit it to send now.',
      'idempotencyKey: optional; replaying the same key within 24 hours returns the original result.',
      'Send X-OTM-Key as a header and use HTTPS when the endpoint is reachable beyond localhost.'
    ].join('\n');
  }

  status() {
    const info = this.keyInfo();
    const now = Date.now();
    return {
      ok: true,
      configured: info.configured,
      keySource: info.source,
      keyReason: info.reason,
      endpoint: '/api/otm',
      maxMessageChars: MAX_MESSAGE_CHARS,
      scheduling: true,
      idempotencyTtlHours: 24,
      pending: this.jobs.filter(job => job.status === 'pending' && Number(job.scheduledAt) > now).length,
      totalJobs: this.jobs.length,
      senderReady: typeof this.sender === 'function',
      timeZone: timeEngine.describe().zoneLabel,
      timeShiftMinutes: timeEngine.getConfig().shiftMinutes,
      help: this.helpText()
    };
  }

  normalizeTarget(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, code: 'missing_recipient', message: 'Add a recipient in "to" (phone number or WhatsApp JID).' };
    let jid;
    if (raw.includes('@')) {
      jid = raw.toLowerCase();
      const user = /^[0-9]+@s\.whatsapp\.net$/.test(jid);
      const group = /^[0-9-]+@g\.us$/.test(jid);
      if (!user && !group) {
        return { ok: false, code: 'invalid_recipient', message: 'Use a phone number or a @s.whatsapp.net / @g.us JID. Channels and broadcast lists cannot receive messages.' };
      }
    } else {
      const digits = raw.replace(/[^0-9]/g, '');
      if (digits.length < 7 || digits.length > 15) {
        return { ok: false, code: 'invalid_recipient', message: 'The recipient phone number must contain 7–15 digits with the country code.' };
      }
      jid = `${digits}@s.whatsapp.net`;
    }
    const phone = jid.split('@')[0].replace(/\D/g, '');
    return { ok: true, jid, phone, isGroup: jid.endsWith('@g.us') };
  }

  cleanVars(input) {
    if (input === undefined || input === null || input === '') return { ok: true, vars: {} };
    let source = input;
    if (typeof source === 'string') {
      try { source = JSON.parse(source); }
      catch { return { ok: false, code: 'invalid_vars', message: 'vars must be a JSON object, for example {"name":"Alex"}. Use URL-encoding in a link.' }; }
    }
    if (typeof source !== 'object' || Array.isArray(source)) {
      return { ok: false, code: 'invalid_vars', message: 'vars must be a JSON object.' };
    }
    const entries = Object.entries(source);
    if (entries.length > MAX_VARS) {
      return { ok: false, code: 'too_many_vars', message: `Use at most ${MAX_VARS} variables.` };
    }
    const vars = {};
    for (const [key, value] of entries) {
      if (!/^[A-Za-z0-9_]{1,40}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        return { ok: false, code: 'invalid_vars', message: `Variable names must be 1–40 letters, digits or underscores: "${String(key).slice(0, 40)}".` };
      }
      if (value === null || value === undefined) { vars[key] = ''; continue; }
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        return { ok: false, code: 'invalid_vars', message: `Variable "${key}" must be text, a number or a boolean.` };
      }
      vars[key] = String(value).slice(0, MAX_VAR_CHARS);
    }
    return { ok: true, vars };
  }

  validateMessage(template) {
    const value = String(template || '').trim();
    if (!value) return { ok: false, code: 'missing_message', message: 'Add a "message" (or "text") to send.' };
    const length = charLength(value);
    if (length > MAX_MESSAGE_CHARS) {
      return { ok: false, code: 'message_too_long', message: `The message is ${length} characters; the limit is ${MAX_MESSAGE_CHARS}.` };
    }
    return { ok: true, template: value };
  }

  resolveVars(jid, phone, custom = {}, at = Date.now()) {
    const contact = syncStore.getContacts()[jid] || {};
    const chat = syncStore.getChats().find(row => (row.id || row.jid) === jid) || {};
    const contactName = String(contact.name || contact.notify || '').trim();
    const chatName = String(chat.name || chat.subject || '').trim();
    const isGroup = String(jid).endsWith('@g.us');
    const name = (isGroup ? (chatName || contactName) : (contactName || chatName)) || formatPhone(phone);
    const atEpoch = Number(at) || Date.now();
    return {
      name,
      phone: String(phone || jid.split('@')[0]).replace(/\D/g, ''),
      jid,
      time: timeEngine.timeOfDay(atEpoch),
      date: timeEngine.format(atEpoch, { dateStyle: 'medium' }),
      day: timeEngine.weekday(atEpoch),
      timestamp: String(atEpoch),
      iso: new Date(atEpoch).toISOString(),
      ...custom
    };
  }

  renderTemplate(template, vars) {
    return String(template || '').replace(/\{([A-Za-z0-9_]{1,40})\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
  }

  findIdempotency(key) {
    if (!key) return null;
    const entry = this.idempotency[key];
    if (!entry) return null;
    if (Date.now() - Number(entry.at || 0) > IDEMPOTENCY_TTL_MS) {
      delete this.idempotency[key];
      this.save();
      return null;
    }
    return entry;
  }

  rememberIdempotency(key, response) {
    if (!key) return;
    this.idempotency[key] = { at: Date.now(), response };
    const entries = Object.entries(this.idempotency).sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0));
    this.idempotency = Object.fromEntries(entries.slice(0, MAX_IDEMPOTENCY));
    this.save();
  }

  prepare(input = {}) {
    const target = this.normalizeTarget(input.to);
    if (!target.ok) return target;
    const message = this.validateMessage(input.template);
    if (!message.ok) return message;
    const vars = this.cleanVars(input.vars);
    if (!vars.ok) return vars;
    return { ok: true, ...target, template: message.template, vars: vars.vars };
  }

  async _sendJob(job) {
    if (typeof this.sender !== 'function') {
      return { ok: false, code: 'sender_unavailable', message: 'WhatsApp sending is not available in this process.', retryable: true };
    }
    let rendered;
    try {
      rendered = this.renderTemplate(job.template, this.resolveVars(job.jid, job.phone, job.vars, Date.now()));
      const length = charLength(rendered);
      if (!rendered.trim()) return { ok: false, code: 'empty_message', message: 'Message is empty after variable substitution.', retryable: false };
      if (length > MAX_MESSAGE_CHARS) {
        return { ok: false, code: 'message_too_long', message: `The rendered message is ${length} characters; the limit is ${MAX_MESSAGE_CHARS}.`, retryable: false };
      }
    } catch (e) {
      return { ok: false, code: 'render_failed', message: e.message || 'Could not render the message.', retryable: false };
    }

    try {
      const antiBan = require('./antiBanEngine');
      const safety = antiBan.checkCanSend(job.jid, job.isGroup, true);
      if (safety && safety.allowed === false) {
        return {
          ok: false,
          code: safety.retryAfterMs ? 'cooldown' : 'rate_limited',
          message: safety.reason || 'Global cooldown is active. Try again shortly.',
          retryAfterMs: safety.retryAfterMs || 0,
          retryable: true
        };
      }
    } catch { /* anti-ban is best-effort; the send path checks again */ }

    let result;
    try { result = await this.sender(job.jid, rendered); }
    catch (e) { result = { ok: false, error: e.message }; }

    if (result && result.ok) {
      job.status = 'sent';
      job.sentAt = Date.now();
      job.renderedMessage = rendered;
      job.messageId = String(result.out?.key?.id || '');
      job.lastError = null;
      job.attempts = Number(job.attempts || 0) + 1;
      this._audit('otm_send', { id: job.id, jid: job.jid, length: charLength(rendered), messageId: job.messageId });
      return { ok: true, rendered, length: charLength(rendered), messageId: job.messageId };
    }

    const error = String(result?.error || 'WhatsApp send failed.');
    job.attempts = Number(job.attempts || 0) + 1;
    job.lastError = error;
    this._audit('otm_send_error', { id: job.id, jid: job.jid, error, attempts: job.attempts });
    return {
      ok: false,
      code: 'send_failed',
      message: error,
      retryable: /not connected|anti-ban|rate|cooldown|try again|timeout|timed out|temporar|503|429/i.test(error)
    };
  }

  async sendNow(prepared) {
    const job = {
      id: `otm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      createdAt: Date.now(),
      scheduledAt: null,
      status: 'sending',
      to: prepared.jid.split('@')[0],
      phone: prepared.phone,
      jid: prepared.jid,
      isGroup: prepared.isGroup,
      template: prepared.template,
      vars: prepared.vars,
      attempts: 0,
      lastError: null,
      sentAt: null,
      messageId: '',
      renderedMessage: ''
    };
    this.jobs.push(job);
    const result = await this._sendJob(job);
    if (!result.ok) job.status = 'failed';
    this.save();

    if (!result.ok) {
      const clientError = ['message_too_long', 'empty_message', 'render_failed'].includes(result.code);
      return {
        status: result.code === 'rate_limited' || result.code === 'cooldown' ? 429 : (clientError ? 400 : (result.code === 'sender_unavailable' ? 503 : 502)),
        json: {
          ok: false,
          returnValue: 1,
          code: result.code || 'send_failed',
          status: 'failed',
          id: job.id,
          message: result.message || 'Message could not be sent.',
          error: result.message || 'Message could not be sent.',
          to: job.phone,
          jid: job.jid,
          retryAfterMs: result.retryAfterMs || 0,
          attempts: job.attempts
        }
      };
    }

    return {
      status: 200,
      json: {
        ok: true,
        returnValue: 0,
        code: 'sent',
        status: 'sent',
        id: job.id,
        message: `Message sent to ${formatPhone(job.phone)}.`,
        to: job.phone,
        jid: job.jid,
        length: result.length,
        messageId: result.messageId || '',
        sentAt: new Date(job.sentAt).toISOString()
      }
    };
  }

  schedule(prepared, scheduledAt) {
    const job = {
      id: `otm-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      createdAt: Date.now(),
      scheduledAt: Number(scheduledAt),
      status: 'pending',
      to: prepared.jid.split('@')[0],
      phone: prepared.phone,
      jid: prepared.jid,
      isGroup: prepared.isGroup,
      template: prepared.template,
      vars: prepared.vars,
      attempts: 0,
      lastError: null,
      sentAt: null,
      messageId: '',
      renderedMessage: ''
    };
    this.jobs.push(job);
    this.save();
    this._audit('otm_schedule', { id: job.id, jid: job.jid, scheduledAt: job.scheduledAt });
    return {
      status: 200,
      json: {
        ok: true,
        returnValue: 0,
        code: 'scheduled',
        status: 'scheduled',
        id: job.id,
        message: `Message scheduled for ${timeEngine.format(job.scheduledAt, { dateStyle: 'medium', timeStyle: 'short' })} (${new Date(job.scheduledAt).toISOString()}).`,
        to: job.phone,
        jid: job.jid,
        scheduledAt: job.scheduledAt,
        scheduledAtIso: new Date(job.scheduledAt).toISOString(),
        maxMessageChars: MAX_MESSAGE_CHARS
      }
    };
  }

  async processDue() {
    if (this._busy || typeof this.sender !== 'function') return { processed: 0 };
    this._busy = true;
    let processed = 0;
    try {
      const now = Date.now();
      const due = this.jobs.filter(job => job.status === 'pending' && Number(job.scheduledAt) > 0 && Number(job.scheduledAt) <= now);
      for (const job of due) {
        processed++;
        const result = await this._sendJob(job);
        if (result.ok) {
          job.status = 'sent';
        } else if (result.retryable && Number(job.attempts || 0) < MAX_ATTEMPTS) {
          job.status = 'pending';
          job.scheduledAt = Date.now() + RETRY_DELAY_MS;
          job.lastError = `${result.message || 'send failed'} (retry ${job.attempts}/${MAX_ATTEMPTS})`;
        } else {
          job.status = 'failed';
        }
      }
      if (processed) this.save();
    } finally {
      this._busy = false;
    }
    return { processed };
  }

  async execute({ method = 'GET', query = {}, body = null, key = '' } = {}) {
    const verb = String(method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(verb)) {
      return this._fail(405, 'method_not_allowed', 'Use GET with query parameters or POST with JSON.');
    }
    const auth = this.verifyKey(key);
    if (!auth.ok) return this._fail(auth.status, auth.code, auth.message);

    const params = verb === 'GET' ? (query || {}) : (body || {});
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return this._fail(400, 'invalid_request', 'Send a JSON object in the request body.');
    }

    const to = firstString(params.to, params.phone, params.recipient);
    const template = firstString(params.message, params.text);
    const when = firstString(params.scheduleAt, params.when, params.schedule);
    const idempotencyKey = firstString(params.idempotencyKey, params.id);
    if (!to || !template) {
      return this._fail(400, 'invalid_syntax', 'Both "to" and "message" are required. Use ?to=...&message=... or the JSON form.');
    }
    if (idempotencyKey && (charLength(idempotencyKey) > MAX_IDEMPOTENCY_CHARS || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey))) {
      return this._fail(400, 'invalid_idempotency_key', `idempotencyKey must be 1–${MAX_IDEMPOTENCY_CHARS} letters, digits, dots, colons, underscores or hyphens.`);
    }

    const prepared = this.prepare({ to, template, vars: params.vars ?? params.variables });
    if (!prepared.ok) return this._fail(400, prepared.code, prepared.message);

    const prior = this.findIdempotency(idempotencyKey);
    if (prior) {
      return { status: 200, json: { ...prior.response, duplicate: true, message: `Already processed: ${prior.response.message}` } };
    }

    let result;
    if (when && !/^(now|instant|immediate)$/i.test(when)) {
      const scheduledAt = parseScheduleTime(when);
      if (!scheduledAt) return this._fail(400, 'invalid_schedule', 'Use an ISO date/time, HH:MM, or +30m / +2h / +1d for scheduleAt.');
      if (scheduledAt <= Date.now() + 1000) return this._fail(400, 'schedule_in_past', 'scheduleAt must be in the future. Omit it to send immediately.');
      result = this.schedule(prepared, scheduledAt);
    } else {
      result = await this.sendNow(prepared);
    }

    if (idempotencyKey && result.json?.ok) this.rememberIdempotency(idempotencyKey, result.json);
    return result;
  }

  formatText(result) {
    const body = result?.json || {};
    const lines = [String(body.message || (body.ok ? 'OK' : 'Request failed'))];
    if (body.code && body.code !== 'sent' && body.code !== 'scheduled') lines.push(`Code: ${body.code}`);
    if (body.id) lines.push(`ID: ${body.id}`);
    if (body.help && !body.ok) lines.push('', body.help);
    return lines.join('\n');
  }

  _fail(status, code, message, extra = {}) {
    return {
      status,
      json: {
        ok: false,
        returnValue: 1,
        code,
        message,
        help: this.helpText(),
        ...extra
      }
    };
  }

  _load() {
    try {
      if (!fs.existsSync(JOBS_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8').replace(/^\uFEFF/, ''));
      const jobs = Array.isArray(raw) ? raw : (Array.isArray(raw?.jobs) ? raw.jobs : []);
      this.jobs = jobs.filter(job => job && typeof job === 'object').slice(-MAX_JOBS).map(job => {
        // A send interrupted by a restart has an unknown outcome. Failing it avoids
        // silently sending the same one-time message twice.
        if (job.status === 'sending') {
          return { ...job, status: 'failed', lastError: 'Interrupted by a restart; not retried automatically.' };
        }
        return job;
      });
      this.idempotency = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.idempotency && typeof raw.idempotency === 'object'
        ? raw.idempotency
        : {};
    } catch (e) {
      console.warn('[OTM] Could not load otmJobs.json:', e.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
      const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
      const entries = Object.entries(this.idempotency).filter(([, entry]) => Number(entry?.at || 0) > cutoff);
      this.idempotency = Object.fromEntries(entries.sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0)).slice(0, MAX_IDEMPOTENCY));
      this.jobs = this.jobs.slice(-MAX_JOBS);
      const temp = `${JOBS_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ jobs: this.jobs, idempotency: this.idempotency }, null, 2), { mode: 0o600 });
      fs.renameSync(temp, JOBS_FILE);
    } catch (e) {
      console.error('[OTM] Could not save otmJobs.json:', e.message);
    }
  }

  _audit(action, detail = {}) {
    try {
      fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
      fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), action, ...detail }) + '\n');
    } catch (e) {
      console.error('[OTM] audit write failed:', e.message);
    }
  }

  start(sender = null) {
    if (typeof sender === 'function') this.sender = sender;
    if (this._timer) return this;
    this._timer = setInterval(() => { this.processDue().catch(e => console.error('[OTM] scheduler error:', e.message)); }, POLL_MS);
    this._timer.unref?.();
    const kick = setTimeout(() => { this.processDue().catch(e => console.error('[OTM] scheduler error:', e.message)); }, 1500);
    kick.unref?.();
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = new OtmEngine();

'use strict';
/**
 * Google Workspace OAuth Token Auto-Refresh & Scope Configuration Manager
 * - Monitors active in-memory OAuth token TTL every 10 seconds
 * - Automatically triggers token refresh when countdown reaches <= 5 minutes (300s)
 * - Uses server-side OAuth refresh_token if configured via process.env, otherwise emits
 *   an immediate refresh signal to the browser Firebase Auth session
 * - Strictly keeps OAuth access tokens in memory only (never written to disk)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(ROOT_DIR, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'workspaceMonitorConfig.json');

const DEFAULT_REFRESH_THRESHOLD_SEC = 300; // 5 minutes
const POLL_INTERVAL_MS = 10000;
const MAX_HISTORY = 30;
const BASE_IDENTITY_SCOPES = ['openid', 'email', 'profile'];

const SERVICE_SCOPE_CATALOG = {
  drive: {
    id: 'drive',
    label: 'Google Drive',
    minimal: [
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/drive.file'
    ],
    standard: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.metadata.readonly'
    ],
    full: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/drive.activity',
      'https://www.googleapis.com/auth/drive.activity.readonly',
      'https://www.googleapis.com/auth/drive.appdata',
      'https://www.googleapis.com/auth/drive.apps.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.install',
      'https://www.googleapis.com/auth/drive.meet.readonly',
      'https://www.googleapis.com/auth/drive.metadata',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/drive.photos.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.scripts'
    ]
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    minimal: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.metadata'
    ],
    standard: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.labels'
    ],
    full: [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/gmail.addons.current.action.compose',
      'https://www.googleapis.com/auth/gmail.addons.current.message.action',
      'https://www.googleapis.com/auth/gmail.addons.current.message.metadata',
      'https://www.googleapis.com/auth/gmail.addons.current.message.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/gmail.insert',
      'https://www.googleapis.com/auth/gmail.labels',
      'https://www.googleapis.com/auth/gmail.metadata',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'https://www.googleapis.com/auth/gmail.settings.sharing'
    ]
  },
  contacts: {
    id: 'contacts',
    label: 'Google Contacts',
    minimal: [
      'https://www.googleapis.com/auth/contacts.readonly'
    ],
    standard: [
      'https://www.googleapis.com/auth/contacts',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/user.emails.read'
    ],
    full: [
      'https://www.googleapis.com/auth/contacts',
      'https://www.googleapis.com/auth/contacts.other.readonly',
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
      'https://www.googleapis.com/auth/user.addresses.read',
      'https://www.googleapis.com/auth/user.birthday.read',
      'https://www.googleapis.com/auth/user.emails.read',
      'https://www.googleapis.com/auth/user.gender.read',
      'https://www.googleapis.com/auth/user.organization.read',
      'https://www.googleapis.com/auth/user.phonenumbers.read'
    ]
  },
  calendar: {
    id: 'calendar',
    label: 'Google Calendar',
    minimal: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly'
    ],
    standard: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly'
    ],
    full: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.acls',
      'https://www.googleapis.com/auth/calendar.acls.readonly',
      'https://www.googleapis.com/auth/calendar.app.created',
      'https://www.googleapis.com/auth/calendar.calendarlist',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.calendars',
      'https://www.googleapis.com/auth/calendar.calendars.readonly',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events.owned',
      'https://www.googleapis.com/auth/calendar.events.owned.readonly',
      'https://www.googleapis.com/auth/calendar.events.public.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.settings.readonly'
    ]
  },
  tasks: {
    id: 'tasks',
    label: 'Google Tasks',
    minimal: [
      'https://www.googleapis.com/auth/tasks.readonly'
    ],
    standard: [
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/tasks.readonly'
    ],
    full: [
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/tasks.readonly'
    ]
  },
  chat: {
    id: 'chat',
    label: 'Google Chat',
    minimal: [
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'https://www.googleapis.com/auth/chat.messages.readonly'
    ],
    standard: [
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/chat.messages.create',
      'https://www.googleapis.com/auth/chat.messages.readonly'
    ],
    full: [
      'https://www.googleapis.com/auth/chat.admin.delete',
      'https://www.googleapis.com/auth/chat.admin.memberships',
      'https://www.googleapis.com/auth/chat.admin.memberships.readonly',
      'https://www.googleapis.com/auth/chat.admin.spaces',
      'https://www.googleapis.com/auth/chat.admin.spaces.readonly',
      'https://www.googleapis.com/auth/chat.customemojis',
      'https://www.googleapis.com/auth/chat.customemojis.readonly',
      'https://www.googleapis.com/auth/chat.delete',
      'https://www.googleapis.com/auth/chat.memberships',
      'https://www.googleapis.com/auth/chat.memberships.readonly',
      'https://www.googleapis.com/auth/chat.messages',
      'https://www.googleapis.com/auth/chat.messages.create',
      'https://www.googleapis.com/auth/chat.messages.reactions',
      'https://www.googleapis.com/auth/chat.messages.reactions.create',
      'https://www.googleapis.com/auth/chat.messages.reactions.readonly',
      'https://www.googleapis.com/auth/chat.messages.readonly',
      'https://www.googleapis.com/auth/chat.spaces',
      'https://www.googleapis.com/auth/chat.spaces.create',
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'https://www.googleapis.com/auth/chat.users.readstate',
      'https://www.googleapis.com/auth/chat.users.readstate.readonly',
      'https://www.googleapis.com/auth/chat.users.sections',
      'https://www.googleapis.com/auth/chat.users.sections.readonly',
      'https://www.googleapis.com/auth/chat.users.spacesettings'
    ]
  }
};

const VALID_SCOPE_RE = /^(openid|email|profile|https:\/\/mail\.google\.com\/|https:\/\/www\.googleapis\.com\/auth\/[a-zA-Z0-9._-]+)$/;

function isValidGoogleScope(scope) {
  return typeof scope === 'string' && scope.length <= 200 && VALID_SCOPE_RE.test(scope.trim());
}

function defaultScopeOverrides() {
  const out = {};
  for (const [id, spec] of Object.entries(SERVICE_SCOPE_CATALOG)) {
    out[id] = {
      profile: 'full',
      includeInAuth: true,
      scopes: [...spec.full]
    };
  }
  return out;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

class WorkspaceTokenManager {
  constructor() {
    this.timer = null;
    this.onRefreshNeeded = null;
    this.fetchImpl = null;
    // Strictly in-memory token state — never saved to disk.
    this.session = {
      activeToken: '',
      tokenFingerprint: '',
      uid: '',
      email: '',
      issuedAtMs: 0,
      expiresAtMs: 0,
      maxTtlSec: 3600,
      scopeCount: 0,
      services: {},
      status: 'none', // none | valid | expiring_soon | refresh_due | refreshing | refreshed | expired | error
      triggeredForCurrentToken: false,
      refreshing: false,
      refreshCount: 0,
      lastRefreshTriggeredAt: null,
      lastRefreshResult: '',
      pendingClientRefresh: null,
      history: []
    };
    this.config = this.loadConfig();
  }

  loadConfig() {
    const defaults = {
      autoRefreshEnabled: true,
      thresholdSec: DEFAULT_REFRESH_THRESHOLD_SEC,
      scopeConfigs: defaultScopeOverrides()
    };
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const thresholdSec = Math.max(60, Math.min(1800, Number(raw.thresholdSec) || DEFAULT_REFRESH_THRESHOLD_SEC));
      const scopeConfigs = defaultScopeOverrides();
      if (raw.scopeConfigs && typeof raw.scopeConfigs === 'object') {
        for (const id of Object.keys(SERVICE_SCOPE_CATALOG)) {
          const item = raw.scopeConfigs[id];
          if (!item || typeof item !== 'object') continue;
          const validScopes = Array.isArray(item.scopes)
            ? [...new Set(item.scopes.map(s => String(s || '').trim()).filter(isValidGoogleScope))].slice(0, 35)
            : [];
          if (validScopes.length > 0) {
            scopeConfigs[id] = {
              profile: ['minimal', 'standard', 'full', 'custom'].includes(item.profile) ? item.profile : 'custom',
              includeInAuth: typeof item.includeInAuth === 'boolean' ? item.includeInAuth : true,
              scopes: validScopes
            };
          }
        }
      }
      return {
        autoRefreshEnabled: typeof raw.autoRefreshEnabled === 'boolean' ? raw.autoRefreshEnabled : defaults.autoRefreshEnabled,
        thresholdSec,
        scopeConfigs
      };
    } catch {
      return defaults;
    }
  }

  saveConfig() {
    try {
      writeJsonAtomic(CONFIG_FILE, {
        autoRefreshEnabled: this.config.autoRefreshEnabled,
        thresholdSec: this.config.thresholdSec,
        scopeConfigs: this.config.scopeConfigs,
        updatedAt: new Date().toISOString()
      });
    } catch { /* ignore in ephemeral environments */ }
  }

  pushHistory(event, detail = '') {
    this.session.history.unshift({
      id: `tok-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
      ts: new Date().toISOString(),
      event: String(event || 'info'),
      detail: String(detail || '').slice(0, 240)
    });
    if (this.session.history.length > MAX_HISTORY) {
      this.session.history.length = MAX_HISTORY;
    }
  }

  hasServerRefreshCredentials() {
    return Boolean(
      process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
    );
  }

  start({ onRefreshNeeded, fetchImpl } = {}) {
    if (typeof onRefreshNeeded === 'function') this.onRefreshNeeded = onRefreshNeeded;
    if (typeof fetchImpl === 'function') this.fetchImpl = fetchImpl;
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.evaluateLifecycle().catch(() => {});
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  registerToken({ token = '', expiresIn = 3600, expiresAtMs = 0, scopeCount = 0, services = {}, email = '', uid = '', source = 'client' } = {}, nowMs = Date.now()) {
    const cleanToken = String(token || '').trim();
    if (!cleanToken) {
      this.clearToken('empty_token');
      return this.getStatus(nowMs);
    }
    const fingerprint = crypto.createHash('sha256').update(cleanToken).digest('hex').slice(0, 12);
    const isNewToken = fingerprint !== this.session.tokenFingerprint;
    const ttlSec = Math.max(0, Math.floor(Number(expiresIn) || 0));
    const resolvedExpiresAtMs = Number(expiresAtMs) > 0
      ? Number(expiresAtMs)
      : (ttlSec > 0 ? nowMs + ttlSec * 1000 : nowMs + 3600 * 1000);
    const remainingSec = Math.max(0, Math.floor((resolvedExpiresAtMs - nowMs) / 1000));

    this.session.activeToken = cleanToken;
    this.session.tokenFingerprint = fingerprint;
    if (uid) this.session.uid = String(uid).slice(0, 128);
    if (email) this.session.email = String(email).slice(0, 254);
    if (isNewToken || !this.session.issuedAtMs) this.session.issuedAtMs = nowMs;
    this.session.expiresAtMs = resolvedExpiresAtMs;
    this.session.maxTtlSec = Math.max(remainingSec || 3600, ttlSec || 3600);
    this.session.scopeCount = Number(scopeCount) || this.session.scopeCount || 0;
    if (services && typeof services === 'object') this.session.services = { ...services };

    if (isNewToken) {
      this.session.triggeredForCurrentToken = false;
      this.session.pendingClientRefresh = null;
      this.session.status = remainingSec <= 0
        ? 'expired'
        : (remainingSec <= this.config.thresholdSec ? 'expiring_soon' : 'valid');
      this.pushHistory('token_registered', `Registered ${source} token (TTL ${remainingSec}s, scopes ${this.session.scopeCount})`);
    } else if (remainingSec > this.config.thresholdSec) {
      this.session.status = 'valid';
    }
    return this.getStatus(nowMs);
  }

  clearToken(reason = 'signed_out') {
    if (this.session.activeToken || this.session.tokenFingerprint) {
      this.pushHistory('token_cleared', `Cleared in-memory token (${reason})`);
    }
    this.session.activeToken = '';
    this.session.tokenFingerprint = '';
    this.session.uid = '';
    this.session.email = '';
    this.session.issuedAtMs = 0;
    this.session.expiresAtMs = 0;
    this.session.scopeCount = 0;
    this.session.services = {};
    this.session.status = 'none';
    this.session.triggeredForCurrentToken = false;
    this.session.refreshing = false;
    this.session.pendingClientRefresh = null;
  }

  async evaluateLifecycle(nowMs = Date.now(), { fetchImpl } = {}) {
    if (!this.session.activeToken || !this.session.expiresAtMs) {
      return { triggered: false, reason: 'no_active_token', status: this.getStatus(nowMs) };
    }
    const remainingSec = Math.max(0, Math.floor((this.session.expiresAtMs - nowMs) / 1000));
    if (remainingSec <= 0 && this.session.status !== 'refresh_due' && this.session.status !== 'refreshing') {
      this.session.status = 'expired';
    } else if (remainingSec > 0 && remainingSec <= this.config.thresholdSec && this.session.status === 'valid') {
      this.session.status = 'expiring_soon';
    }

    if (
      this.config.autoRefreshEnabled &&
      !this.session.triggeredForCurrentToken &&
      !this.session.refreshing &&
      remainingSec <= this.config.thresholdSec
    ) {
      const reason = remainingSec <= 0
        ? 'token_expired_recovery'
        : `countdown_reached_${this.config.thresholdSec}s_threshold`;
      const refreshResult = await this.triggerAutoRefresh(reason, { nowMs, fetchImpl });
      return { triggered: true, refreshResult, status: this.getStatus(nowMs) };
    }

    return { triggered: false, remainingSec, status: this.getStatus(nowMs) };
  }

  async triggerAutoRefresh(reason = 'manual', { nowMs = Date.now(), fetchImpl } = {}) {
    if (this.session.refreshing) {
      return { ok: false, skipped: true, reason: 'refresh_already_in_progress', status: this.getStatus(nowMs) };
    }
    const doFetch = fetchImpl || this.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const remainingSec = this.session.expiresAtMs > 0
      ? Math.max(0, Math.floor((this.session.expiresAtMs - nowMs) / 1000))
      : 0;

    this.session.refreshing = true;
    this.session.triggeredForCurrentToken = true;
    this.session.lastRefreshTriggeredAt = new Date(nowMs).toISOString();
    this.session.refreshCount += 1;
    this.session.status = 'refreshing';

    try {
      if (this.hasServerRefreshCredentials() && doFetch) {
        const params = new URLSearchParams({
          client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
          refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
          grant_type: 'refresh_token'
        });
        const resp = await doFetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data.access_token) {
          this.session.status = 'error';
          this.session.lastRefreshResult = String(data.error_description || data.error || `HTTP ${resp.status}`);
          this.pushHistory('server_refresh_failed', this.session.lastRefreshResult);
          return { ok: false, mode: 'server_oauth_refresh', error: this.session.lastRefreshResult, status: this.getStatus(nowMs) };
        }
        const newTtl = Math.max(60, Number(data.expires_in) || 3600);
        this.registerToken({
          token: data.access_token,
          expiresIn: newTtl,
          scopeCount: this.session.scopeCount,
          services: this.session.services,
          email: this.session.email,
          uid: this.session.uid,
          source: 'server_refresh_token'
        }, nowMs);
        this.session.status = 'refreshed';
        this.session.lastRefreshResult = `Server-side token refresh succeeded (+${newTtl}s).`;
        this.pushHistory('server_refresh_succeeded', this.session.lastRefreshResult);
        return { ok: true, mode: 'server_oauth_refresh', expiresIn: newTtl, refreshedToken: data.access_token, status: this.getStatus(nowMs) };
      }

      // Firebase Client-Side Auth mode (preview-compatible, no client_secret on disk):
      // Issue an authoritative backend refresh trigger for the active browser session.
      const trigger = {
        id: `ref-${nowMs.toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
        triggeredAt: new Date(nowMs).toISOString(),
        remainingSec,
        thresholdSec: this.config.thresholdSec,
        reason: String(reason || 'threshold_300s'),
        mode: 'client_firebase_reauth',
        resolved: false
      };
      this.session.pendingClientRefresh = trigger;
      this.session.status = 'refresh_due';
      this.session.lastRefreshResult = `Backend triggered OAuth refresh at ${remainingSec}s remaining (${trigger.reason}).`;
      this.pushHistory('refresh_triggered', this.session.lastRefreshResult);
      if (typeof this.onRefreshNeeded === 'function') {
        try { await this.onRefreshNeeded(trigger, this.getStatus(nowMs)); } catch { /* ignore */ }
      }
      return { ok: true, mode: 'client_firebase_reauth', trigger, status: this.getStatus(nowMs) };
    } finally {
      this.session.refreshing = false;
    }
  }

  updateConfig(patch = {}) {
    if (typeof patch.autoRefreshEnabled === 'boolean') {
      this.config.autoRefreshEnabled = patch.autoRefreshEnabled;
    }
    if (patch.thresholdSec !== undefined) {
      const n = Number(patch.thresholdSec);
      if (!Number.isFinite(n) || n < 60 || n > 1800) {
        throw new Error('Refresh threshold must be between 60 and 1800 seconds.');
      }
      this.config.thresholdSec = Math.round(n);
    }
    if (patch.scopeConfigs && typeof patch.scopeConfigs === 'object') {
      for (const [serviceId, cfg] of Object.entries(patch.scopeConfigs)) {
        if (!SERVICE_SCOPE_CATALOG[serviceId] || !cfg || typeof cfg !== 'object') continue;
        const scopes = Array.isArray(cfg.scopes)
          ? [...new Set(cfg.scopes.map(s => String(s || '').trim()).filter(isValidGoogleScope))].slice(0, 35)
          : this.config.scopeConfigs[serviceId].scopes;
        if (!scopes.length) {
          throw new Error(`Select at least one valid Google API OAuth scope for ${serviceId}.`);
        }
        this.config.scopeConfigs[serviceId] = {
          profile: ['minimal', 'standard', 'full', 'custom'].includes(cfg.profile) ? cfg.profile : 'custom',
          includeInAuth: typeof cfg.includeInAuth === 'boolean' ? cfg.includeInAuth : this.config.scopeConfigs[serviceId].includeInAuth,
          scopes
        };
      }
      this.pushHistory('scope_config_updated', `Updated Firebase Auth OAuth scope configuration`);
    }
    this.saveConfig();
    return this.getStatus();
  }

  computeCombinedAuthScopes(enabledServicesMap = {}) {
    const out = new Set(BASE_IDENTITY_SCOPES);
    for (const [serviceId, cfg] of Object.entries(this.config.scopeConfigs)) {
      const enabled = enabledServicesMap[serviceId] !== false;
      if (enabled && cfg.includeInAuth) {
        for (const s of cfg.scopes) out.add(s);
      }
    }
    return [...out];
  }

  getStatus(nowMs = Date.now()) {
    const hasToken = Boolean(this.session.activeToken);
    const remainingSec = hasToken && this.session.expiresAtMs > 0
      ? Math.max(0, Math.floor((this.session.expiresAtMs - nowMs) / 1000))
      : 0;
    const refreshDue = hasToken && this.config.autoRefreshEnabled && remainingSec <= this.config.thresholdSec;
    return {
      hasToken,
      tokenFingerprint: this.session.tokenFingerprint,
      uid: this.session.uid,
      email: this.session.email,
      status: hasToken ? this.session.status : 'none',
      issuedAt: this.session.issuedAtMs ? new Date(this.session.issuedAtMs).toISOString() : null,
      expiresAt: this.session.expiresAtMs ? new Date(this.session.expiresAtMs).toISOString() : null,
      expiresAtMs: this.session.expiresAtMs,
      remainingSec,
      maxTtlSec: this.session.maxTtlSec,
      thresholdSec: this.config.thresholdSec,
      autoRefreshEnabled: this.config.autoRefreshEnabled,
      refreshDue,
      serverRefreshConfigured: this.hasServerRefreshCredentials(),
      refreshCount: this.session.refreshCount,
      lastRefreshTriggeredAt: this.session.lastRefreshTriggeredAt,
      lastRefreshResult: this.session.lastRefreshResult,
      pendingClientRefresh: this.session.pendingClientRefresh,
      scopeCount: this.session.scopeCount,
      services: this.session.services,
      scopeConfigs: this.config.scopeConfigs,
      scopeCatalog: SERVICE_SCOPE_CATALOG,
      history: this.session.history
    };
  }
}

module.exports = new WorkspaceTokenManager();
module.exports.WorkspaceTokenManager = WorkspaceTokenManager;
module.exports.SERVICE_SCOPE_CATALOG = SERVICE_SCOPE_CATALOG;
module.exports.DEFAULT_REFRESH_THRESHOLD_SEC = DEFAULT_REFRESH_THRESHOLD_SEC;
module.exports.isValidGoogleScope = isValidGoogleScope;

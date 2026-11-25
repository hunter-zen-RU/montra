/** Authenticated local dashboard: HTTP API + WhatsApp-Web-style UI (lib/dashboard.html). Bound to localhost by default. */
const http = require('http');
const crypto = require('crypto');
const syncStore = require('./syncStore');
const decoder = require('./messageDecoder');
const autoReply = require('./autoReplyEngine');
const mediaArchive = require('./mediaArchive');
const fs = require('fs');
const path = require('path');
const crmEngine = require('./crmEngine');
const analyzeEngine = require('./analyzeEngine');
const backupManager = require('./backupManager');
const aiAssistant = require('./aiAssistant');
const geminiResilient = require('./geminiResilient');
const statusScheduler = require('./statusScheduler');
const alertEngine = require('./alertEngine');
const securityEngine = require('./securityEngine');
const markdownEngine = require('./markdownEngine');
const otmEngine = require('./otmEngine');
const timeEngine = require('./timeEngine');
const antiBanEngine = require('./antiBanEngine');
const humanizerEngine = require('./humanizerEngine');
const systemMonitor = require('./systemMonitor');
const botEngine = require('./botEngine');
const workspaceTokenManager = require('./workspaceTokenManager');
const facebookBot = require('./facebookBot');
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
const settings = require('../settings');

function buildQrMatrix(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    const qr = new QRCode(-1, QRErrorCorrectLevel.L);
    qr.addData(value);
    qr.make();
    const size = qr.getModuleCount();
    const rows = [];
    for (let r = 0; r < size; r++) {
      let row = '';
      for (let c = 0; c < size; c++) row += qr.isDark(r, c) ? '1' : '0';
      rows.push(row);
    }
    return { size, rows };
  } catch {
    return null;
  }
}

const MAX_DASHBOARD_UPLOAD_BYTES = Math.min(mediaArchive.MAX_FILE_BYTES, 15 * 1024 * 1024);
const HTML_FILE = path.join(__dirname, 'dashboard.html');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const ROOT_DIR = path.join(__dirname, '..');
const FIREBASE_CONFIG_FILE = path.join(ROOT_DIR, 'firebase-applet-config.json');
// Only flat, lowercase .svg names from assets/ — no dots, slashes or traversal.
const ASSET_NAME = /^[a-z0-9][a-z0-9-]{0,40}\.svg$/;
const VENDOR_FILES = {
  'd3.min.js': { file: path.join(ROOT_DIR, 'node_modules', 'd3', 'dist', 'd3.min.js'), rewriteFirebaseImport: false },
  'firebase-app.js': { file: path.join(ROOT_DIR, 'node_modules', 'firebase', 'firebase-app.js'), rewriteFirebaseImport: false },
  'firebase-auth.js': { file: path.join(ROOT_DIR, 'node_modules', 'firebase', 'firebase-auth.js'), rewriteFirebaseImport: true },
  'firebase-firestore.js': { file: path.join(ROOT_DIR, 'node_modules', 'firebase', 'firebase-firestore.js'), rewriteFirebaseImport: true }
};
const vendorCache = new Map();
function readVendorBundle(name) {
  const spec = VENDOR_FILES[name];
  if (!spec) return null;
  if (vendorCache.has(name)) return vendorCache.get(name);
  let text = fs.readFileSync(spec.file, 'utf8');
  if (spec.rewriteFirebaseImport) {
    text = text.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[^/]+\/firebase-app\.js/g, '/vendor/firebase-app.js');
  }
  const buf = Buffer.from(text, 'utf8');
  vendorCache.set(name, buf);
  return buf;
}
function readFirebaseClientConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_FILE, 'utf8'));
    return {
      projectId: String(raw.projectId || ''),
      appId: String(raw.appId || ''),
      apiKey: String(raw.apiKey || ''),
      authDomain: String(raw.authDomain || ''),
      ...(raw.firestoreDatabaseId ? { firestoreDatabaseId: String(raw.firestoreDatabaseId) } : {}),
      storageBucket: String(raw.storageBucket || ''),
      messagingSenderId: String(raw.messagingSenderId || ''),
      oAuthClientId: String(raw.oAuthClientId || '')
    };
  } catch {
    return null;
  }
}
const PREFS_FILE = path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'dashboardPrefs.json');
const AVATAR_TTL_MS = 12 * 60 * 60 * 1000;
const AVATAR_MISS_TTL_MS = 60 * 60 * 1000;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const PINNED_CHAT_LIMIT = 3;

const readReceiptsSent = new Map();
const presenceCache = new Map();
const avatarCache = new Map();

// Insert into a cache Map and keep it bounded: the dashboard runs for weeks, so an entry
// per chat ever seen must not accumulate. The oldest key (never the fresh one) leaves.
function cacheSet(map, key, value, max) {
  map.set(key, value);
  if (map.size > max) {
    for (const oldest of map.keys()) { if (oldest !== key) { map.delete(oldest); break; } }
  }
  return value;
}
let server = null;
let htmlCache = { mtimeMs: 0, body: '' };

// ---------- dashboard-local preferences (pin/mute/archive/star/theme) ----------

function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { /* ignore */ }
  const arr = name => (Array.isArray(saved[name]) ? saved[name].filter(x => typeof x === 'string') : []);
  return {
    theme: saved.theme === 'light' ? 'light' : 'dark',
    pinned: arr('pinned'), muted: arr('muted'), archived: arr('archived'), unread: arr('unread'),
    starred: saved.starred && typeof saved.starred === 'object' ? saved.starred : {}
  };
}
let prefs = loadPrefs();
let prefsTimer = null;
function persistPrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
      const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, PREFS_FILE);
    } catch (e) { console.error('[Montra] Dashboard prefs save failed:', e.message); }
  }, 200);
  prefsTimer.unref?.();
}
function knownChat(jid) { return Boolean(jid) && syncStore.getChats().some(chat => (chat.id || chat.jid) === jid); }
function applyPrefs(body) {
  if (body.theme === 'dark' || body.theme === 'light') { prefs.theme = body.theme; return true; }
  const jid = String(body.jid || '');
  const id = String(body.id || '');
  if (!knownChat(jid)) return false;
  const remove = (list, value) => list.filter(x => x !== value);
  switch (String(body.action || '')) {
    case 'pin': prefs.pinned = [jid, ...remove(prefs.pinned, jid)].slice(0, PINNED_CHAT_LIMIT); return true;
    case 'unpin': prefs.pinned = remove(prefs.pinned, jid); return true;
    case 'mute': prefs.muted = [jid, ...remove(prefs.muted, jid)]; return true;
    case 'unmute': prefs.muted = remove(prefs.muted, jid); return true;
    case 'archive': prefs.archived = [jid, ...remove(prefs.archived, jid)]; return true;
    case 'unarchive': prefs.archived = remove(prefs.archived, jid); return true;
    case 'markUnread': prefs.unread = [jid, ...remove(prefs.unread, jid)]; return true;
    case 'markRead': prefs.unread = remove(prefs.unread, jid); return true;
    case 'star': if (!id) return false; prefs.starred[jid] = Array.from(new Set([...(prefs.starred[jid] || []), id])); return true;
    case 'unstar': {
      const rest = (prefs.starred[jid] || []).filter(x => x !== id);
      if (rest.length) prefs.starred[jid] = rest; else delete prefs.starred[jid];
      return true;
    }
    default: return false;
  }
}

// ---------- helpers ----------

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}
function sendJson(res, code, value) { return send(res, code, 'application/json; charset=utf-8', JSON.stringify(value)); }
function sendBuffer(res, buffer, mime, filename, maxAgeSeconds) {
  res.writeHead(200, {
    'Content-Type': mime || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Content-Disposition': `inline; filename="${String(filename || 'file').replace(/["\\\r\n]/g, '_')}"`,
    'Cache-Control': `private, max-age=${Number(maxAgeSeconds) || 0}`,
    'X-Content-Type-Options': 'nosniff'
  });
  return res.end(buffer);
}
function readHtml() {
  try {
    const mtimeMs = fs.statSync(HTML_FILE).mtimeMs;
    if (htmlCache.mtimeMs !== mtimeMs || !htmlCache.body) htmlCache = { mtimeMs, body: fs.readFileSync(HTML_FILE, 'utf8') };
  } catch (e) {
    htmlCache.body = htmlCache.body || `<!doctype html><meta charset="utf-8"><title>Montra</title><p>Dashboard UI file (lib/dashboard.html) is missing: ${String(e.message).replace(/[<>]/g, '')}`;
  }
  return htmlCache.body.replace(/\{\{VERSION\}\}/g, settings.version);
}
async function readBody(req, limit) {
  // Chunks arrive as arbitrary byte slices, so decoding each one on its own would turn any
  // multi-byte character that straddles a chunk boundary into replacement glyphs.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(part);
    size += part.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { code: 413 });
  }
  return Buffer.concat(chunks).toString('utf8');
}
// ---------- display names + profile pictures ----------
/* Baileys delivers bare JIDs in the chat list: group subjects and channel names
   arrive lazily, so unresolved entries are queried a few at a time and cached in
   the sync store. The dashboard never receives a raw JID as a display name. */
const CHAT_META_TTL_MS = 6 * 60 * 60 * 1000;
const CHAT_META_MISS_MS = 10 * 60 * 1000;
const CHAT_META_BATCH = 3;
const chatMeta = new Map(); // jid -> { at, name, picture }
const chatMetaPending = new Set();
let resolveChatMeta = null;

function usableName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  return name && !name.includes('@') ? name : '';
}
function prettyPhone(jid) {
  const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
  if (digits.length < 7) return '';
  return `+${digits.slice(0, digits.length - 9)} ${digits.slice(-9, -6)} ${digits.slice(-6, -3)} ${digits.slice(-3)}`.replace(/\s+/g, ' ').trim();
}
function chatKindOf(jid) { return syncStore.chatKind(jid); }
const SEND_TARGET_ERROR = 'Channels and broadcast lists cannot receive messages.';
// WhatsApp never accepts outbound messages to a newsletter or a broadcast list.
function sendableTarget(jid) { const kind = chatKindOf(jid); return kind !== 'channel' && kind !== 'broadcast'; }
function chatById(jid) {
  const key = String(jid || '');
  return syncStore.getChats().find(row => (row.id || row.jid) === key) || null;
}
function storedName(jid, chat, contacts) {
  const key = String(jid || '');
  const contact = contacts[key] || {};
  const cached = chatMeta.get(key);
  return usableName(chat?.name) || usableName(chat?.subject) || usableName(chat?.notify)
    || usableName(chat?.verifiedName) || usableName(contact.name) || usableName(contact.notify)
    || usableName(contact.verifiedName) || usableName(cached?.name) || '';
}
// Fallback labels keep the list readable while a name is still unknown.
function fallbackName(jid, kind, hint) {
  const usable = usableName(hint);
  if (usable) return usable;
  if (kind === 'group') return 'Group';
  if (kind === 'channel') return 'Channel';
  if (kind === 'broadcast') return 'Broadcast list';
  return prettyPhone(jid) || 'WhatsApp user';
}
function chatDisplayName(jid, chat, contacts, hint) {
  const kind = chatKindOf(jid);
  // A sender's push name only labels a 1:1 chat; naming a group or channel after
  // whoever posted last would be plain wrong.
  return storedName(jid, chat, contacts) || fallbackName(jid, kind, kind === 'chat' ? hint : '');
}
function pictureKnown(jid) {
  const cached = chatMeta.get(String(jid));
  return cached && typeof cached.picture === 'boolean' ? cached.picture : null;
}
function rememberChatMeta(jid, name, picture) {
  const key = String(jid);
  cacheSet(chatMeta, key, { at: Date.now(), name: usableName(name), picture: typeof picture === 'boolean' ? picture : null }, 1000);
  const patch = { id: key };
  if (name) patch.name = usableName(name);
  if (typeof picture === 'boolean') patch.hasPicture = picture;
  if (patch.name || 'hasPicture' in patch) syncStore.upsertChats([patch]);
}
function requestChatMeta(jids) {
  if (typeof resolveChatMeta !== 'function') return;
  const now = Date.now();
  let queued = 0;
  for (const jid of jids) {
    if (queued >= CHAT_META_BATCH) break;
    const key = String(jid);
    if (key === 'status@broadcast' || key.endsWith('@broadcast')) continue;
    const cached = chatMeta.get(key);
    const fresh = cached && now - cached.at < (cached.name ? CHAT_META_TTL_MS : CHAT_META_MISS_MS);
    if (fresh || chatMetaPending.has(key)) continue;
    chatMetaPending.add(key);
    queued += 1;
    setTimeout(() => {
      Promise.resolve()
        .then(() => resolveChatMeta(key))
        .then(meta => rememberChatMeta(key, meta?.name, meta?.picture))
        .catch(() => cacheSet(chatMeta, key, { at: Date.now(), name: '', picture: null }, 1000))
        .finally(() => chatMetaPending.delete(key));
    }, queued * 250);
  }
}
function senderLabel(message, contacts) {
  const participant = String(message?.key?.participant || '');
  // Only a person can be the sender; a group or channel JID would title the row after
  // the conversation itself, so fall back to the remote address only for 1:1 chats.
  const jid = participant || (["group", "channel", "broadcast"].includes(chatKindOf(message?.key?.remoteJid)) ? '' : String(message?.key?.remoteJid || ''));
  if (!jid) return usableName(message?.pushName) || '';
  // WhatsApp's own display name is last resort: the address book entry wins, like in the app.
  return storedName(jid, null, contacts) || usableName(message?.pushName) || '';
}
function personLabel(jid, contacts) {
  return storedName(jid, null, contacts) || prettyPhone(jid) || '';
}
// Flat, UI-ready message rows: quoted context, aggregated reactions and delete markers.
function messageRows(jid, rawMessages) {
  const contacts = syncStore.getContacts();
  const chat = chatById(jid);
  const kind = chatKindOf(jid);
  const channelName = kind === 'channel' ? chatDisplayName(jid, chat, contacts) : '';
  const reactions = new Map();
  const revoked = new Set();
  for (const m of rawMessages) {
    const { inner } = decoder.unwrapLayers(m.message || {});
    if (inner?.reactionMessage) {
      const target = String(inner.reactionMessage.key?.id || '');
      const emoji = String(inner.reactionMessage.text || '');
      if (target && emoji) {
        const reactorJid = String(m.key?.participant || m.key?.remoteJid || '');
        if (!reactions.has(target)) reactions.set(target, []);
        reactions.get(target).push({ emoji, by: m.key?.fromMe ? 'You' : senderLabel(m, contacts) || personLabel(reactorJid, contacts) || 'someone', fromMe: Boolean(m.key?.fromMe) });
      }
    }
    if (inner?.protocolMessage?.type === 0) {
      const target = String(inner.protocolMessage.key?.id || '');
      if (target) revoked.add(target);
    }
  }
  const rows = [];
  for (const m of rawMessages.slice().reverse()) {
    const decoded = decoder.decode(m.message) || {};
    if (['reaction', 'revoke', 'edit'].includes(decoded.kind)) continue;
    const id = String(m.key?.id || '');
    const { inner } = decoder.unwrapLayers(m.message || {});
    const context = inner?.extendedTextMessage?.contextInfo || inner?.imageMessage?.contextInfo
      || inner?.videoMessage?.contextInfo || inner?.documentMessage?.contextInfo || null;
    let quoted = null;
    if (context?.quotedMessage) {
      const quotedDecoded = decoder.decode(context.quotedMessage);
      quoted = {
        id: String(context.stanzaId || ''),
        name: usableName(context.participantName) || personLabel(context.participant, contacts) || 'Original message',
        kind: String(quotedDecoded?.kind || 'message'),
        text: String((quotedDecoded && (quotedDecoded.text || decoder.describe(quotedDecoded))) || 'Original message')
      };
    }
    rows.push({
      id, fromMe: Boolean(m.key?.fromMe),
      sender: senderLabel(m, contacts) || channelName,
      participant: String(m.key?.participant || ''),
      timestamp: Number(m.messageTimestamp || 0),
      status: Number(m.status || 0),
      kind: String(decoded.kind || 'message'),
      text: String(decoded.text || ''),
      html: markdownEngine.render(decoded.text || ''),
      description: decoder.describe(decoded),
      fileName: String(decoded.fileName || ''),
      seconds: Number(decoded.seconds || 0),
      hasMedia: ['image', 'video', 'voice', 'sticker', 'document'].includes(decoded.kind) && Boolean(mediaArchive.getByKey(jid, id)),
      quoted, reactions: reactions.get(id) || [],
      deleted: revoked.has(id)
    });
  }
  return rows;
}

// ---------- server ----------

function start({ host = process.env.DASHBOARD_HOST || '0.0.0.0', port = Number(process.env.PORT || process.env.DASHBOARD_PORT || 3000), token = process.env.DASHBOARD_TOKEN || '', sendMessage = null, sendMedia = null, sendOtm = null, markRead = null, getConnection = () => ({ status: 'unknown' }), requestPairingCode = null, refreshQr = null, subscribePresence = null, setTyping = null, getProfile = null, updateProfile = null, updateProfilePicture = null, removeProfilePicture = null, getStatuses = () => [], postStatus = null, viewStatus = null, resolveStatusMedia = null, reactToMessage = null, deleteMessage = null, getAvatarUrl = null, getChatInfo = null, resolveChatMetaProvider = null } = {}) {
  if (server) return server;
  resolveChatMeta = typeof resolveChatMetaProvider === 'function' ? resolveChatMetaProvider : null;
  if (!token) { console.log('[Montra] DASHBOARD_TOKEN not set; starting dashboard in open preview mode.'); }
  systemMonitor.start();
  workspaceTokenManager.start();
  facebookBot.start();
  // Scheduled OTM jobs are drained by the engine even when the dashboard is not open.
  otmEngine.start(typeof sendOtm === 'function' ? sendOtm : null);
  // A throw anywhere below must still produce a response: an unhandled rejection inside an
  // async request listener leaves the socket open and the dashboard spinner turning forever.
  const route = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    // UI artwork (logo, default avatars) contains no account data, so it is served ahead of
    // the token check: favicons and <link> tags cannot carry one.
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/assets/')) {
      let name;
      // A malformed escape must fail closed, not throw before the token check.
      try { name = decodeURIComponent(url.pathname.slice('/assets/'.length)); } catch { name = ''; }
      if (!ASSET_NAME.test(name)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      try {
        const buffer = fs.readFileSync(path.join(ASSETS_DIR, name));
        return sendBuffer(res, buffer, 'image/svg+xml', name, 3600);
      } catch { return send(res, 404, 'text/plain; charset=utf-8', 'Not found'); }
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/vendor/')) {
      let name;
      try { name = decodeURIComponent(url.pathname.slice('/vendor/'.length)); } catch { name = ''; }
      if (!Object.prototype.hasOwnProperty.call(VENDOR_FILES, name)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      try {
        const buffer = readVendorBundle(name);
        if (!buffer) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': buffer.length,
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(req.method === 'HEAD' ? undefined : buffer);
      } catch { return send(res, 404, 'text/plain; charset=utf-8', 'Not found'); }
    }
    // Serve the static UI shell ahead of the /api/* token gate so users opening / can
    // enter DASHBOARD_TOKEN in the browser if it is not passed in the query string.
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, 'text/html; charset=utf-8', readHtml());
    }

    // OTM API: callers authenticate with MONTRA_OTM_KEY, never the dashboard token, so
    // this route must run before the token gate. One request sends exactly one message.
    if (url.pathname === '/api/otm' || url.pathname.startsWith('/api/otm/')) {
      if (securityEngine.isLocked()) {
        return sendJson(res, 423, { ok: false, locked: true, error: 'Montra is locked. Enter the security PIN to continue.' });
      }
      if (!['/api/otm', '/api/otm/help', '/api/otm/status'].includes(url.pathname)) {
        return sendJson(res, 404, { ok: false, returnValue: 1, code: 'not_found', message: 'Unknown OTM endpoint. Use /api/otm or /api/otm/help.', help: otmEngine.helpText() });
      }
      if ((url.pathname === '/api/otm/help' || url.pathname === '/api/otm/status') && req.method !== 'GET') {
        return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed: use GET.');
      }
      const helpRequested = url.pathname === '/api/otm/help' || url.searchParams.get('action') === 'help';
      if (helpRequested && req.method === 'GET') {
        if (url.searchParams.get('format') === 'text') return send(res, 200, 'text/plain; charset=utf-8', otmEngine.helpText());
        return sendJson(res, 200, { ok: true, endpoint: '/api/otm', maxMessageChars: 600, help: otmEngine.helpText() });
      }
      if (!['GET', 'POST'].includes(req.method)) {
        return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed: use GET or POST.');
      }

      let body = null;
      if (req.method === 'POST') {
        let raw;
        try { raw = await readBody(req, 12 * 1024); }
        catch (e) {
          if (e.code === 413) return sendJson(res, 413, { ok: false, returnValue: 1, code: 'payload_too_large', message: 'Request body is too large (maximum 12 KB).', help: otmEngine.helpText() });
          return sendJson(res, 400, { ok: false, returnValue: 1, code: 'invalid_body', message: e.message || 'Could not read the request body.', help: otmEngine.helpText() });
        }
        if (raw.trim()) {
          const type = String(req.headers['content-type'] || '').toLowerCase();
          try {
            body = type.includes('application/x-www-form-urlencoded')
              ? Object.fromEntries(new URLSearchParams(raw))
              : JSON.parse(raw);
          } catch {
            return sendJson(res, 400, { ok: false, returnValue: 1, code: 'invalid_json', message: 'The request body is not valid JSON. Use application/json or a URL-encoded form.', help: otmEngine.helpText() });
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return sendJson(res, 400, { ok: false, returnValue: 1, code: 'invalid_request', message: 'Send a JSON object, not an array or primitive.', help: otmEngine.helpText() });
          }
        }
        // Query parameters are a convenience fallback for clients that cannot send a body.
        body = { ...Object.fromEntries(url.searchParams), ...(body || {}) };
      }

      const key = String(req.headers['x-otm-key'] || url.searchParams.get('key') || url.searchParams.get('otm_key') || body?.key || body?.otm_key || '');
      if (req.method === 'GET' && url.pathname === '/api/otm/status') {
        const auth = otmEngine.verifyKey(key);
        if (!auth.ok) return sendJson(res, auth.status, { ok: false, returnValue: 1, code: auth.code, message: auth.message, help: otmEngine.helpText() });
        return sendJson(res, 200, otmEngine.status());
      }

      const result = await otmEngine.execute({
        method: req.method,
        query: Object.fromEntries(url.searchParams),
        body,
        key
      });
      const wantsText = String(url.searchParams.get('format') || body?.format || '').toLowerCase() === 'text';
      if (wantsText) return send(res, result.status, 'text/plain; charset=utf-8', otmEngine.formatText(result));
      return sendJson(res, result.status, result.json);
    }

    if (token) {
      const supplied = url.searchParams.get('token') || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(String(supplied)); const b = Buffer.from(String(token));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, 'text/plain; charset=utf-8', 'Unauthorized');
    }

    // Security lock: the dashboard shell stays reachable so the PIN screen can render, but
    // every data/control endpoint is blocked until /start <PIN> (Telegram) or this unlock call.
    const secStatus = securityEngine.getStatus();
    if (req.method === 'GET' && url.pathname === '/api/security') return sendJson(res, 200, secStatus);
    if (req.method === 'POST' && url.pathname === '/api/security/unlock') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const result = securityEngine.unlock(body.pin, 'dashboard');
        if (!result.ok) return sendJson(res, 401, { ...result, locked: true });
        return sendJson(res, 200, { ok: true, locked: false });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (securityEngine.isLocked()) {
      return sendJson(res, 423, { locked: true, error: 'Montra is locked. Enter the security PIN to continue.', ...securityEngine.getStatus() });
    }
    if (req.method === 'POST' && url.pathname === '/api/security/lock') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const pin = String(body.pin || '').trim();
        securityEngine.lock(pin || undefined, 'dashboard');
        return sendJson(res, 200, { ok: true, ...securityEngine.getStatus() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }

    if (req.method === 'GET' && url.pathname === '/api/profile') {
      try { return sendJson(res, 200, typeof getProfile === 'function' ? await getProfile() : { error: 'Profile settings are unavailable.' }); }
      catch (e) { return sendJson(res, 503, { error: e.message || 'WhatsApp profile is unavailable.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/profile') {
      if (typeof updateProfile !== 'function') return sendJson(res, 503, { error: 'Profile editing is unavailable.' });
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const name = body.name === undefined ? undefined : String(body.name).trim();
        const about = body.about === undefined ? undefined : String(body.about).trim();
        if (name === undefined && about === undefined) return sendJson(res, 400, { error: 'Provide a profile name or about text.' });
        if (name !== undefined && (!name || name.length > 25)) return sendJson(res, 400, { error: 'Profile name must be 1–25 characters.' });
        if (about !== undefined && about.length > 139) return sendJson(res, 400, { error: 'About text must be 139 characters or fewer.' });
        const profile = await updateProfile({ name, about });
        return sendJson(res, 200, { ok: true, ...(profile || {}) });
      } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Profile update failed.' }); }
    }
    if (req.method === 'DELETE' && url.pathname === '/api/profile/picture') {
      if (typeof removeProfilePicture !== 'function') return sendJson(res, 503, { error: 'Profile picture editing is unavailable.' });
      try { await removeProfilePicture(); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 400, { error: e.message || 'Could not remove profile picture.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/profile/picture') {
      if (typeof updateProfilePicture !== 'function') return sendJson(res, 503, { error: 'Profile picture editing is unavailable.' });
      const contentType = String(req.headers['content-type'] || '');
      if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) return sendJson(res, 415, { error: 'Choose an image file.' });
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 6 * 1024 * 1024) return send(res, 413, 'text/plain; charset=utf-8', 'Payload too large'); chunks.push(chunk); }
      try {
        const form = await new Request('http://localhost/profile-picture', { method: 'POST', headers: { 'content-type': contentType }, body: Buffer.concat(chunks) }).formData();
        const file = form.get('file');
        if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1 || file.size > 5 * 1024 * 1024) return sendJson(res, 400, { error: 'Choose an image between 1 byte and 5 MB.' });
        const mime = String(file.type || '').toLowerCase();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return sendJson(res, 415, { error: 'Use a JPEG, PNG, or WebP image.' });
        await updateProfilePicture(Buffer.from(await file.arrayBuffer()), mime);
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message || 'Could not update profile picture.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/statuses') {
      try {
        const contacts = syncStore.getContacts();
        const rows = typeof getStatuses === 'function' ? await getStatuses() : [];
        // Status authors arrive as JIDs from the phone; label them like any other person.
        return sendJson(res, 200, (Array.isArray(rows) ? rows : []).map(status => ({
          ...status, name: usableName(status?.name) || personLabel(status?.participant, contacts) || ''
        })));
      }
      catch (e) { return sendJson(res, 503, { error: e.message || 'Could not load status updates.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/status-media') {
      const id = String(url.searchParams.get('id') || '');
      const participant = String(url.searchParams.get('participant') || '');
      let item = mediaArchive.getById(id);
      if (!item?.isStatus && typeof resolveStatusMedia === 'function') {
        // The viewer falls back to the status id, which lets the server retry an archive
        // attempt that missed the media when the status first arrived.
        const resolved = await resolveStatusMedia({ id, participant }).catch(e => ({ error: e.message }));
        item = resolved?.item || null;
        if (!item) return sendJson(res, 404, { error: resolved?.error || 'Status media is unavailable.' });
      }
      const buffer = item?.isStatus ? mediaArchive.readBuffer(item) : null;
      if (!item || !buffer) return sendJson(res, 404, { error: 'Status media is unavailable.' });
      return sendBuffer(res, buffer, item.mime, item.filename, 0);
    }
    if (req.method === 'POST' && url.pathname === '/api/statuses/view') {
      try {
        const body = JSON.parse((await readBody(req, 3000)) || '{}');
        if (typeof viewStatus !== 'function') return sendJson(res, 503, { error: 'Status viewing is unavailable.' });
        await viewStatus(String(body.id || ''), String(body.participant || ''));
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message || 'Could not view status.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/statuses') {
      if (typeof postStatus !== 'function') return sendJson(res, 503, { error: 'Status posting is unavailable.' });
      const contentType = String(req.headers['content-type'] || '');
      if (/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > MAX_DASHBOARD_UPLOAD_BYTES + 1024 * 1024) return sendJson(res, 413, { error: `Status media is limited to ${Math.floor(MAX_DASHBOARD_UPLOAD_BYTES / 1024 / 1024)} MB.` }); chunks.push(chunk); }
        try {
          const form = await new Request('http://localhost/status', { method: 'POST', headers: { 'content-type': contentType }, body: Buffer.concat(chunks) }).formData();
          const text = String(form.get('text') || '').trim(); const file = form.get('file');
          if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1 || file.size > MAX_DASHBOARD_UPLOAD_BYTES) return sendJson(res, 400, { error: 'Choose a non-empty image or video file within the upload limit.' });
          const mime = String(file.type || '').toLowerCase();
          if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(mime)) return sendJson(res, 415, { error: 'Statuses support JPEG, PNG, WebP, or MP4 media.' });
          await postStatus({ text, buffer: Buffer.from(await file.arrayBuffer()), mime, filename: file.name || 'status' });
        } catch (e) { return sendJson(res, 400, { error: e.message || 'Status could not be posted.' }); }
      } else {
        try {
          const text = String(JSON.parse((await readBody(req, 5000)) || '{}').text || '').trim();
          if (!text || text.length > 700) return sendJson(res, 400, { error: 'Text statuses must contain 1–700 characters.' });
          await postStatus({ text });
        } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Status could not be posted.' }); }
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/crm') {
      const tag = url.searchParams.get('tag');
      const contactJid = url.searchParams.get('jid');
      if (contactJid) {
        return sendJson(res, 200, {
          contact: crmEngine.getContact(contactJid),
          availableTags: crmEngine.getAll().availableTags
        });
      }
      if (tag) return sendJson(res, 200, { contacts: crmEngine.listByTag(tag) });
      return sendJson(res, 200, crmEngine.getAll());
    }
    if (req.method === 'POST' && url.pathname === '/api/crm/tag') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const ok = crmEngine.addTag(body.jid, body.tag, body.name);
        return sendJson(res, 200, { ok, contact: crmEngine.getContact(body.jid) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'DELETE' && url.pathname === '/api/crm/tag') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const ok = crmEngine.removeTag(body.jid, body.tag);
        return sendJson(res, 200, { ok, contact: crmEngine.getContact(body.jid) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/crm/note') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const ok = crmEngine.setNote(body.jid, body.notes, body.name);
        if (body.priority) crmEngine.setPriority(body.jid, body.priority);
        return sendJson(res, 200, { ok, contact: crmEngine.getContact(body.jid) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/analytics') {
      return sendJson(res, 200, analyzeEngine.getAnalyticsPayload());
    }
    if (req.method === 'GET' && (url.pathname === '/api/daily-summary' || url.pathname === '/api/analytics/daily-summary')) {
      const days = Number(url.searchParams.get('days')) || 7;
      return sendJson(res, 200, analyzeEngine.aggregateDailySummary(days));
    }
    if (req.method === 'GET' && url.pathname === '/api/settings/export') {
      const dataDir = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
      const timeConfigFile = path.join(dataDir, 'timeConfig.json');
      let rawTimeConfig = null;
      try {
        if (fs.existsSync(timeConfigFile)) {
          rawTimeConfig = JSON.parse(fs.readFileSync(timeConfigFile, 'utf8').replace(/^\uFEFF/, ''));
        }
      } catch { rawTimeConfig = null; }
      const payload = {
        exportedAt: new Date().toISOString(),
        timeConfig: rawTimeConfig,
        timeEngine: timeEngine.describe(),
        systemSettings: {
          app: {
            name: settings.name,
            version: settings.version,
            ownerNumberConfigured: Boolean(settings.ownerNumber)
          },
          sync: syncStore.syncStatus(),
          autoReply: autoReply.getConfig(),
          antiBan: antiBanEngine.getConfig(),
          humanizer: humanizerEngine.getConfig(),
          backupConfig: backupManager.getScheduleConfig(),
          mediaArchive: mediaArchive.stats(),
          security: securityEngine.getStatus(),
          aiProvider: geminiResilient.getProviderStatus(),
          dashboard: {
            theme: prefs.theme,
            pinnedCount: prefs.pinned.length,
            mutedCount: prefs.muted.length,
            archivedCount: prefs.archived.length
          },
          alertsCount: alertEngine.listRules().length
        }
      };
      const body = JSON.stringify(payload, null, 2);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': 'attachment; filename="montra-system-settings.json"',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/api/backups') {
      return sendJson(res, 200, { backups: backupManager.listBackups(), config: backupManager.getScheduleConfig() });
    }
    if (req.method === 'POST' && url.pathname === '/api/backups') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const result = backupManager.createBackup(body.passphrase || null);
        return sendJson(res, 200, { ok: true, result });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/backups/config') {
      return sendJson(res, 200, backupManager.getScheduleConfig());
    }
    if (req.method === 'POST' && url.pathname === '/api/backups/config') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const config = backupManager.setScheduleConfig(body);
        return sendJson(res, 200, { ok: true, config });
      } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/media/stats') {
      return sendJson(res, 200, mediaArchive.stats());
    }
    if (req.method === 'POST' && url.pathname === '/api/media/clear-cache') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const result = mediaArchive.clearCache({
          onlyIfExceeded: Boolean(body.onlyIfExceeded),
          statusOnly: Boolean(body.statusOnly)
        });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/monitor') {
      const conn = (typeof getConnection === 'function' ? getConnection() : null) || { status: 'unknown', connected: false };
      const snap = systemMonitor.snapshot({
        connection: { status: conn.status, connected: Boolean(conn.connected), user: conn.user || null },
        mediaArchive: mediaArchive.stats(),
        backupConfig: backupManager.getScheduleConfig(),
        sync: syncStore.stats(),
        antiBan: antiBanEngine.getSecurityStatus(),
        autoReply: autoReply.getConfig()
      });
      return sendJson(res, 200, { ...snap, history: systemMonitor.getHistory() });
    }
    if (req.method === 'GET' && url.pathname === '/api/bots') {
      return sendJson(res, 200, botEngine.getSnapshot());
    }
    if (req.method === 'GET' && url.pathname === '/api/bots/comms') {
      const limit = Number(url.searchParams.get('limit')) || 120;
      const botId = url.searchParams.get('botId') || 'all';
      const category = url.searchParams.get('category') || 'all';
      return sendJson(res, 200, botEngine.getCommunicationStream({ limit, botId, category }));
    }
    if (req.method === 'GET' && url.pathname === '/api/bots/graph') {
      return sendJson(res, 200, botEngine.getDependencyGraph());
    }
    if (req.method === 'GET' && url.pathname === '/api/firebase-config') {
      const cfg = readFirebaseClientConfig();
      if (!cfg) return sendJson(res, 404, { error: 'Firebase configuration is unavailable.' });
      return sendJson(res, 200, cfg);
    }
    if (url.pathname === '/api/workspace/token-monitor' && req.method === 'GET') {
      return sendJson(res, 200, workspaceTokenManager.getStatus());
    }
    if (url.pathname === '/api/workspace/token-monitor/config' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req, 50000)) || '{}');
        if (body.clearToken === true) {
          workspaceTokenManager.clearToken('operator_sign_out');
          return sendJson(res, 200, { ok: true, monitor: workspaceTokenManager.getStatus() });
        }
        const hasConfigPatch = body.autoRefreshEnabled !== undefined || body.thresholdSec !== undefined || body.scopeConfigs !== undefined;
        if (hasConfigPatch) {
          workspaceTokenManager.updateConfig(body);
        }
        let refreshResult = null;
        if (body.forceRefresh === true) {
          refreshResult = await workspaceTokenManager.triggerAutoRefresh('manual_dashboard_trigger');
        }
        const safeRefresh = refreshResult
          ? { ok: Boolean(refreshResult.ok), mode: refreshResult.mode, error: refreshResult.error || '', trigger: refreshResult.trigger || null, skipped: Boolean(refreshResult.skipped) }
          : null;
        return sendJson(res, 200, { ok: true, refreshResult: safeRefresh, monitor: workspaceTokenManager.getStatus() });
      } catch (e) {
        return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Invalid token monitor configuration.' });
      }
    }
    if (url.pathname.startsWith('/api/workspace/')) {
      const authHdr = String(req.headers.authorization || '').trim();
      const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHdr);
      const googleToken = String(req.headers['x-google-access-token'] || (bearerMatch ? bearerMatch[1] : '') || '').trim();
      if (!googleToken) {
        return sendJson(res, 401, { error: 'Sign in with Google to access Workspace services.' });
      }
      if (url.pathname === '/api/workspace/token-register' && req.method === 'POST') {
        try {
          const body = JSON.parse((await readBody(req, 10000)) || '{}');
          const monitor = workspaceTokenManager.registerToken({
            token: googleToken,
            expiresIn: body.expiresIn,
            expiresAtMs: body.expiresAtMs,
            scopeCount: body.scopeCount,
            services: body.services,
            email: body.email,
            uid: body.uid,
            source: String(body.source || 'firebase_popup')
          });
          return sendJson(res, 200, { ok: true, monitor });
        } catch (e) {
          return sendJson(res, 400, { error: e.message || 'Could not register Workspace token.' });
        }
      }
      if (url.pathname === '/api/workspace/token-status' && req.method === 'GET') {
        try {
          let resp = await fetch('https://oauth2.googleapis.com/tokeninfo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'access_token=' + encodeURIComponent(googleToken)
          });
          if (resp.status === 405) {
            resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(googleToken)}`);
          }
          const info = await resp.json().catch(() => ({}));
          const parsed = parseTokenInfoResponse(resp.ok, info);
          if (parsed.valid) {
            workspaceTokenManager.registerToken({
              token: googleToken,
              expiresIn: parsed.expiresIn,
              expiresAtMs: parsed.expiresAtMs,
              scopeCount: parsed.scopeCount,
              services: parsed.services,
              email: parsed.email,
              source: 'tokeninfo_poll'
            });
          } else {
            workspaceTokenManager.registerToken({
              token: googleToken,
              expiresIn: 0,
              expiresAtMs: Date.now() - 1000,
              source: 'tokeninfo_expired'
            });
          }
          await workspaceTokenManager.evaluateLifecycle();
          return sendJson(res, 200, { ...parsed, monitor: workspaceTokenManager.getStatus() });
        } catch {
          return sendJson(res, 200, {
            ...parseTokenInfoResponse(false, { error: 'tokeninfo_unreachable', error_description: 'Unable to reach Google token verification endpoint.' }),
            monitor: workspaceTokenManager.getStatus()
          });
        }
      }
      const gReq = async (targetUrl, opts = {}) => {
        const headers = { Authorization: `Bearer ${googleToken}`, ...(opts.headers || {}) };
        const resp = await fetch(targetUrl, { ...opts, headers });
        const text = await resp.text();
        let data = null;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        return { ok: resp.ok, status: resp.status, data };
      };
      const WS_ID_RE = /^[a-zA-Z0-9_-]{2,128}$/;
      const SPACE_RE = /^spaces\/[a-zA-Z0-9_-]{1,128}$/;
      try {
        if (url.pathname === '/api/workspace/drive/files') {
          if (req.method === 'GET') {
            const qRaw = String(url.searchParams.get('q') || '').trim().slice(0, 80);
            const escaped = qRaw.replace(/['\\]/g, '');
            const query = escaped ? `name contains '${escaped}' and trashed = false` : 'trashed = false';
            const r = await gReq(`https://www.googleapis.com/drive/v3/files?pageSize=20&orderBy=modifiedTime%20desc&fields=files(id,name,mimeType,modifiedTime,size,webViewLink)&q=${encodeURIComponent(query)}`);
            return sendJson(res, r.status, r.data);
          }
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req, 50000)) || '{}');
            const name = String(body.name || '').trim().slice(0, 120);
            if (!name) return sendJson(res, 400, { error: 'Provide a Drive file or folder name.' });
            if (body.kind === 'folder') {
              const r = await gReq('https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,webViewLink', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
              });
              return sendJson(res, r.status, r.data);
            }
            const content = String(body.content || '').slice(0, 40000);
            const boundary = 'montra_ws_' + crypto.randomBytes(6).toString('hex');
            const metaPart = JSON.stringify({ name, mimeType: 'text/plain' });
            const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaPart}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
            const r = await gReq('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink', {
              method: 'POST',
              headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
              body: multipart
            });
            return sendJson(res, r.status, r.data);
          }
          if (req.method === 'DELETE') {
            const id = String(url.searchParams.get('id') || '').trim();
            if (!WS_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid Drive file ID.' });
            const r = await gReq(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
            return sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true, id } : r.data);
          }
        }
        if (url.pathname === '/api/workspace/gmail/messages' && req.method === 'GET') {
          const q = String(url.searchParams.get('q') || '').trim().slice(0, 120);
          const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10${q ? '&q=' + encodeURIComponent(q) : ''}`;
          const listRes = await gReq(listUrl);
          if (!listRes.ok) return sendJson(res, listRes.status, listRes.data);
          const msgs = Array.isArray(listRes.data.messages) ? listRes.data.messages.slice(0, 10) : [];
          const details = await Promise.all(msgs.map(async m => {
            if (!WS_ID_RE.test(String(m.id || ''))) return null;
            const d = await gReq(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
            if (!d.ok) return { id: m.id, subject: '(unavailable)', from: '', date: '', snippet: '' };
            const hdrs = (d.data.payload && d.data.payload.headers) || [];
            const getHdr = k => (hdrs.find(h => String(h.name || '').toLowerCase() === k) || {}).value || '';
            return {
              id: d.data.id,
              threadId: d.data.threadId,
              subject: getHdr('subject') || '(no subject)',
              from: getHdr('from'),
              date: getHdr('date'),
              snippet: d.data.snippet || ''
            };
          }));
          return sendJson(res, 200, { messages: details.filter(Boolean) });
        }
        if (url.pathname === '/api/workspace/gmail/send' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 30000)) || '{}');
          const to = String(body.to || '').replace(/[\r\n]/g, '').trim();
          const subject = String(body.subject || '').replace(/[\r\n]/g, '').trim().slice(0, 200);
          const text = String(body.body || '').trim().slice(0, 20000);
          if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return sendJson(res, 400, { error: 'Enter a valid recipient email address.' });
          if (!subject || !text) return sendJson(res, 400, { error: 'Provide both subject and message body.' });
          const mime = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`;
          const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          const r = await gReq('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw })
          });
          return sendJson(res, r.status, r.data);
        }
        if (url.pathname === '/api/workspace/contacts') {
          if (req.method === 'GET') {
            const r = await gReq('https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses,phoneNumbers,organizations&pageSize=25');
            return sendJson(res, r.status, r.data);
          }
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req, 10000)) || '{}');
            const givenName = String(body.givenName || '').trim().slice(0, 80);
            const familyName = String(body.familyName || '').trim().slice(0, 80);
            const email = String(body.email || '').trim().slice(0, 160);
            const phone = String(body.phone || '').trim().slice(0, 40);
            if (!givenName) return sendJson(res, 400, { error: 'Provide a first name for the contact.' });
            const payload = { names: [{ givenName, familyName }] };
            if (email) payload.emailAddresses = [{ value: email }];
            if (phone) payload.phoneNumbers = [{ value: phone }];
            const r = await gReq('https://people.googleapis.com/v1/people:createContact', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            return sendJson(res, r.status, r.data);
          }
        }
        if (url.pathname === '/api/workspace/calendar/events') {
          if (req.method === 'GET') {
            const timeMin = new Date().toISOString();
            const r = await gReq(`https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=20&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}`);
            return sendJson(res, r.status, r.data);
          }
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req, 10000)) || '{}');
            const summary = String(body.summary || '').trim().slice(0, 160);
            const startIso = new Date(body.start || Date.now() + 3600000).toISOString();
            const endIso = new Date(body.end || (Date.parse(startIso) + 3600000)).toISOString();
            const description = String(body.description || '').trim().slice(0, 1000);
            if (!summary) return sendJson(res, 400, { error: 'Provide an event title.' });
            const r = await gReq('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ summary, description, start: { dateTime: startIso }, end: { dateTime: endIso } })
            });
            return sendJson(res, r.status, r.data);
          }
          if (req.method === 'DELETE') {
            const id = String(url.searchParams.get('id') || '').trim();
            if (!WS_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid Calendar event ID.' });
            const r = await gReq(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
            return sendJson(res, r.ok ? 200 : r.status, r.ok ? { ok: true, id } : r.data);
          }
        }
        if (url.pathname === '/api/workspace/tasks') {
          if (req.method === 'GET') {
            const listId = String(url.searchParams.get('tasklistId') || '@default').trim();
            if (listId !== '@default' && !WS_ID_RE.test(listId)) return sendJson(res, 400, { error: 'Invalid task list ID.' });
            const [listsRes, tasksRes] = await Promise.all([
              gReq('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=10'),
              gReq(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks?maxResults=25&showCompleted=true`)
            ]);
            if (!tasksRes.ok) return sendJson(res, tasksRes.status, tasksRes.data);
            return sendJson(res, 200, { lists: listsRes.ok ? (listsRes.data.items || []) : [], items: tasksRes.data.items || [] });
          }
          if (req.method === 'POST') {
            const body = JSON.parse((await readBody(req, 10000)) || '{}');
            const title = String(body.title || '').trim().slice(0, 160);
            const notes = String(body.notes || '').trim().slice(0, 1000);
            const listId = String(body.tasklistId || '@default').trim();
            if (listId !== '@default' && !WS_ID_RE.test(listId)) return sendJson(res, 400, { error: 'Invalid task list ID.' });
            if (!title) return sendJson(res, 400, { error: 'Provide a task title.' });
            const r = await gReq(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title, notes })
            });
            return sendJson(res, r.status, r.data);
          }
          if (req.method === 'PATCH') {
            const body = JSON.parse((await readBody(req, 5000)) || '{}');
            const id = String(body.id || '').trim();
            const listId = String(body.tasklistId || '@default').trim();
            const status = body.status === 'completed' ? 'completed' : 'needsAction';
            if (!WS_ID_RE.test(id)) return sendJson(res, 400, { error: 'Invalid task ID.' });
            if (listId !== '@default' && !WS_ID_RE.test(listId)) return sendJson(res, 400, { error: 'Invalid task list ID.' });
            const r = await gReq(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status })
            });
            return sendJson(res, r.status, r.data);
          }
        }
        if (url.pathname === '/api/workspace/chat/spaces' && req.method === 'GET') {
          const spacesRes = await gReq('https://chat.googleapis.com/v1/spaces?pageSize=20');
          if (!spacesRes.ok) return sendJson(res, spacesRes.status, spacesRes.data);
          const spaceName = String(url.searchParams.get('spaceName') || '').trim();
          let messages = [];
          if (spaceName) {
            if (!SPACE_RE.test(spaceName)) return sendJson(res, 400, { error: 'Invalid Google Chat space name.' });
            const msgRes = await gReq(`https://chat.googleapis.com/v1/${spaceName}/messages?pageSize=20`);
            if (msgRes.ok) messages = msgRes.data.messages || [];
          }
          return sendJson(res, 200, { spaces: spacesRes.data.spaces || [], messages });
        }
        if (url.pathname === '/api/workspace/chat/messages' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 10000)) || '{}');
          const spaceName = String(body.spaceName || '').trim();
          const text = String(body.text || '').trim().slice(0, 4000);
          if (!SPACE_RE.test(spaceName)) return sendJson(res, 400, { error: 'Select a valid Google Chat space.' });
          if (!text) return sendJson(res, 400, { error: 'Enter a message to post.' });
          const r = await gReq(`https://chat.googleapis.com/v1/${spaceName}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text })
          });
          return sendJson(res, r.status, r.data);
        }
        return sendJson(res, 404, { error: 'Unknown Workspace endpoint.' });
      } catch (e) {
        return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Workspace request failed.' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/toggle') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const fleet = botEngine.updateSettings(body);
        return sendJson(res, 200, { ok: true, fleet });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/cycle') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const result = await botEngine.runAutonomousCycle({ trigger: 'manual', useAi: Boolean(body.useAi) });
        return sendJson(res, 200, { ...result, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/message') {
      try {
        const body = JSON.parse((await readBody(req, 20000)) || '{}');
        const result = await botEngine.dispatchTask({
          targetBot: String(body.targetBot || 'bot-montra'),
          prompt: String(body.prompt || ''),
          useAi: Boolean(body.useAi),
          deep: Boolean(body.deep),
          notifyTelegram: Boolean(body.notifyTelegram)
        });
        return sendJson(res, 200, { ...result, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/bus') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const msg = botEngine.sendBusMessage(body);
        return sendJson(res, 200, { ok: true, message: msg, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/rules') {
      try {
        const body = JSON.parse((await readBody(req, 20000)) || '{}');
        const bot = botEngine.updateBotPersonality(String(body.botId || ''), body);
        return sendJson(res, 200, { ok: true, bot, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/shell') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const result = await botEngine.requestShellCommand({
          botId: String(body.botId || 'bot-derric'),
          command: String(body.command || ''),
          args: body.args || [],
          reason: String(body.reason || '')
        });
        return sendJson(res, 200, { ...result, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/approval') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const result = await botEngine.resolveApproval(String(body.id || ''), Boolean(body.approve));
        return sendJson(res, 200, { ...result, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/telegram') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const result = await botEngine.sendTelegramFromBot(
          String(body.botId || 'bot-ruri'),
          String(body.message || ''),
          { kind: String(body.kind || 'report'), urgent: Boolean(body.urgent) }
        );
        return sendJson(res, 200, { ...result, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/website-action') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const result = await botEngine.runWebsiteBotAction(String(body.action || 'status_check'), body);
        return sendJson(res, 200, { ...result, fleet: botEngine.getSnapshot() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/facebook/status') {
      return sendJson(res, 200, facebookBot.getStatus());
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/connect') {
      try {
        const body = JSON.parse((await readBody(req, 65000)) || '{}');
        const result = await facebookBot.connectAppState(body.appState);
        return sendJson(res, 200, result);
      } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Could not link Facebook appState.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/disconnect') {
      return sendJson(res, 200, facebookBot.disconnectAppState());
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/logs/clear') {
      try {
        facebookBot.state.activityLogs = [];
        facebookBot.saveState();
        return sendJson(res, 200, { ok: true, status: facebookBot.getStatus() });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/config') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        return sendJson(res, 200, { ok: true, status: facebookBot.updateConfig(body) });
      } catch (e) { return sendJson(res, 400, { error: e.message || 'Invalid Facebook config.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/quick-replies') {
      try {
        const body = JSON.parse((await readBody(req, 20000)) || '{}');
        return sendJson(res, 200, { ok: true, status: facebookBot.updateQuickReplies(body.quickReplies) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/filters') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        return sendJson(res, 200, { ok: true, status: facebookBot.updateNotificationFilters(body.filters) });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/notifications/fetch') {
      try { return sendJson(res, 200, await facebookBot.fetchNotifications()); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/notifications/telegram') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        const text = String(body.text || '').trim().slice(0, 400);
        if (!text) return sendJson(res, 400, { error: 'Notification text is required.' });
        const result = await botEngine.sendTelegramFromBot('facebook-bot', `Facebook Notification: ${text}`, { kind: 'fb_notification' });
        return sendJson(res, 200, result);
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/threads/fetch') {
      try { return sendJson(res, 200, await facebookBot.fetchThreads()); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/chat') {
      try {
        const body = JSON.parse((await readBody(req, 15000)) || '{}');
        const result = await facebookBot.chatWithBot({
          message: body.message,
          threadId: body.threadId || '',
          senderName: body.senderName || 'Operator',
          sendToFacebook: Boolean(body.sendToFacebook)
        });
        return sendJson(res, 200, result);
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/posts/fetch') {
      try { return sendJson(res, 200, await facebookBot.fetchPosts()); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/posts') {
      try {
        const body = JSON.parse((await readBody(req, 20000)) || '{}');
        return sendJson(res, 200, await facebookBot.createPost(body));
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/posts/react') {
      try {
        const body = JSON.parse((await readBody(req, 5000)) || '{}');
        return sendJson(res, 200, await facebookBot.reactPost(body.postId, body.reaction));
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/posts/comment') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        return sendJson(res, 200, await facebookBot.commentPost(body.postId, body.comment));
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'DELETE' && url.pathname === '/api/facebook/posts') {
      try {
        const raw = await readBody(req, 5000).catch(() => '');
        const body = raw ? JSON.parse(raw) : {};
        const postId = String(body.postId || url.searchParams.get('id') || '').trim();
        return sendJson(res, 200, await facebookBot.deletePost(postId));
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/facebook/poll') {
      try { return sendJson(res, 200, await facebookBot.pollEvents()); }
      catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/ai/status') {
      return sendJson(res, 200, { ok: true, status: geminiResilient.getProviderStatus() });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/summarize') {
      try {
        const body = JSON.parse((await readBody(req, 50000)) || '{}');
        const summary = await aiAssistant.summarize(body.messages || [], body.title || 'chat');
        return sendJson(res, 200, { ok: true, summary });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/draft') {
      try {
        const body = JSON.parse((await readBody(req, 20000)) || '{}');
        const draft = await aiAssistant.draftReply(body.context || '', body.tone || 'friendly');
        return sendJson(res, 200, { ok: true, draft });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/translate') {
      try {
        const body = JSON.parse((await readBody(req, 20000)) || '{}');
        const translation = await aiAssistant.translate(body.text || '', body.targetLang || 'English');
        return sendJson(res, 200, { ok: true, translation });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/stories/scheduled') {
      const date = url.searchParams.get('date');
      return sendJson(res, 200, { stories: statusScheduler.listScheduled(date || null) });
    }
    if (req.method === 'POST' && url.pathname === '/api/stories/schedule') {
      try {
        const body = JSON.parse((await readBody(req, 32 * 1024 * 1024)) || '{}');
        let mediaBuffer = null;
        if (body.mediaBase64) mediaBuffer = Buffer.from(body.mediaBase64, 'base64');
        const scheduled = statusScheduler.scheduleStatus({
          when: body.when,
          caption: body.caption,
          type: body.type || 'text',
          mediaBuffer,
          filename: body.filename,
          backgroundColor: body.backgroundColor
        });
        return sendJson(res, 200, { ok: true, story: scheduled });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'DELETE' && url.pathname === '/api/stories/scheduled') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const ok = statusScheduler.deleteScheduled(body.date, body.id);
        return sendJson(res, 200, { ok });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/alerts') {
      return sendJson(res, 200, { rules: alertEngine.listRules() });
    }
    if (req.method === 'POST' && url.pathname === '/api/alerts') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        if (body.action === 'toggle') {
          const rule = alertEngine.toggleRule(body.id, typeof body.enabled === 'boolean' ? body.enabled : null);
          if (!rule) return sendJson(res, 404, { error: 'Alert rule not found.' });
          return sendJson(res, 200, { ok: true, rule });
        }
        const rule = alertEngine.addRule(body.trigger, body.template, body.name);
        return sendJson(res, 200, { ok: true, rule });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'DELETE' && url.pathname === '/api/alerts') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const ok = alertEngine.removeRule(body.id);
        return sendJson(res, 200, { ok });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/calls') {
      const limit = Number(url.searchParams.get('limit')) || 20;
      return sendJson(res, 200, { calls: alertEngine.getCallLogs(limit) });
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') return sendJson(res, 200, { ...syncStore.syncStatus(), mediaArchive: mediaArchive.stats(), backupConfig: backupManager.getScheduleConfig(), uptime: process.uptime(), at: new Date().toISOString() });
    if (req.method === 'GET' && url.pathname === '/api/connection') {
      const conn = (typeof getConnection === 'function' ? getConnection() : null) || { status: 'unknown' };
      const connected = Boolean(conn.connected);
      const qrMatrix = connected ? null : buildQrMatrix(conn.qr);
      return sendJson(res, 200, {
        status: conn.status || 'unknown',
        connected,
        user: conn.user || null,
        hasQr: Boolean(qrMatrix),
        qrMatrix,
        qrUpdatedAt: connected ? null : (conn.qrUpdatedAt || null),
        pairingCode: connected ? null : (conn.pairingCode || null),
        pairingPhone: connected ? null : (conn.pairingPhone || null)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/connection/pair') {
      if (typeof requestPairingCode !== 'function') return sendJson(res, 503, { error: 'Phone pairing is unavailable.' });
      const conn = (typeof getConnection === 'function' ? getConnection() : null) || {};
      if (conn.connected) return sendJson(res, 400, { error: 'WhatsApp is already linked.' });
      try {
        const body = JSON.parse((await readBody(req, 2000)) || '{}');
        const digits = String(body.phone || '').replace(/[^0-9]/g, '');
        if (digits.length < 7 || digits.length > 15) {
          return sendJson(res, 400, { error: 'Enter a phone number with country code (7–15 digits).' });
        }
        const rawCode = await requestPairingCode(digits);
        const code = String(rawCode || '').match(/.{1,4}/g)?.join('-') || String(rawCode || '');
        if (!code) return sendJson(res, 502, { error: 'Could not generate a pairing code. Try again shortly.' });
        return sendJson(res, 200, { ok: true, code, phone: digits });
      } catch (e) {
        return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Could not request pairing code.' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/connection/reconnect') {
      if (typeof refreshQr !== 'function') return sendJson(res, 503, { error: 'QR refresh is unavailable.' });
      try {
        const result = await refreshQr();
        return sendJson(res, 200, { ok: true, ...(result || {}) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message || 'Could not refresh WhatsApp link.' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/prefs') return sendJson(res, 200, prefs);
    if (req.method === 'POST' && url.pathname === '/api/prefs') {
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        if (!applyPrefs(body)) return sendJson(res, 400, { error: 'Unsupported preference or unknown chat.' });
        persistPrefs();
        return sendJson(res, 200, prefs);
      } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Invalid request.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/avatar') {
      const jid = String(url.searchParams.get('jid') || '');
      const own = String((typeof getConnection === 'function' ? getConnection() : null)?.user || '');
      if (!jid || (!knownChat(jid) && !syncStore.getContacts()[jid] && jid !== own)) return sendJson(res, 404, { error: 'No picture available.' });
      // A resolved "no picture" answer is cheaper than another round trip to WhatsApp.
      if (pictureKnown(jid) === false) return sendJson(res, 404, { error: 'No picture available.' });
      const hit = avatarCache.get(jid);
      const now = Date.now();
      if (hit && (hit.buffer ? now - hit.at < AVATAR_TTL_MS : now < hit.until)) {
        if (!hit.buffer) return sendJson(res, 404, { error: 'No picture available.' });
        return sendBuffer(res, hit.buffer, hit.mime, 'avatar', 21600);
      }
      if (typeof getAvatarUrl !== 'function') return sendJson(res, 404, { error: 'Profile pictures are unavailable.' });
      try {
        const target = await getAvatarUrl(jid);
        if (!target) throw new Error('no picture');
        const response = await fetch(target);
        if (!response.ok) throw new Error(`download failed (${response.status})`);
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) throw new Error('bad image');
        const mime = String(response.headers.get('content-type') || 'image/jpeg').split(';')[0];
        avatarCache.set(jid, { at: Date.now(), buffer, mime });
        if (avatarCache.size > 400) avatarCache.delete(avatarCache.keys().next().value);
        return sendBuffer(res, buffer, mime, 'avatar', 21600);
      } catch {
        avatarCache.set(jid, { at: Date.now(), buffer: null, until: Date.now() + AVATAR_MISS_TTL_MS });
        if (avatarCache.size > 400) avatarCache.delete(avatarCache.keys().next().value);
        return sendJson(res, 404, { error: 'No picture available.' });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/contact') {
      const jid = String(url.searchParams.get('jid') || '');
      if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
      if (typeof getChatInfo !== 'function') return sendJson(res, 503, { error: 'Contact details are unavailable.' });
      try {
        const info = await getChatInfo(jid) || {};
        const contacts = syncStore.getContacts();
        const kind = chatKindOf(jid);
        // Only a name WhatsApp actually supplied is cached; fallbacks stay transient.
        const resolved = usableName(info.name);
        const picture = typeof info.picture === 'string' ? Boolean(info.picture) : info.hasPicture === true;
        if (resolved) rememberChatMeta(jid, resolved, picture);
        const name = resolved || chatDisplayName(jid, chatById(jid), contacts);
        return sendJson(res, 200, {
          ...info, jid, name, type: kind, isGroup: kind === 'group', isChannel: kind === 'channel',
          participants: Array.isArray(info.participants)
            ? info.participants.map(p => ({ ...p, name: usableName(p.name) || personLabel(p.jid, contacts) }))
            : info.participants,
          ownerName: info.owner ? personLabel(info.owner, contacts) : '',
          canSend: kind === 'chat' || kind === 'group', hasPicture: picture || pictureKnown(jid) === true
        });
      }
      catch (e) { return sendJson(res, 503, { error: e.message || 'Contact details are unavailable.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/contacts') {
      const contacts = syncStore.getContacts();
      const chatsById = new Map(syncStore.getChats().map(chat => [String(chat.id || chat.jid), chat]));
      // Group and channel chats often exist without a contact entry, so both stores
      // contribute rows and the picker can show every conversation type.
      const people = new Map();
      for (const contact of Object.values(contacts)) {
        const jid = String(contact?.id || '');
        if (!jid || jid.endsWith('@broadcast')) continue;
        people.set(jid, contact);
      }
      for (const [jid, chat] of chatsById) {
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || people.has(jid)) continue;
        people.set(jid, { id: jid, name: chat?.name || chat?.subject || '' });
      }
      const rows = [...people.values()]
        .map(contact => {
          const jid = String(contact.id);
          const kind = chatKindOf(jid);
          const chat = chatsById.get(jid) || null;
          const picture = pictureKnown(jid);
          return {
            jid, name: chatDisplayName(jid, chat, contacts), type: kind, isGroup: kind === 'group',
            isChannel: kind === 'channel', canSend: kind === 'chat' || kind === 'group', hasChat: chatsById.has(jid),
            // null means "never asked yet" so the UI still tries the proxy; false is a cached no.
            hasPicture: picture === null ? (chat?.hasPicture ? true : null) : picture
          };
        })
        .sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()))
        .slice(0, 300);
      return sendJson(res, 200, rows);
    }
    if (req.method === 'GET' && url.pathname === '/api/presence') {
      const jid = String(url.searchParams.get('jid') || '');
      if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
      return sendJson(res, 200, presenceCache.get(jid) || { presence: 'unknown' });
    }
    if (req.method === 'POST' && url.pathname === '/api/read') {
      try {
        const jid = String(JSON.parse((await readBody(req, 2000)) || '{}').jid || '');
        if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
        const alreadyRead = readReceiptsSent.get(jid) || new Set();
        const keys = syncStore.getMessages(jid, 100).filter(message => !message.key?.fromMe && message.key?.id && !alreadyRead.has(message.key.id)).map(message => message.key);
        if (keys.length && typeof markRead === 'function') {
          await markRead(keys);
          for (const key of keys) alreadyRead.add(key.id);
          if (alreadyRead.size > 1000) alreadyRead.delete(alreadyRead.values().next().value);
          cacheSet(readReceiptsSent, jid, alreadyRead, 500);
        }
        return sendJson(res, 200, { ok: true, count: keys.length });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/presence/subscribe') {
      try {
        const jid = String(JSON.parse((await readBody(req, 2000)) || '{}').jid || '');
        if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
        if (typeof subscribePresence === 'function') await subscribePresence(jid);
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/typing') {
      try {
        const body = JSON.parse((await readBody(req, 2000)) || '{}');
        const jid = String(body.jid || '');
        if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
        if (typeof setTyping === 'function') await setTyping(jid, Boolean(body.typing));
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/chats') {
      const contacts = syncStore.getContacts();
      // status@broadcast belongs to the Status tab, not the chat list.
      const pendingMeta = [];
      const chats = syncStore.getChats().filter(chat => (chat.id || chat.jid) !== 'status@broadcast').map(chat => {
        const jid = chat.id || chat.jid;
        const kind = chatKindOf(jid);
        const latest = syncStore.getMessages(jid, 1)[0];
        const decoded = latest ? decoder.decode(latest.message) : null;
        // Queue a chat when either half of its identity is still unknown. The provider answers
        // name and picture together, so this also stops the UI from probing /api/avatar for
        // contacts whose name came straight from the address book.
        if (!storedName(jid, chat, contacts) || pictureKnown(jid) === null) pendingMeta.push({ jid, at: Number(latest?.messageTimestamp || chat.lastMessageAt || 0) });
        const name = chatDisplayName(jid, chat, contacts, senderLabel(latest, contacts));
        const picture = pictureKnown(jid);
        const crm = crmEngine.getContact(jid);
        return {
          ...chat, jid, id: jid, name, type: kind, isGroup: kind === 'group', isChannel: kind === 'channel',
          preview: decoded?.text ? markdownEngine.plainText(decoded.text) : (decoded ? decoder.describe(decoded) : ''),
          lastSender: latest && !latest.key?.fromMe ? senderLabel(latest, contacts) : '',
          lastFromMe: Boolean(latest?.key?.fromMe), lastStatus: Number(latest?.status || 0), lastKind: String(decoded?.kind || ''),
          unreadCount: Number(chat.unreadCount || 0),
          lastMessageAt: Number(latest?.messageTimestamp || chat.lastMessageAt || chat.conversationTimestamp || 0),
          hasPicture: picture === null ? (chat.hasPicture ? true : null) : picture,
          canSend: kind === 'chat' || kind === 'group',
          crmTags: Array.isArray(crm?.tags) ? crm.tags : [],
          crmPriority: crm?.priority || '',
          hasNote: Boolean(crm?.notes),
          pinned: prefs.pinned.includes(jid), muted: prefs.muted.includes(jid),
          archived: prefs.archived.includes(jid), localUnread: prefs.unread.includes(jid)
        };
      }).sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, 300);
      // Resolve names for the chats the user is most likely to see first.
      requestChatMeta(pendingMeta.sort((x, y) => y.at - x.at).map(entry => entry.jid));
      return sendJson(res, 200, chats);
    }
    if (req.method === 'POST' && url.pathname === '/api/chats') {
      try {
        const body = JSON.parse((await readBody(req, 2000)) || '{}');
        const phone = String(body.phone || '').replace(/[^0-9]/g, '');
        if (phone.length < 7 || phone.length > 15) return sendJson(res, 400, { error: 'Enter a phone number with country code (7–15 digits).' });
        const jid = `${phone}@s.whatsapp.net`;
        const existing = syncStore.getChats().find(chat => (chat.id || chat.jid) === jid);
        const chat = existing || { id: jid, name: phone, subject: phone, conversationTimestamp: Math.floor(Date.now() / 1000) };
        if (!existing) { syncStore.upsertChats([chat]); syncStore.upsertContacts([{ id: jid, name: phone }]); }
        return sendJson(res, 200, chat);
      } catch { return sendJson(res, 400, { error: 'Invalid request.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/messages') {
      const jid = String(url.searchParams.get('jid') || '');
      if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 60));
      if (!storedName(jid, chatById(jid), syncStore.getContacts()) || pictureKnown(jid) === null) requestChatMeta([jid]);
      return sendJson(res, 200, messageRows(jid, syncStore.getMessages(jid, limit)));
    }
    if (req.method === 'GET' && url.pathname === '/api/message') {
      const jid = String(url.searchParams.get('jid') || '');
      const id = String(url.searchParams.get('id') || '');
      if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
      const row = syncStore.getMessageById(jid, id);
      if (!row) return sendJson(res, 404, { error: 'Message not found' });
      return sendJson(res, 200, messageRows(jid, [row])[0] || null);
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const jid = String(url.searchParams.get('jid') || '');
      if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
      const contacts = syncStore.getContacts();
      const rows = syncStore.getMessages(jid, 200).reverse();
      const lines = [`Montra chat export — ${chatDisplayName(jid, chatById(jid), contacts)}`, `Chat: ${jid}`, ''];
      for (const m of rows) {
        const decoded = decoder.decode(m.message) || {};
        const who = m.key?.fromMe ? 'You' : senderLabel(m, contacts) || personLabel(m.key?.participant || jid, contacts) || 'WhatsApp user';
        const when = new Date(Number(m.messageTimestamp || 0) * (Number(m.messageTimestamp || 0) > 1e12 ? 1 : 1000));
        lines.push(`[${isNaN(when.getTime()) ? 'unknown time' : when.toISOString().replace('T', ' ').slice(0, 19)}] ${who}: ${decoded.text || decoder.describe(decoded)}`);
      }
      const body = lines.join('\r\n');
      const filename = `montra-export-${jid.split('@')[0].replace(/[^0-9a-z-]/gi, '') || 'chat'}.txt`;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Content-Disposition': `attachment; filename="${filename}"`, 'X-Content-Type-Options': 'nosniff' });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/api/media') {
      const jid = String(url.searchParams.get('jid') || '');
      const messageId = String(url.searchParams.get('messageId') || '');
      // Archived media is addressed either by its WhatsApp message key or by the
      // archive id the /api/archived-media list hands out; both are legitimate lookups.
      const item = (!messageId && url.searchParams.get('mediaId'))
        ? mediaArchive.getById(String(url.searchParams.get('mediaId')))
        : null;
      if (!jid || (!messageId && !item) || !knownChat(jid)) return sendJson(res, 404, { error: 'Media not found' });
      const resolved = item || mediaArchive.getByKey(jid, messageId);
      const buffer = resolved && !resolved.isStatus ? mediaArchive.readBuffer(resolved) : null;
      if (!resolved || !buffer || (item && item.jid !== jid)) return sendJson(res, 404, { error: 'Archived media is unavailable' });
      return sendBuffer(res, buffer, resolved.mime, resolved.filename, 0);
    }
    if (req.method === 'GET' && url.pathname === '/api/archived-media') {
      const jid = String(url.searchParams.get('jid') || '');
      if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
      const rows = mediaArchive.list().filter(item => item.jid === jid && !item.isStatus).slice(0, 50).map(({ id, kind, filename, mime, size, timestamp, caption }) => ({ id, kind, filename, mime, size, timestamp, caption }));
      return sendJson(res, 200, rows);
    }
    if (req.method === 'POST' && url.pathname === '/api/media/send') {
      if (typeof sendMedia !== 'function') return sendJson(res, 503, { error: 'WhatsApp media sending is not available.' });
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const jid = String(body.jid || '');
        if (!sendableTarget(jid)) return sendJson(res, 400, { error: SEND_TARGET_ERROR });
        const result = await sendMedia(jid, String(body.mediaId || ''), String(body.caption || ''));
        if (!result?.ok) return sendJson(res, 400, { error: result?.error || 'Media could not be sent.' });
        if (result.out) {
          if (!Number(result.out.status)) result.out.status = 2;
          syncStore.recordMessage(result.out);
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message || 'Invalid request.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/media/upload') {
      if (typeof sendMedia !== 'function') return sendJson(res, 503, { error: 'WhatsApp media sending is not available.' });
      const contentType = String(req.headers['content-type'] || '');
      if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) return sendJson(res, 415, { error: 'Expected a multipart file upload.' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_DASHBOARD_UPLOAD_BYTES + 1024 * 1024) return sendJson(res, 413, { error: `Uploads are limited to ${Math.floor(MAX_DASHBOARD_UPLOAD_BYTES / 1024 / 1024)} MB.` });
        chunks.push(chunk);
      }
      let item = null;
      try {
        const request = new Request('http://localhost/upload', { method: 'POST', headers: { 'content-type': contentType }, body: Buffer.concat(chunks) });
        const form = await request.formData();
        const jid = String(form.get('jid') || '');
        const caption = String(form.get('caption') || '');
        const file = form.get('file');
        if (!jid || !knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found.' });
        if (!sendableTarget(jid)) return sendJson(res, 400, { error: SEND_TARGET_ERROR });
        if (!file || typeof file.arrayBuffer !== 'function' || file.size < 1) return sendJson(res, 400, { error: 'Choose a non-empty file.' });
        if (file.size > MAX_DASHBOARD_UPLOAD_BYTES) return sendJson(res, 413, { error: `Uploads are limited to ${Math.floor(MAX_DASHBOARD_UPLOAD_BYTES / 1024 / 1024)} MB.` });
        if (Buffer.byteLength(caption) > 1000) return sendJson(res, 400, { error: 'Caption is too long (maximum 1000 characters).' });
        const mime = String(file.type || 'application/octet-stream').toLowerCase();
        if (mime === 'image/svg+xml' || mime === 'text/html' || mime === 'application/javascript') return sendJson(res, 415, { error: 'This file type cannot be sent from the dashboard.' });
        const kind = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'voice' : 'document';
        item = mediaArchive.saveBuffer(Buffer.from(await file.arrayBuffer()), { jid, filename: file.name || 'upload', mime, kind, caption, source: 'dashboard' });
        if (!item || item.skipped) return sendJson(res, 413, { error: 'File exceeds Montra’s media archive limit.' });
        const result = await sendMedia(jid, item.id, caption);
        if (!result?.ok) { mediaArchive.remove(item.id); return sendJson(res, 400, { error: result?.error || 'Media could not be sent.' }); }
        if (result.out) {
          mediaArchive.linkToMessage(item.id, String(result.out.key?.id || ''));
          if (!Number(result.out.status)) result.out.status = 2;
          syncStore.recordMessage(result.out);
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        if (item?.id) mediaArchive.remove(item.id);
        return sendJson(res, 400, { error: e.message || 'Upload failed.' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/messages') {
      if (typeof sendMessage !== 'function') return sendJson(res, 503, { error: 'WhatsApp sending is not available.' });
      try {
        const body = JSON.parse((await readBody(req, 10000)) || '{}');
        const jid = String(body.jid || '');
        const text = String(body.text || '').trim();
        if (!jid || !text) return sendJson(res, 400, { error: 'Choose a chat and enter a message.' });
        if (!sendableTarget(jid)) return sendJson(res, 400, { error: SEND_TARGET_ERROR });
        let quoted = null;
        if (body.quoted?.id) {
          quoted = syncStore.getMessageById(jid, String(body.quoted.id));
          if (!quoted) return sendJson(res, 400, { error: 'The message you are replying to is no longer available.' });
        }
        const result = quoted ? await sendMessage(jid, text, quoted) : await sendMessage(jid, text);
        if (!result?.ok) return sendJson(res, 400, { error: result?.error || 'Message could not be sent.' });
        if (result.out) {
          if (!Number(result.out.status)) result.out.status = 2;
          syncStore.recordMessage(result.out);
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, e.code === 413 ? 413 : 400, { error: e.message || 'Invalid request.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/messages/react') {
      if (typeof reactToMessage !== 'function') return sendJson(res, 503, { error: 'Reactions are unavailable.' });
      try {
        const body = JSON.parse((await readBody(req, 4000)) || '{}');
        const jid = String(body.jid || '');
        if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
        const row = syncStore.getMessageById(jid, String(body.id || ''));
        if (!row?.key?.id) return sendJson(res, 404, { error: 'Message not found' });
        const emoji = String(body.emoji || '').replace(/[\r\n\t\0]/g, '').slice(0, 32);
        const result = await reactToMessage(jid, row.key, emoji);
        if (!result?.ok) return sendJson(res, 400, { error: result?.error || 'Reaction could not be sent.' });
        if (result.out) syncStore.recordMessage(result.out);
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message || 'Invalid request.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/messages/delete') {
      if (typeof deleteMessage !== 'function') return sendJson(res, 503, { error: 'Message deletion is unavailable.' });
      try {
        const body = JSON.parse((await readBody(req, 4000)) || '{}');
        const jid = String(body.jid || '');
        if (!knownChat(jid)) return sendJson(res, 404, { error: 'Chat not found' });
        const row = syncStore.getMessageById(jid, String(body.id || ''));
        if (!row?.key?.id) return sendJson(res, 404, { error: 'Message not found' });
        if (!row.key.fromMe) return sendJson(res, 400, { error: 'Only messages you sent can be deleted for everyone.' });
        const result = await deleteMessage(jid, row.key);
        if (!result?.ok) return sendJson(res, 400, { error: result?.error || 'Message could not be deleted.' });
        if (result.out) syncStore.recordMessage(result.out);
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message || 'Invalid request.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/autoreply') return sendJson(res, 200, autoReply.getConfig());
    if (req.method === 'POST' && url.pathname === '/api/autoreply') {
      try {
        const body = JSON.parse((await readBody(req, 100000)) || '{}');
        if (typeof body.enabled === 'boolean') autoReply.update({ enabled: body.enabled });
        if (body.action === 'add') autoReply.addRule(body.rule || {});
        else if (body.action === 'remove') {
          const removed = autoReply.removeRule(body.id || body.trigger);
          if (!removed) return sendJson(res, 404, { error: 'Rule not found' });
        } else if (body.action !== undefined && !['add', 'remove'].includes(body.action)) {
          return sendJson(res, 400, { error: 'Unsupported action' });
        } else if (Array.isArray(body.rules)) autoReply.update({ rules: body.rules });
        return sendJson(res, 200, autoReply.getConfig());
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const file = path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'tgAudit.jsonl'); let rows = [];
      try { rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-100).map(x => { try { return JSON.parse(x); } catch { return { raw: x }; } }); } catch { /* ignore */ }
      return sendJson(res, 200, rows.reverse());
    }
    // A known endpoint reached with the wrong verb is a client bug, not a missing page.
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/vendor/')) return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    if (url.pathname !== '/' && url.pathname !== '/index.html') return send(res, 404, 'text/plain; charset=utf-8', 'Not found');

    return send(res, 200, 'text/html; charset=utf-8', readHtml());
  };
  server = http.createServer((req, res) => {
    Promise.resolve(route(req, res)).catch(e => {
      console.error('[Montra] Dashboard request failed:', e && e.message ? e.message : e);
      if (res.headersSent) return res.end();
      sendJson(res, 500, { error: 'Dashboard request failed.' });
    });
  });
  server.on('error', e => console.error('[Montra] Dashboard server error:', e.message));
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`[Montra] Dashboard listening on http://${host}:${address && address.port ? address.port : port}`);
  });
  return server;
}
function summarizeWorkspaceScopes(scopesInput) {
  const list = Array.isArray(scopesInput)
    ? scopesInput.map(s => String(s || '').trim()).filter(Boolean)
    : String(scopesInput || '').split(/\s+/).filter(Boolean);
  return {
    drive: list.some(s => /\/auth\/drive/.test(s)),
    gmail: list.some(s => /mail\.google\.com|\/auth\/gmail/.test(s)),
    contacts: list.some(s => /\/auth\/(contacts|directory\.readonly|user\.)/.test(s)),
    calendar: list.some(s => /\/auth\/calendar/.test(s)),
    tasks: list.some(s => /\/auth\/tasks/.test(s)),
    chat: list.some(s => /\/auth\/chat/.test(s))
  };
}
function parseTokenInfoResponse(ok, data, nowMs = Date.now()) {
  const checkedAt = new Date(nowMs).toISOString();
  if (!ok || !data || data.error || data.error_description) {
    return {
      valid: false,
      status: 'expired',
      reason: String((data && (data.error_description || data.error)) || 'OAuth token is expired or invalid.'),
      expiresIn: 0,
      expiresAt: null,
      expiresAtMs: 0,
      checkedAt,
      scopeCount: 0,
      services: summarizeWorkspaceScopes([]),
      email: ''
    };
  }
  const expiresIn = Math.max(0, Math.floor(Number(data.expires_in) || 0));
  const expiresAtMs = expiresIn > 0 ? nowMs + expiresIn * 1000 : 0;
  const scopes = String(data.scope || '').split(/\s+/).filter(Boolean);
  const services = summarizeWorkspaceScopes(scopes);
  const status = expiresIn <= 0 ? 'expired' : (expiresIn <= 300 ? 'expiring_soon' : 'valid');
  return {
    valid: expiresIn > 0,
    status,
    reason: '',
    expiresIn,
    expiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
    expiresAtMs,
    checkedAt,
    scopeCount: scopes.length,
    services,
    email: String(data.email || '')
  };
}
function recordPresence(jid, presence, lastSeen) {
  if (!jid) return;
  presenceCache.set(String(jid), { presence: String(presence || 'unknown'), lastSeen: Number(lastSeen || 0), at: Date.now() });
  if (presenceCache.size > 500) presenceCache.delete(presenceCache.keys().next().value);
}
function stop() {
  systemMonitor.stop();
  workspaceTokenManager.stop();
  facebookBot.stop();
  if (!server) return;
  const active = server;
  server = null;
  active.close();
  // Tests and local restarts should not wait on keep-alive fetch sockets.
  active.closeAllConnections?.();
}
module.exports = { start, stop, recordPresence, summarizeWorkspaceScopes, parseTokenInfoResponse };

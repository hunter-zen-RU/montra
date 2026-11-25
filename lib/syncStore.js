/** Local persistent cache for WhatsApp chats, contacts and message history. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// MONTRA_SYNC_STORE lets tests run against a throwaway cache instead of the live one.
const FILE = process.env.MONTRA_SYNC_STORE || path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'syncStore.json');
const MAX_MESSAGES_PER_CHAT = Math.max(50, Number(process.env.SYNC_MAX_MESSAGES_PER_CHAT) || 500);
const RETENTION_DAYS = Math.max(0, Number(process.env.SYNC_RETENTION_DAYS) || 0);
function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { chats: {}, contacts: {}, messages: {} }; }
}
let db = read();
for (const k of ['chats', 'contacts', 'messages']) if (!db[k] || typeof db[k] !== 'object') db[k] = {};
// The dashboard reads every cached history on one request, so a value that is not a list has
// to go now rather than throw later; the chat simply re-caches as new messages arrive.
for (const [jid, rows] of Object.entries(db.messages)) if (!Array.isArray(rows)) delete db.messages[jid];
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = `${FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 }); fs.renameSync(tmp, FILE); }
    catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } console.error('[Montra] Sync cache save failed:', e.message); }
  }, 150);
  saveTimer.unref?.();
}
function upsertContacts(items = []) { for (const c of items) { const id = c?.id || c?.jid; if (!id) continue; db.contacts[id] = { ...(db.contacts[id] || {}), ...c, id, updatedAt: Date.now() }; } save(); }
function upsertChats(items = []) { for (const c of items) { const id = c?.id || c?.jid; if (!id) continue; db.chats[id] = { ...(db.chats[id] || {}), ...c, id, updatedAt: Date.now() }; } save(); }
function recordMessage(m) {
  const jid = m?.key?.remoteJid; const id = m?.key?.id;
  if (!jid || !id || jid === 'status@broadcast' || jid.endsWith('@broadcast')) return;
  const list = db.messages[jid] || (db.messages[jid] = []);
  if (list.some(x => x?.key?.id === id)) return;
  list.push(m); list.sort((a,b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
  if (list.length > MAX_MESSAGES_PER_CHAT) list.splice(0, list.length - MAX_MESSAGES_PER_CHAT);
  db.chats[jid] = { ...(db.chats[jid] || {}), id: jid, lastMessageAt: Number(m.messageTimestamp || Date.now()/1000) };
  save();
}
function recordMessages(items = []) { for (const m of items) recordMessage(m); }
function updateMessage(jid, id, patch = {}) {
  const message = (db.messages[jid] || []).find(row => row?.key?.id === id);
  if (!message || !patch || typeof patch !== 'object') return false;
  Object.assign(message, patch);
  save();
  return true;
}
// Callers ask for a page size; the ceiling only stops one request from materialising the
// whole cache at once, so it has to stay above the dashboard's largest page (export = 200).
function getMessages(jid, limit = 20) { return (db.messages[jid] || []).slice(-Math.max(1, Math.min(1000, limit))).reverse(); }
function getMessageById(jid, id) { return (db.messages[String(jid)] || []).find(row => row?.key?.id === String(id)) || null; }
function getMessage(jid, index) { const a = getMessages(jid, Math.max(index, 1)); return a[index - 1] || null; }
function getChats() { return Object.values(db.chats); }
function chatKind(jid) {
  const j = String(jid || '');
  if (j.endsWith('@newsletter')) return 'channel';
  if (j.endsWith('@g.us')) return 'group';
  if (j.endsWith('@broadcast')) return 'broadcast';
  return 'chat';
}
function searchMessages(query, options = {}) {
  const q = String(query || '').trim().toLowerCase();
  const sender = String(options.sender || '').trim().toLowerCase();
  const after = options.after ? new Date(options.after).getTime() / 1000 : 0;
  const before = options.before ? new Date(options.before).getTime() / 1000 : Infinity;
  const out = [];
  for (const [jid, rows] of Object.entries(db.messages)) for (const m of rows) {
    const body = JSON.stringify(m.message || {}).toLowerCase();
    const name = String(m.pushName || m.verifiedBizName || '').toLowerCase();
    const ts = Number(m.messageTimestamp || 0);
    if (q && !body.includes(q)) continue;
    if (sender && !name.includes(sender) && !String(m.key?.participant || m.key?.remoteJid || '').toLowerCase().includes(sender)) continue;
    if (ts && (ts < after || ts > before)) continue;
    out.push({ jid, message: m, ts });
  }
  return out.sort((a,b)=>b.ts-a.ts).slice(0,100);
}
function pruneExpired(now = Date.now()) {
  if (!RETENTION_DAYS) return 0;
  const cutoff = Math.floor(now / 1000 - RETENTION_DAYS * 86400); let removed = 0;
  for (const [jid, rows] of Object.entries(db.messages)) { const keep = rows.filter(m => !m.messageTimestamp || Number(m.messageTimestamp) >= cutoff); removed += rows.length - keep.length; db.messages[jid] = keep; }
  if (removed) save(); return removed;
}
function syncStatus() { return { ...stats(), lastUpdatedAt: Math.max(0, ...Object.values(db.chats).map(c => Number(c.updatedAt || 0))), retentionDays: RETENTION_DAYS, maxMessagesPerChat: MAX_MESSAGES_PER_CHAT }; }
function getContacts() { return db.contacts; }
function stats() { return { chats: Object.keys(db.chats).length, contacts: Object.keys(db.contacts).length, messages: Object.values(db.messages).reduce((n,a)=>n+a.length,0) }; }
module.exports = { upsertContacts, upsertChats, recordMessage, recordMessages, updateMessage, getMessages, getMessageById, getMessage, getChats, getContacts, stats, searchMessages, pruneExpired, syncStatus, chatKind };

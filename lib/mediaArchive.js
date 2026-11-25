'use strict';
/** Bounded local archive for downloadable WhatsApp media (including statuses). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decode, unwrapLayers } = require('./messageDecoder');

// MONTRA_DATA_DIR redirects the whole writable data folder; tests and preview runs use it
// so they never touch the cache or media index of a live installation.
const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const INDEX_FILE = path.join(DATA_DIR, 'media-index.json');
const MiB = 1024 * 1024;
const MAX_TOTAL_BYTES = Math.max(1, Number(process.env.MEDIA_ARCHIVE_MAX_MB) || 500) * MiB;
const MAX_FILE_BYTES = Math.max(1, Number(process.env.MEDIA_ARCHIVE_MAX_FILE_MB) || 200) * MiB;
const MEDIA_KINDS = new Set(['image', 'video', 'voice', 'sticker', 'document']);
let queue = Promise.resolve();

function safeName(value) {
  return String(value || 'media').replace(/[\\/:*?"<>|\r\n\0]/g, '_').slice(0, 90) || 'media';
}
function readIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(data.items) ? data.items.filter(x => x && typeof x.id === 'string' && typeof x.path === 'string').map(x => ({ ...x, path: path.join(MEDIA_DIR, path.basename(x.path)) })) : [];
  } catch { return []; }
}
let items = readIndex();
function exists(item) { try { return fs.existsSync(item.path) && fs.statSync(item.path).isFile(); } catch { return false; } }
items = items.filter(exists);
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${INDEX_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, maxTotalBytes: MAX_TOTAL_BYTES, maxFileBytes: MAX_FILE_BYTES, items }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, INDEX_FILE);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}
function usedBytes() { return items.filter(exists).reduce((n, item) => n + (Number(item.size) || 0), 0); }
function getByKey(jid, messageId) { return items.find(x => x.jid === jid && x.messageId === messageId && exists(x)) || null; }
function getById(id) { return items.find(x => x.id === id && exists(x)) || null; }
function linkToMessage(id, messageId) {
  const item = getById(id);
  if (!item || !messageId) return false;
  item.messageId = String(messageId);
  persist();
  return true;
}
function list(options = {}) {
  const rows = items.filter(exists).slice().sort((a,b) => b.savedAt - a.savedAt);
  return options.statusOnly ? rows.filter(x => x.isStatus) : rows;
}
function maxLimitBytes() {
  const mb = Number(process.env.MEDIA_ARCHIVE_MAX_MB);
  return Math.max(1, Number.isFinite(mb) && mb > 0 ? mb : 500) * MiB;
}
function stats() {
  const active = items.filter(exists);
  const used = active.reduce((n, item) => n + (Number(item.size) || 0), 0);
  const limit = maxLimitBytes();
  const maxMb = Number((limit / MiB).toFixed(2));
  const usedMb = Number((used / MiB).toFixed(2));
  const percentUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
  const statusOnlyCount = active.filter(x => x.isStatus).length;
  return {
    files: active.length,
    usedBytes: used,
    usedMb,
    maxTotalBytes: limit,
    maxMb,
    maxFileBytes: MAX_FILE_BYTES,
    freeBytes: Math.max(0, limit - used),
    percentUsed,
    exceeded: used >= limit,
    statusOnlyCount,
    chatMediaCount: Math.max(0, active.length - statusOnlyCount)
  };
}
function evictUntilFits(requiredBytes) {
  const limit = maxLimitBytes();
  while (items.length && usedBytes() + requiredBytes > limit) {
    items.sort((a,b) => a.savedAt - b.savedAt);
    const oldest = items.shift();
    try { fs.rmSync(oldest.path, { force: true }); } catch { /* ignore */ }
  }
}
function filenameFor(mek, decoded, isStatus) {
  const extByMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf' };
  const mime = decoded?.mime || 'application/octet-stream';
  let base = decoded?.fileName || `${isStatus ? 'status' : decoded?.kind || 'media'}-${mek?.key?.id || Date.now()}`;
  base = safeName(base);
  if (!path.extname(base)) base += extByMime[mime] || '';
  return base || 'media.bin';
}
async function archiveMessage(sock, mek, options = {}) {
  const jid = mek?.key?.remoteJid;
  const messageId = mek?.key?.id;
  if (!jid || !messageId || !mek?.message) return null;
  const isStatus = options.isStatus ?? jid === 'status@broadcast';
  const decoded = decode(mek.message);
  if (!decoded || !MEDIA_KINDS.has(decoded.kind)) return null;
  // History sync and partially downloaded messages can advertise media while
  // carrying no usable encryption key. Baileys throws before it can request a
  // reupload in that case, so skip cleanly instead of logging a download error.
  const { inner } = unwrapLayers(mek.message);
  const mediaField = { image: 'imageMessage', video: 'videoMessage', voice: 'audioMessage', sticker: 'stickerMessage', document: 'documentMessage' }[decoded.kind];
  const mediaKey = inner?.[mediaField]?.mediaKey;
  // Live statuses can arrive without a usable mediaKey hint yet still be downloadable
  // through Baileys' reupload path. Only history-sync callers keep the strict guard.
  if ((!Buffer.isBuffer(mediaKey) || mediaKey.length === 0) && !options.attemptWithoutKey) return { skipped: true, reason: 'media_key_missing' };
  const prior = getByKey(jid, messageId);
  if (prior) return prior;
  const job = async () => {
    const existing = getByKey(jid, messageId);
    if (existing) return existing;
    const hinted = Number(decoded.fileLength || decoded.fileSize || 0);
    if (hinted > MAX_FILE_BYTES) return { skipped: true, reason: 'file_limit', size: hinted };
    if (!sock) return { skipped: true, reason: 'not_connected' };
    let buffer;
    try {
      const { downloadMediaMessage } = require('@whiskeysockets/baileys');
      buffer = await downloadMediaMessage(mek, 'buffer', {}, {
        logger: require('pino')({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage
      });
    } catch (error) {
      console.warn(`[Montra] Media archive download failed (${messageId}): ${error.message}`);
      return { skipped: true, reason: 'download_failed', error: error.message };
    }
    if (!buffer || !buffer.length) return { skipped: true, reason: 'empty' };
    if (buffer.length > MAX_FILE_BYTES) return { skipped: true, reason: 'file_limit', size: buffer.length };
    if (buffer.length > maxLimitBytes()) return { skipped: true, reason: 'total_limit', size: buffer.length };
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    evictUntilFits(buffer.length);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const filename = filenameFor(mek, decoded, isStatus);
    const diskName = `${id}-${filename}`;
    const filePath = path.join(MEDIA_DIR, diskName);
    fs.writeFileSync(filePath, buffer, { mode: 0o600, flag: 'wx' });
    const item = {
      id, jid, messageId, participant: mek.key?.participant || null,
      isStatus: Boolean(isStatus), kind: decoded.kind, filename,
      mime: decoded.mime || 'application/octet-stream', size: buffer.length,
      timestamp: Number(mek.messageTimestamp || 0) * (Number(mek.messageTimestamp || 0) < 1e12 ? 1000 : 1),
      savedAt: Date.now(), path: filePath, caption: String(decoded.text || '').slice(0, 1000),
      fromMe: Boolean(mek.key?.fromMe)
    };
    items.push(item);
    persist();
    return item;
  };
  const result = queue.then(job, job);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
function readBuffer(itemOrId) {
  const item = typeof itemOrId === 'string' ? getById(itemOrId) : itemOrId;
  if (!item || !exists(item)) return null;
  // The file can be evicted or pruned between the check and the read; callers already turn
  // null into "archived media is unavailable" rather than a request that never answers.
  try { return fs.readFileSync(item.path); } catch { return null; }
}

function saveBuffer(buffer, metadata = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { skipped: true, reason: 'empty' };
  if (buffer.length > MAX_FILE_BYTES) return { skipped: true, reason: 'file_limit', size: buffer.length };
  if (buffer.length > maxLimitBytes()) return { skipped: true, reason: 'total_limit', size: buffer.length };
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  evictUntilFits(buffer.length);
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const filename = safeName(metadata.filename || 'telegram-media');
  const filePath = path.join(MEDIA_DIR, `${id}-${filename}`);
  fs.writeFileSync(filePath, buffer, { mode: 0o600, flag: 'wx' });
  const item = {
    id, jid: String(metadata.jid || metadata.chatId || 'local'),
    messageId: String(metadata.messageId || `local:${id}`), participant: null,
    isStatus: Boolean(metadata.isStatus), kind: String(metadata.kind || 'document'), filename,
    mime: String(metadata.mime || 'application/octet-stream'), size: buffer.length,
    timestamp: Date.now(), savedAt: Date.now(), path: filePath,
    caption: String(metadata.caption || '').slice(0, 1000), fromMe: true,
    source: String(metadata.source || 'telegram')
  };
  items.push(item);
  persist();
  return item;
}

function remove(id) {
  const index = items.findIndex(x => x.id === id);
  if (index < 0) return false;
  const [item] = items.splice(index, 1);
  try { fs.rmSync(item.path, { force: true }); } catch { /* ignore */ }
  persist();
  return true;
}
function prune() {
  const before = items.length;
  items = items.filter(exists);
  // Loading already drops orphan records from memory, so compare against the file to rewrite them away.
  if (items.length !== before || items.length !== readIndex().length) persist();
  return before - items.length;
}
function clearCache({ onlyIfExceeded = false, statusOnly = false } = {}) {
  const current = stats();
  if (onlyIfExceeded && !current.exceeded) {
    return { cleared: false, reason: 'not_exceeded', clearedFiles: 0, freedBytes: 0, stats: current };
  }
  const keep = [];
  let clearedFiles = 0;
  let freedBytes = 0;
  for (const item of items) {
    if (statusOnly && !item.isStatus) {
      keep.push(item);
      continue;
    }
    clearedFiles += 1;
    freedBytes += Number(item.size) || 0;
    try { fs.rmSync(item.path, { force: true }); } catch { /* ignore */ }
  }
  if (!statusOnly) {
    try {
      if (fs.existsSync(MEDIA_DIR)) {
        for (const name of fs.readdirSync(MEDIA_DIR)) {
          const p = path.join(MEDIA_DIR, name);
          try {
            if (fs.statSync(p).isFile()) fs.rmSync(p, { force: true });
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  items = keep;
  persist();
  const nextStats = stats();
  return {
    cleared: true,
    clearedFiles,
    freedBytes,
    remainingFiles: nextStats.files,
    remainingBytes: nextStats.usedBytes,
    stats: nextStats
  };
}
module.exports = { archiveMessage, saveBuffer, linkToMessage, getByKey, getById, list, stats, readBuffer, remove, prune, clearCache, maxLimitBytes, MAX_TOTAL_BYTES, MAX_FILE_BYTES, MEDIA_DIR };

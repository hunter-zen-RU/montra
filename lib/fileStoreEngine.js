'use strict';
/**
 * Sandboxed file store for the Telegram file manager.
 *
 * Every path is resolved inside the store root before it reaches the disk, and symlinked
 * segments are refused, so the bridge can never be asked to read, overwrite or delete the
 * sync cache, the media archive, the configuration files or the linked-device session keys
 * that live next to the store.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MiB = 1024 * 1024;
const ROOT = path.resolve(process.env.MONTRA_FILE_STORE_DIR
  || path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'files'));
const MAX_FILE_BYTES = Math.max(1, Number(process.env.FILE_STORE_MAX_FILE_MB) || 50) * MiB;
const MAX_TOTAL_BYTES = Math.max(1, Number(process.env.FILE_STORE_MAX_TOTAL_MB) || 500) * MiB;
const MAX_ENTRIES = Math.max(2, Number(process.env.FILE_STORE_MAX_ENTRIES) || 2000);
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const LIST_LIMIT = 200;

class FileStoreError extends Error {
  constructor(message) { super(message); this.name = 'FileStoreError'; }
}

// A name is whatever survives the sanitiser: no separators, no traversal token, no control
// characters, nothing that Windows would reject or reinterpret.
function safeName(value, fallback = 'file') {
  const base = String(value ?? '')
    .replace(/[\\/:*?"<>|\r\n\0]/g, '_')
    .replace(/\.\./g, '_')
    .trim()
    .slice(0, 120);
  return base || fallback;
}

function relOf(absolute) {
  const relative = path.relative(ROOT, absolute);
  return relative ? relative.split(path.sep).join('/') : '';
}

function toAbsolute(target, { allowRoot = false } = {}) {
  const raw = String(target ?? '').trim();
  if (!raw) throw new FileStoreError('No path was given.');
  if (path.isAbsolute(raw)) {
    const absolute = path.resolve(raw);
    if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) {
      throw new FileStoreError(`Only paths inside /${relOf(ROOT) || '.'} are reachable.`);
    }
    if (absolute === ROOT && !allowRoot) throw new FileStoreError('The file store root cannot be used as a file target.');
    return absolute;
  }
  const segments = [];
  for (const part of raw.replace(/^\.\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!segments.length) throw new FileStoreError('Path escapes the file store.');
      segments.pop();
      continue;
    }
    const name = safeName(part, '');
    if (!name) throw new FileStoreError(`Invalid path segment: ${part}`);
    segments.push(name);
  }
  if (!segments.length && !allowRoot) throw new FileStoreError('The file store root cannot be used as a file target.');
  return path.resolve(ROOT, ...segments);
}

// lstat every existing segment: a link inside the store would otherwise walk out of it.
function assertNoSymlink(absolute) {
  const relative = relOf(absolute);
  if (!relative) return;
  let cursor = ROOT;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch { return; }
    if (stat.isSymbolicLink()) throw new FileStoreError(`Refusing to follow the symlink at /${relOf(cursor)}.`);
  }
}

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true, mode: DIR_MODE });
  return ROOT;
}

function lstatOrNull(absolute) { try { return fs.lstatSync(absolute); } catch { return null; } }

function entryOf(absolute, stat = lstatOrNull(absolute)) {
  const dir = stat ? stat.isDirectory() : false;
  const rel = relOf(absolute);
  return {
    name: rel ? rel.split('/').pop() : '',
    path: rel,
    absolute,
    dir,
    size: dir ? 0 : (stat ? Number(stat.size) || 0 : 0),
    mtimeMs: stat ? Number(stat.mtimeMs) || 0 : 0,
    mode: stat ? (stat.mode & 0o777).toString(8) : ''
  };
}

function requireExisting(absolute, expect) {
  assertNoSymlink(absolute);
  const stat = lstatOrNull(absolute);
  if (!stat) throw new FileStoreError(`Not found: /${relOf(absolute)}`);
  if (expect === 'file' && !stat.isFile()) throw new FileStoreError(`Not a file: /${relOf(absolute)}`);
  if (expect === 'directory' && !stat.isDirectory()) throw new FileStoreError(`Not a folder: /${relOf(absolute)}`);
  return stat;
}

function list(target = '.') {
  const absolute = toAbsolute(target, { allowRoot: true });
  requireExisting(absolute, 'directory');
  const names = fs.readdirSync(absolute);
  const entries = [];
  for (const name of names) {
    const child = path.join(absolute, name);
    const stat = lstatOrNull(child);
    if (!stat) continue;
    // Symlinks are reported but never entered, so a listing can show a problem without
    // ever reading through it.
    if (stat.isSymbolicLink()) entries.push({ ...entryOf(child, stat), link: true });
    else entries.push(entryOf(child, stat));
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { root: relOf(absolute) || '.', total: entries.length, entries: entries.slice(0, LIST_LIMIT) };
}

function stat(target) {
  const absolute = toAbsolute(target);
  return entryOf(absolute, requireExisting(absolute));
}

function exists(target) {
  try { return Boolean(lstatOrNull(toAbsolute(target))); } catch { return false; }
}

function read(target) {
  const absolute = toAbsolute(target);
  requireExisting(absolute, 'file');
  try { return fs.readFileSync(absolute); }
  catch (e) { throw new FileStoreError(`Could not read /${relOf(absolute)}: ${e.message}`); }
}

function usage() {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  const walk = (dir) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const child = path.join(dir, name);
      const stat = lstatOrNull(child);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { dirs++; walk(child); }
      else if (stat.isFile()) { files++; bytes += Number(stat.size) || 0; }
    }
  };
  if (lstatOrNull(ROOT)?.isDirectory()) walk(ROOT);
  return { files, dirs, bytes, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES, maxEntries: MAX_ENTRIES, freeBytes: Math.max(0, MAX_TOTAL_BYTES - bytes), root: ROOT };
}

function write(target, buffer, { overwrite = false } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new FileStoreError('Nothing to write: the upload was empty.');
  const absolute = toAbsolute(target);
  assertNoSymlink(absolute);
  if (buffer.length > MAX_FILE_BYTES) {
    throw new FileStoreError(`File is ${(buffer.length / MiB).toFixed(1)} MB; the per-file limit is ${Math.round(MAX_FILE_BYTES / MiB)} MB.`);
  }
  const current = lstatOrNull(absolute);
  if (current?.isDirectory()) throw new FileStoreError(`/${relOf(absolute)} is a folder, not a file.`);
  if (current && !overwrite) throw new FileStoreError(`Already exists: /${relOf(absolute)} — resend with "replace".`);
  const needed = (buffer.length - (current?.isFile() ? Number(current.size) || 0 : 0));
  const used = usage();
  if (used.bytes + Math.max(0, needed) > MAX_TOTAL_BYTES) {
    throw new FileStoreError(`File store is full: ${(used.bytes / MiB).toFixed(1)} MB of ${Math.round(MAX_TOTAL_BYTES / MiB)} MB used.`);
  }
  if (!current && used.files + used.dirs + 1 > used.maxEntries) {
    throw new FileStoreError(`Entry limit (${used.maxEntries}) reached — delete something first.`);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: DIR_MODE });
  const temp = `${absolute}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, buffer, { mode: FILE_MODE, flag: 'wx' });
    fs.renameSync(temp, absolute);
  } catch (e) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw new FileStoreError(`Write failed: ${e.message}`);
  }
  return entryOf(absolute);
}

function mkdir(target) {
  const absolute = toAbsolute(target);
  assertNoSymlink(absolute);
  const current = lstatOrNull(absolute);
  if (current?.isDirectory()) return entryOf(absolute, current);
  if (current) throw new FileStoreError(`A file already occupies /${relOf(absolute)}.`);
  fs.mkdirSync(absolute, { recursive: true, mode: DIR_MODE });
  return entryOf(absolute);
}

function remove(target, { recursive = false } = {}) {
  const absolute = toAbsolute(target);
  const stat = requireExisting(absolute);
  if (stat.isDirectory()) {
    if (!recursive) {
      const leftover = fs.readdirSync(absolute);
      if (leftover.length) throw new FileStoreError(`Folder /${relOf(absolute)} is not empty — delete the folder to remove it with its contents.`);
    }
    fs.rmSync(absolute, { recursive: true, force: true });
    return { removed: relOf(absolute), recursive: Boolean(recursive) };
  }
  fs.rmSync(absolute, { force: true });
  return { removed: relOf(absolute), size: Number(stat.size) || 0 };
}

function move(from, to) {
  const source = toAbsolute(from);
  const destination = toAbsolute(to);
  requireExisting(source);
  assertNoSymlink(destination);
  if (lstatOrNull(destination)) throw new FileStoreError(`Target already exists: /${relOf(destination)}`);
  if (source === destination) throw new FileStoreError('Source and target are the same path.');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: DIR_MODE });
  fs.renameSync(source, destination);
  return entryOf(destination);
}

function copy(from, to) {
  const source = toAbsolute(from);
  const destination = toAbsolute(to);
  const stat = requireExisting(source, 'file');
  assertNoSymlink(destination);
  if (lstatOrNull(destination)) throw new FileStoreError(`Target already exists: /${relOf(destination)}`);
  const size = Number(stat.size) || 0;
  if (size > MAX_FILE_BYTES) throw new FileStoreError(`File is larger than the per-file limit.`);
  const used = usage();
  if (used.bytes + size > used.maxTotalBytes) throw new FileStoreError('Not enough quota left in the file store.');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: DIR_MODE });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, FILE_MODE);
  return entryOf(destination);
}

function hash(target) {
  const absolute = toAbsolute(target);
  requireExisting(absolute, 'file');
  return crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
}

// Depth-first walk for /fstree; symlinked directories are never entered.
function tree(target = '.', depth = 3) {
  const absolute = toAbsolute(target, { allowRoot: true });
  requireExisting(absolute, 'directory');
  const lines = [];
  const walk = (dir, level) => {
    if (level > Math.max(0, Math.min(depth, 6))) return;
    const names = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    for (const name of names) {
      const child = path.join(dir, name);
      const stat = lstatOrNull(child);
      if (!stat) continue;
      if (stat.isSymbolicLink()) lines.push(`${'  '.repeat(level)}${name} -> (symlink, not followed)`);
      else if (stat.isDirectory()) {
        lines.push(`${'  '.repeat(level)}${name}/`);
        if (lines.length < LIST_LIMIT) walk(child, level + 1);
      } else lines.push(`${'  '.repeat(level)}${name} (${formatBytes(Number(stat.size) || 0)})`);
      if (lines.length >= LIST_LIMIT) { lines.push('… (truncated)'); return; }
    }
  };
  walk(absolute, 0);
  return { root: relOf(absolute) || '.', lines };
}

// Breadth-first search for /fsfind so matches at the top of the store are reported first.
function search(query, limit = 30) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) throw new FileStoreError('Give a name fragment to search for.');
  const matches = [];
  const queue = [ROOT];
  if (!fs.existsSync(ROOT)) return { total: 0, matches };
  while (queue.length && matches.length < Math.max(1, Math.min(limit, LIST_LIMIT))) {
    const dir = queue.shift();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const child = path.join(dir, name);
      const stat = lstatOrNull(child);
      if (!stat || stat.isSymbolicLink()) continue;
      if (name.toLowerCase().includes(needle)) matches.push(entryOf(child, stat));
      if (stat.isDirectory()) queue.push(child);
      if (matches.length >= Math.max(1, Math.min(limit, LIST_LIMIT))) break;
    }
  }
  return { total: matches.length, matches };
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function describeError(error) {
  if (error instanceof FileStoreError) return error.message;
  return String(error?.message || error || 'File store operation failed.');
}

module.exports = {
  ROOT, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_ENTRIES, LIST_LIMIT,
  FileStoreError, describeError, entryOf, exists, formatBytes, list, mkdir, move, copy,
  read, remove, safeName, search, stat, hash, toAbsolute, tree, usage, write,
  ensureRoot, relOf
};

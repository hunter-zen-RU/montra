/**
 * Private local snapshots of configuration and cache files; never copies linked-device session keys.
 * Supports optional AES-256-GCM symmetric encryption for backup tarballs.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const timeEngine = require('./timeEngine');

const DATA = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const BACKUPS = path.join(DATA, 'backups');
const CONFIG_FILE = path.join(DATA, 'backupConfig.json');
const FREQUENCIES = ['hourly', 'every6h', 'every12h', 'daily', 'weekly'];
// Only non-secret configuration/state files are snapshotted; WhatsApp creds and facebookAppState.json are excluded.
const FILES = [
  'syncStore.json',
  'telegramConfig.json',
  'montraAutoReply.json',
  'cronJobs.json',
  'dashboardPrefs.json',
  'contactCrm.json',
  'timeConfig.json',
  'backupConfig.json',
  'botFleet.json',
  'tgAudit.jsonl'
];

function defaultBackupHour() {
  const raw = Number(process.env.BACKUP_HOUR);
  if (Number.isInteger(raw) && raw >= 0 && raw <= 23) return raw;
  return 3;
}

function defaultKeepCount() {
  const raw = Number(process.env.BACKUP_KEEP_COUNT);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 60) return raw;
  return 7;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

let cachedConfig = null;
function loadRawConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch { /* ignore */ }
  return null;
}

function getScheduleConfig() {
  const file = cachedConfig || loadRawConfig();
  if (file) cachedConfig = file;
  const hour = Number.isInteger(Number(file?.backupHour)) && Number(file.backupHour) >= 0 && Number(file.backupHour) <= 23
    ? Number(file.backupHour)
    : defaultBackupHour();
  const frequency = FREQUENCIES.includes(file?.frequency) ? file.frequency : 'daily';
  const enabled = typeof file?.enabled === 'boolean' ? file.enabled : true;
  const keepCount = Number.isInteger(Number(file?.keepCount)) && Number(file.keepCount) >= 1 && Number(file.keepCount) <= 60
    ? Number(file.keepCount)
    : defaultKeepCount();
  const weeklyDay = Number.isInteger(Number(file?.weeklyDay)) && Number(file.weeklyDay) >= 0 && Number(file.weeklyDay) <= 6
    ? Number(file.weeklyDay)
    : 0;

  return {
    enabled,
    backupHour: hour,
    frequency,
    keepCount,
    weeklyDay,
    lastRunAt: file?.lastRunAt || null,
    updatedAt: file?.updatedAt || null,
    frequencies: FREQUENCIES,
    source: file ? 'file' : 'env_or_default'
  };
}

function setScheduleConfig(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Configuration payload must be an object.');
  }
  const current = getScheduleConfig();
  const next = {
    enabled: current.enabled,
    backupHour: current.backupHour,
    frequency: current.frequency,
    keepCount: current.keepCount,
    weeklyDay: current.weeklyDay,
    lastRunAt: current.lastRunAt || null,
    updatedAt: new Date().toISOString()
  };

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
    next.enabled = patch.enabled;
  }
  if (patch.backupHour !== undefined) {
    const h = Number(patch.backupHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) {
      throw new Error('BACKUP_HOUR must be a whole hour between 0 and 23.');
    }
    next.backupHour = h;
  }
  if (patch.frequency !== undefined) {
    const f = String(patch.frequency).trim();
    if (!FREQUENCIES.includes(f)) {
      throw new Error(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
    }
    next.frequency = f;
  }
  if (patch.keepCount !== undefined) {
    const k = Number(patch.keepCount);
    if (!Number.isInteger(k) || k < 1 || k > 60) {
      throw new Error('keepCount must be an integer between 1 and 60.');
    }
    next.keepCount = k;
  }
  if (patch.weeklyDay !== undefined) {
    const wd = Number(patch.weeklyDay);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) {
      throw new Error('weeklyDay must be an integer between 0 (Sunday) and 6 (Saturday).');
    }
    next.weeklyDay = wd;
  }

  writeJsonAtomic(CONFIG_FILE, next);
  cachedConfig = next;
  return getScheduleConfig();
}

function recordScheduleRun(marker) {
  const current = getScheduleConfig();
  const next = {
    enabled: current.enabled,
    backupHour: current.backupHour,
    frequency: current.frequency,
    keepCount: current.keepCount,
    weeklyDay: current.weeklyDay,
    lastRunAt: new Date().toISOString(),
    lastMarker: String(marker || ''),
    updatedAt: current.updatedAt || new Date().toISOString()
  };
  writeJsonAtomic(CONFIG_FILE, next);
  cachedConfig = next;
}

function createBackup(passphrase = null) {
  fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUPS, `snapshot-${stamp}`);
  fs.mkdirSync(dir, { mode: 0o700 });

  const copied = [];
  const payloadData = {};

  for (const name of FILES) {
    const src = path.join(DATA, name);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(dir, name));
    try { fs.chmodSync(path.join(dir, name), 0o600); } catch { /* ignore */ }
    copied.push(name);
    if (passphrase) {
      try { payloadData[name] = fs.readFileSync(src, 'utf8'); } catch { /* ignore */ }
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    files: copied,
    excludesSessionCredentials: true,
    encrypted: Boolean(passphrase)
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  let encryptedFile = null;
  if (passphrase) {
    const bundleJson = JSON.stringify({ manifest, files: payloadData });
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(bundleJson, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const outputBuffer = Buffer.concat([salt, iv, tag, encrypted]);
    encryptedFile = path.join(BACKUPS, `snapshot-${stamp}.enc`);
    fs.writeFileSync(encryptedFile, outputBuffer, { mode: 0o600 });
  }

  const cfg = getScheduleConfig();
  pruneBackups(cfg.keepCount || 7);
  return { directory: dir, files: copied, encryptedFile };
}

function decryptBackup(encryptedFilePath, passphrase) {
  if (!fs.existsSync(encryptedFilePath)) throw new Error('Backup file does not exist');
  const buffer = fs.readFileSync(encryptedFilePath);
  if (buffer.length < 44) throw new Error('Corrupted or invalid encrypted backup file');

  const salt = buffer.subarray(0, 16);
  const iv = buffer.subarray(16, 28);
  const tag = buffer.subarray(28, 44);
  const ciphertext = buffer.subarray(44);

  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function listBackups() {
  fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  const entries = fs.readdirSync(BACKUPS, { withFileTypes: true });
  const snapshots = [];

  for (const entry of entries) {
    const fullPath = path.join(BACKUPS, entry.name);
    const stat = fs.statSync(fullPath);
    if (entry.isDirectory() && entry.name.startsWith('snapshot-')) {
      let fileCount = 0;
      try { fileCount = fs.readdirSync(fullPath).length; } catch { /* ignore */ }
      snapshots.push({
        id: entry.name,
        type: 'directory',
        name: entry.name,
        path: fullPath,
        size: stat.size,
        files: fileCount,
        encrypted: false,
        createdAt: stat.mtime
      });
    } else if (entry.isFile() && entry.name.endsWith('.enc')) {
      snapshots.push({
        id: entry.name,
        type: 'encrypted_archive',
        name: entry.name,
        path: fullPath,
        size: stat.size,
        encrypted: true,
        createdAt: stat.mtime
      });
    }
  }

  return snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function pruneBackups(keep = 7) {
  fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
  const dirs = fs.readdirSync(BACKUPS, { withFileTypes: true })
    .filter(x => (x.isDirectory() && x.name.startsWith('snapshot-')) || (x.isFile() && x.name.endsWith('.enc')))
    .map(x => ({ name: x.name, isDir: x.isDirectory(), time: fs.statSync(path.join(BACKUPS, x.name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  const toRemove = dirs.slice(Math.max(1, keep));
  for (const d of toRemove) {
    const target = path.join(BACKUPS, d.name);
    if (d.isDir) {
      fs.rmSync(target, { recursive: true, force: true });
    } else {
      fs.rmSync(target, { force: true });
    }
  }
  return toRemove.length;
}

function windowKeyFor(nowEpoch, cfg) {
  const parts = timeEngine.toParts(nowEpoch);
  const day = timeEngine.dateKey(nowEpoch);
  const hourStr = String(parts.hour).padStart(2, '0');
  const freq = cfg.frequency || 'daily';
  if (freq === 'hourly') return { due: true, key: `${day}-h${hourStr}` };
  if (freq === 'every6h') return { due: parts.hour % 6 === cfg.backupHour % 6, key: `${day}-h${hourStr}` };
  if (freq === 'every12h') return { due: parts.hour % 12 === cfg.backupHour % 12, key: `${day}-h${hourStr}` };
  if (freq === 'weekly') {
    const weekdayIdx = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    return { due: weekdayIdx === (cfg.weeklyDay ?? 0) && parts.hour === cfg.backupHour, key: `${day}-w` };
  }
  return { due: parts.hour === cfg.backupHour, key: day };
}

let timer;
function scheduleDaily() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const cfg = getScheduleConfig();
    if (!cfg.enabled) return;
    const nowEpoch = Date.now();
    const { due, key } = windowKeyFor(nowEpoch, cfg);
    if (!due) return;
    const marker = path.join(BACKUPS, '.last-daily');
    let last = '';
    try { last = fs.readFileSync(marker, 'utf8').trim(); } catch { /* ignore */ }
    if (last !== key) {
      try {
        const passphrase = process.env.BACKUP_PASSPHRASE || null;
        createBackup(passphrase);
        fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
        fs.writeFileSync(marker, key, { mode: 0o600 });
        recordScheduleRun(key);
      } catch (e) {
        console.error('[Montra] Scheduled backup failed:', e.message);
      }
    }
  }, 60 * 1000);
  timer.unref?.();
}

module.exports = {
  createBackup,
  decryptBackup,
  listBackups,
  pruneBackups,
  scheduleDaily,
  startScheduler: scheduleDaily,
  getScheduleConfig,
  setScheduleConfig,
  windowKeyFor,
  FREQUENCIES
};

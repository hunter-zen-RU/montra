/**
 * Montra time engine — one place that decides what "18:30" means.
 *
 * Everything persistent (status manifests, OTM jobs, cron jobs) keeps an absolute
 * epoch, so due checks never depend on the server clock being right. This engine
 * only translates user wall-clock input into epochs and formats epochs back for
 * display:
 *   - timeZone: IANA zone (Africa/Nairobi). Empty means the server's local zone.
 *   - shiftMinutes: manual correction for a wrong server clock. The user clock is
 *     real time + shiftMinutes, so "18:30" is scheduled at the real instant that
 *     matches 18:30 on that corrected clock.
 *
 * Overrides are stored in data/timeConfig.json (0600) and win over the environment.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'timeConfig.json');
const MAX_SHIFT_MINUTES = 7 * 24 * 60;

const partsFormatters = new Map();

function pad2(value) {
  return String(value).padStart(2, '0');
}

function partsInZone(date, timeZone) {
  const key = timeZone || 'server';
  let formatter = partsFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    partsFormatters.set(key, formatter);
  }
  const out = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second)
  };
}

// Offset of the zone at the given instant, independent of the host's own zone.
function zoneOffsetMs(date, timeZone) {
  const parts = partsInZone(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

// Wall-clock parts in a zone -> real epoch. The second pass handles DST edges where
// the offset differs between the guessed instant and the corrected one.
function zonedTimeToUtc(parts, timeZone) {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0, parts.ms || 0);
  const firstOffset = zoneOffsetMs(new Date(guess), timeZone);
  let epoch = guess - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(epoch), timeZone);
  if (secondOffset !== firstOffset) epoch = guess - secondOffset;
  return epoch;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

class TimeEngine {
  constructor() {
    this._fileConfig = undefined;
  }

  _loadFile() {
    if (this._fileConfig !== undefined) return this._fileConfig;
    try {
      if (!fs.existsSync(CONFIG_FILE)) {
        this._fileConfig = null;
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
      this._fileConfig = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
    } catch {
      this._fileConfig = null;
    }
    return this._fileConfig;
  }

  validateZone(value) {
    const raw = String(value ?? '').trim();
    if (!raw || /^(server|local|system)$/i.test(raw)) return { ok: true, timeZone: '' };
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: raw });
      return { ok: true, timeZone: raw };
    } catch {
      return { ok: false, reason: 'Time zone must be an IANA name like Africa/Nairobi or Europe/London.' };
    }
  }

  /** Accepts "90", "+90", "-30", "2h", "-1d". Returns minutes or null. */
  parseShiftMinutes(value) {
    if (value === null || value === undefined) return null;
    const str = String(value).trim();
    if (!str) return null;
    let minutes;
    const withUnit = str.match(/^([+-]?)(\d+)([mhd])$/i);
    if (withUnit) {
      const amount = parseInt(withUnit[2], 10);
      const mult = { m: 1, h: 60, d: 1440 }[withUnit[3].toLowerCase()];
      minutes = amount * mult;
      if (withUnit[1] === '-') minutes = -minutes;
    } else if (/^[+-]?\d+$/.test(str)) {
      minutes = parseInt(str, 10);
    } else {
      return null;
    }
    if (!Number.isInteger(minutes) || Math.abs(minutes) > MAX_SHIFT_MINUTES) return null;
    return minutes;
  }

  getConfig() {
    const file = this._loadFile();
    const envZoneRaw = String(process.env.MONTRA_TIMEZONE || '').trim();
    const envShift = this.parseShiftMinutes(process.env.MONTRA_TIME_SHIFT_MINUTES);

    let timeZone = '';
    let timeZoneSource = 'server';
    if (file && typeof file.timeZone === 'string') {
      const check = this.validateZone(file.timeZone);
      if (check.ok) {
        timeZone = check.timeZone;
        timeZoneSource = 'file';
      }
    } else if (envZoneRaw) {
      const check = this.validateZone(envZoneRaw);
      if (check.ok) {
        timeZone = check.timeZone;
        timeZoneSource = 'env';
      } else {
        timeZoneSource = 'env-invalid';
      }
    }

    let shiftMinutes = 0;
    let shiftSource = 'default';
    if (file && file.shiftMinutes !== undefined && file.shiftMinutes !== null) {
      const parsed = this.parseShiftMinutes(file.shiftMinutes);
      if (parsed !== null) {
        shiftMinutes = parsed;
        shiftSource = 'file';
      }
    } else if (envShift !== null) {
      shiftMinutes = envShift;
      shiftSource = 'env';
    }

    return { timeZone, shiftMinutes, source: { timeZone: timeZoneSource, shiftMinutes: shiftSource } };
  }

  setConfig({ timeZone, shiftMinutes } = {}) {
    if (timeZone === undefined && shiftMinutes === undefined) return this.getConfig();
    const next = { ...(this._loadFile() || {}) };

    if (timeZone !== undefined) {
      const check = this.validateZone(timeZone);
      if (!check.ok) throw new Error(check.reason);
      next.timeZone = check.timeZone;
    }
    if (shiftMinutes !== undefined) {
      const parsed = this.parseShiftMinutes(shiftMinutes);
      if (parsed === null) {
        throw new Error(`Shift must be whole minutes between -${MAX_SHIFT_MINUTES} and ${MAX_SHIFT_MINUTES} (for example 0, +90 or -1h).`);
      }
      next.shiftMinutes = parsed;
    }

    next.updatedAt = new Date().toISOString();
    writeJsonAtomic(CONFIG_FILE, next);
    this._fileConfig = next;
    return this.getConfig();
  }

  reset() {
    try { fs.rmSync(CONFIG_FILE, { force: true }); } catch { /* already gone */ }
    this._fileConfig = null;
    return this.getConfig();
  }

  _serverZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'server local';
    } catch {
      return 'server local';
    }
  }

  nowEpoch() {
    return Date.now();
  }

  /** Wall-clock parts the user is looking at (real time + optional shift). */
  toParts(epoch) {
    const value = Number(epoch);
    if (!Number.isFinite(value)) throw new Error('Invalid timestamp');
    const { timeZone, shiftMinutes } = this.getConfig();
    return partsInZone(new Date(value + shiftMinutes * 60000), timeZone);
  }

  /** Parts on the user clock -> real epoch to store and compare against Date.now(). */
  fromParts(parts) {
    const { timeZone, shiftMinutes } = this.getConfig();
    return zonedTimeToUtc(parts, timeZone) - shiftMinutes * 60000;
  }

  dateKey(epoch) {
    const parts = this.toParts(epoch);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  timeOfDay(epoch) {
    const parts = this.toParts(epoch);
    return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  }

  format(epoch, options = {}) {
    const value = Number(epoch);
    if (!Number.isFinite(value)) return 'unknown time';
    const { timeZone, shiftMinutes } = this.getConfig();
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timeZone || undefined,
      ...options
    }).format(new Date(value + shiftMinutes * 60000));
  }

  weekday(epoch) {
    return this.format(epoch, { weekday: 'long' });
  }

  nowParts() {
    return this.toParts(this.nowEpoch());
  }

  nowTime() {
    return this.timeOfDay(this.nowEpoch());
  }

  describe() {
    const config = this.getConfig();
    const now = this.nowEpoch();
    return {
      ...config,
      zoneLabel: config.timeZone || this._serverZone(),
      userClock: this.format(now, { dateStyle: 'full', timeStyle: 'long' }),
      serverClock: new Date(now).toLocaleString(),
      shiftLabel: config.shiftMinutes ? `${config.shiftMinutes > 0 ? '+' : ''}${config.shiftMinutes} min` : 'none'
    };
  }

  _validParts(parts) {
    if (!Number.isInteger(parts.year) || !Number.isInteger(parts.month) || !Number.isInteger(parts.day)) return false;
    if (parts.month < 1 || parts.month > 12) return false;
    if (parts.day < 1 || parts.day > new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()) return false;
    if (parts.hour < 0 || parts.hour > 23) return false;
    if (parts.minute < 0 || parts.minute > 59) return false;
    if (parts.second < 0 || parts.second > 59) return false;
    return true;
  }

  _addDays(parts, days) {
    const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: parts.hour,
      minute: parts.minute,
      second: parts.second || 0,
      ms: parts.ms || 0
    };
  }

  /**
   * Parse a schedule string into a real epoch.
   *   +30m / +2h / +1d      relative to now
   *   18:30                 next occurrence on the user clock
   *   2026-10-28            midnight in the configured zone
   *   2026-10-28T18:30      wall clock in the configured zone
   *   2026-10-28T18:30:00Z  absolute; the offset decides the instant
   */
  parseWallClock(input, baseEpoch = Date.now(), { rollForward = true } = {}) {
    const str = String(input || '').trim();
    if (!str) return null;
    const base = Number.isFinite(Number(baseEpoch)) ? Number(baseEpoch) : Date.now();

    let match = str.match(/^\+(\d+)([mhd])$/i);
    if (match) {
      const amount = parseInt(match[1], 10);
      const mult = { m: 60000, h: 3600000, d: 86400000 }[match[2].toLowerCase()];
      return base + amount * mult;
    }

    match = str.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const hour = parseInt(match[1], 10);
      const minute = parseInt(match[2], 10);
      if (hour > 23 || minute > 59) return null;
      const baseParts = this.toParts(base);
      const parts = { ...baseParts, hour, minute, second: 0, ms: 0 };
      let epoch = this.fromParts(parts);
      if (rollForward && epoch <= base) epoch = this.fromParts(this._addDays(parts, 1));
      return epoch;
    }

    match = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const parts = { year: +match[1], month: +match[2], day: +match[3], hour: 0, minute: 0, second: 0, ms: 0 };
      if (!this._validParts(parts)) return null;
      return this.fromParts(parts);
    }

    match = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (match) {
      const parts = {
        year: +match[1],
        month: +match[2],
        day: +match[3],
        hour: +match[4],
        minute: +match[5],
        second: +(match[6] || 0),
        ms: match[7] ? Number(`0.${match[7]}`) * 1000 : 0
      };
      if (!this._validParts(parts)) return null;
      return this.fromParts(parts);
    }

    // Only strings that carry their own offset are accepted as absolute. A bare
    // "28 Oct 2026" would otherwise be parsed in the server zone, which is the
    // exact ambiguity this engine exists to remove.
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(str)) {
      const parsed = Date.parse(str);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return null;
  }
}

module.exports = Object.assign(new TimeEngine(), {
  partsInZone,
  zonedTimeToUtc,
  MAX_SHIFT_MINUTES
});

/**
 * Montra — Unified Security Lock Engine (v1.3.0)
 * Locks BOTH the Web Dashboard and Telegram control bridge until /start {pin} is provided.
 * The PIN is stored as a scrypt hash in data/securityLock.json; the plaintext never touches disk.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const SECURITY_FILE = path.join(DATA_DIR, 'securityLock.json');
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;

function hashPin(pin, saltHex) {
  return crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), 32).toString('hex');
}

class SecurityEngine extends EventEmitter {
  constructor() {
    super();
    this.state = {
      isLocked: false,
      pinHash: null,
      pinSalt: null,
      pinHint: null,
      lockedAt: null,
      lockedBy: null,
      lockReason: 'Security lock active',
      failedAttempts: 0,
      lockoutUntil: 0
    };
    this._load();
    const envPin = String(process.env.TELEGRAM_START_PIN || '').trim();
    if (!this.state.pinHash) this._setPin(envPin || '1234', false);
    this._save();
  }

  _load() {
    try {
      if (!fs.existsSync(SECURITY_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8').replace(/^\uFEFF/, ''));
      if (!raw || typeof raw !== 'object') return;
      this.state.isLocked = Boolean(raw.isLocked);
      this.state.pinHash = typeof raw.pinHash === 'string' ? raw.pinHash : null;
      this.state.pinSalt = typeof raw.pinSalt === 'string' ? raw.pinSalt : null;
      this.state.pinHint = typeof raw.pinHint === 'string' ? raw.pinHint : null;
      this.state.lockedAt = raw.lockedAt || null;
      this.state.lockedBy = raw.lockedBy || null;
      this.state.lockReason = raw.lockReason || 'Security lock active';
      this.state.failedAttempts = Number(raw.failedAttempts || 0);
      this.state.lockoutUntil = Number(raw.lockoutUntil || 0);
      // Older installs stored the PIN in plaintext; migrate it to a salted hash.
      if (!this.state.pinHash && raw.pin && typeof raw.pin === 'string') this._setPin(raw.pin, false);
    } catch (e) {
      console.warn('[Montra Security] Could not load securityLock.json:', e.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(SECURITY_FILE), { recursive: true });
      const temp = `${SECURITY_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(temp, SECURITY_FILE);
    } catch (e) {
      console.error('[Montra Security] Could not save securityLock.json:', e.message);
    }
  }

  _setPin(pin, persist = true) {
    const clean = String(pin || '').trim();
    if (clean.length < 3) return false;
    this.state.pinSalt = crypto.randomBytes(16).toString('hex');
    this.state.pinHash = hashPin(clean, this.state.pinSalt);
    this.state.pinHint = `${clean.slice(0, 1)}${'*'.repeat(Math.max(3, clean.length - 1))}`;
    if (persist) this._save();
    return true;
  }

  _matchesPin(pin) {
    const clean = String(pin || '').trim();
    if (!clean || !this.state.pinHash || !this.state.pinSalt) return false;
    const candidate = Buffer.from(hashPin(clean, this.state.pinSalt), 'hex');
    const stored = Buffer.from(this.state.pinHash, 'hex');
    return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
  }

  isLocked() {
    return Boolean(this.state.isLocked);
  }

  getStatus() {
    return {
      isLocked: Boolean(this.state.isLocked),
      lockedAt: this.state.lockedAt,
      lockedBy: this.state.lockedBy,
      lockReason: this.state.lockReason,
      failedAttempts: this.state.failedAttempts,
      lockoutUntil: Number(this.state.lockoutUntil || 0),
      hasPin: Boolean(this.state.pinHash),
      pinHint: this.state.pinHint || 'None'
    };
  }

  lock(pin, by = 'admin', reason = 'Administrative lock active') {
    const clean = String(pin || '').trim();
    if (clean.length >= 3) this._setPin(clean, false);
    if (!this.state.pinHash) this._setPin('1234', false);
    this.state.isLocked = true;
    this.state.lockedAt = Date.now();
    this.state.lockedBy = by;
    this.state.lockReason = reason;
    this.state.failedAttempts = 0;
    this.state.lockoutUntil = 0;
    this._save();
    this.emit('locked', { by, at: this.state.lockedAt });
    console.log(`[Montra Security] System LOCKED by ${by} at ${new Date().toISOString()}`);
    return { ok: true, isLocked: true, lockedAt: this.state.lockedAt };
  }

  unlock(suppliedPin, by = 'admin') {
    const now = Date.now();
    if (this.state.lockoutUntil > now) {
      const seconds = Math.ceil((this.state.lockoutUntil - now) / 1000);
      return { ok: false, error: `Too many incorrect attempts. Try again in ${seconds}s.`, retryAfter: seconds, locked: true };
    }

    const cleanInput = String(suppliedPin || '').trim();
    const envPin = String(process.env.TELEGRAM_START_PIN || '').trim();
    const matches = this._matchesPin(cleanInput) || Boolean(envPin && cleanInput === envPin);

    if (matches) {
      this.state.isLocked = false;
      this.state.lockedAt = null;
      this.state.lockedBy = null;
      this.state.failedAttempts = 0;
      this.state.lockoutUntil = 0;
      this._save();
      this.emit('unlocked', { by, at: Date.now() });
      console.log(`[Montra Security] System UNLOCKED by ${by} at ${new Date().toISOString()}`);
      return { ok: true, isLocked: false };
    }

    this.state.failedAttempts = (this.state.failedAttempts || 0) + 1;
    if (this.state.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.state.failedAttempts = 0;
      this.state.lockoutUntil = now + LOCKOUT_MS;
    }
    this._save();
    console.warn(`[Montra Security] Failed unlock attempt by ${by}`);
    return {
      ok: false,
      error: this.state.lockoutUntil > now
        ? `Too many incorrect attempts. Try again in ${Math.ceil(LOCKOUT_MS / 1000)}s.`
        : 'Incorrect security PIN. Please try again.',
      locked: true,
      failedAttempts: this.state.failedAttempts
    };
  }

  setPin(newPin, currentPin = null) {
    const clean = String(newPin || '').trim();
    if (!clean || clean.length < 3) {
      return { ok: false, error: 'PIN must be at least 3 characters long.' };
    }
    if (this.state.isLocked) {
      const envPin = String(process.env.TELEGRAM_START_PIN || '').trim();
      if (!this._matchesPin(currentPin) && !(envPin && String(currentPin || '').trim() === envPin)) {
        return { ok: false, error: 'Current PIN required to change PIN while locked.' };
      }
    }
    this._setPin(clean);
    return { ok: true, hasPin: true };
  }
}

module.exports = new SecurityEngine();

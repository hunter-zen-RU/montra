const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'humanizerConfig.json');
const MIN_TYPING_DELAY_MS = 30_000;
const MAX_TYPING_DELAY_MS = 300_000;

const DEFAULT_CONFIG = {
    enabled: true,
    typingSpeed: 'normal', // 'slow' (35 wpm) | 'normal' (55 wpm) | 'fast' (75 wpm)
    presenceEmulation: true, // Send 'composing' or 'recording' to WhatsApp
    readingDelay: true, // Natural pause before reading/replying to simulate human processing
    jitterFactor: 0.28, // ±28% randomized timing jitter
    activeHoursOnly: false, // Enforce circadian working hours
    activeHoursStart: 7, // 7:00 AM
    activeHoursEnd: 23, // 11:00 PM
    simulateVoiceNoteRecording: true,
    typoSimulation: false,
    minTypingDelayMs: MIN_TYPING_DELAY_MS,
    maxTypingDelayMs: MAX_TYPING_DELAY_MS
};

class HumanizerEngine {
    constructor() {
        this.config = this.loadConfig();
        this.activeSessions = new Map();
    }

    loadConfig() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^\uFEFF/, ''));
                return { ...DEFAULT_CONFIG, ...data };
            }
        } catch (e) {
            console.warn('[HumanizerEngine] Config load fallback:', e.message);
        }
        return { ...DEFAULT_CONFIG };
    }

    saveConfig(patch = {}) {
        this.config = { ...this.config, ...patch };
        try {
            const dir = path.dirname(CONFIG_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));
        } catch (e) {
            console.error('[HumanizerEngine] Failed to save config:', e);
        }
        return this.config;
    }

    getConfig() {
        return { ...this.config };
    }

    isWithinActiveHours() {
        if (!this.config.activeHoursOnly) return true;
        const currentHour = new Date().getHours();
        return currentHour >= this.config.activeHoursStart && currentHour < this.config.activeHoursEnd;
    }

    calculateTypingDuration(text = '') {
        const charCount = typeof text === 'string' ? Array.from(text).length : 0;
        
        // Approximate characters per second based on typing speed
        let cps = 5.0; // normal (~50-60 wpm)
        if (this.config.typingSpeed === 'slow') cps = 3.2; // ~35 wpm
        if (this.config.typingSpeed === 'fast') cps = 7.5; // ~75-80 wpm

        let duration = MIN_TYPING_DELAY_MS + (charCount / cps) * 1000;

        // Apply human non-linear jitter: humans don't type at constant clock speeds
        const jitter = (Math.random() * 2 - 1) * this.config.jitterFactor;
        duration = duration * (1 + jitter);

        // Clamp to safe, user-friendly bounds
        const configuredMax = Number(this.config.maxTypingDelayMs);
        const maxMs = Math.max(MIN_TYPING_DELAY_MS, Number.isFinite(configuredMax) ? configuredMax : MAX_TYPING_DELAY_MS);
        return Math.floor(Math.max(MIN_TYPING_DELAY_MS, Math.min(maxMs, duration)));
    }

    calculateReadingDuration(text = '') {
        if (!this.config.readingDelay) return 0;
        const words = (typeof text === 'string' ? text.trim().split(/\s+/).length : 10);
        // Average human reading rate is ~220-250 wpm (approx 3.7 words/sec)
        const readingMs = (words / 3.7) * 1000;
        const jitter = (Math.random() * 0.4) + 0.8;
        return Math.floor(Math.max(600, Math.min(2200, readingMs * jitter)));
    }

    async applyTypingSimulation(sock, jid, text = '') {
        const duration = this.calculateTypingDuration(text);
        // Broadcast/status destinations do not support a meaningful composing presence,
        // but still observe the required pre-send delay.
        const canShowPresence = this.config.enabled && this.config.presenceEmulation
            && jid && !jid.includes('@system') && !jid.endsWith('@broadcast');

        if (sock && canShowPresence && typeof sock.sendPresenceUpdate === 'function') {
            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch (err) {
                // Presence update non-fatal
            }
        }

        await new Promise(resolve => setTimeout(resolve, duration));

        if (sock && canShowPresence && typeof sock.sendPresenceUpdate === 'function') {
            try {
                await sock.sendPresenceUpdate('paused', jid);
            } catch (err) {
                // Ignore
            }
        }

        return duration;
    }

    async applyRecordingSimulation(sock, jid, durationMs = 2000) {
        if (!this.config.enabled || !jid || jid.includes('@system')) {
            return 0;
        }

        const clampedDuration = Math.max(1200, Math.min(5000, durationMs));

        if (sock && this.config.presenceEmulation && typeof sock.sendPresenceUpdate === 'function') {
            try {
                await sock.sendPresenceUpdate('recording', jid);
            } catch (err) { /* ignore */ }
        }

        await new Promise(resolve => setTimeout(resolve, clampedDuration));

        if (sock && this.config.presenceEmulation && typeof sock.sendPresenceUpdate === 'function') {
            try {
                await sock.sendPresenceUpdate('paused', jid);
            } catch (err) { /* ignore */ }
        }

        return clampedDuration;
    }

    async applyPreProcessingDelay(text = '') {
        if (!this.config.enabled || !this.config.readingDelay) return 0;
        const delayMs = this.calculateReadingDuration(text);
        if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        return delayMs;
    }
}

module.exports = new HumanizerEngine();

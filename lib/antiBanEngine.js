const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'antiBanConfig.json');

const DEFAULT_CONFIG = {
    enabled: true,
    warmupMode: true, // Progressive daily message ramp-up for newly linked accounts
    accountLinkedDate: Date.now(),
    maxMsgsPerMinPerChat: 8, // Stricter than WhatsApp tripwire (WhatsApp flags >12/min)
    maxMsgsPerMinGlobal: 26,
    maxMsgsPerMinGroup: 12,
    unknownContactProtection: true, // Minimum delay between unsolicited strangers
    unknownContactMinIntervalMs: 3500,
    browserFingerprint: 'macOS_Chrome_131', // 'macOS_Chrome_131' | 'Windows_Chrome_131' | 'Ubuntu_Chrome_131'
    autoBackoffOn429: true,
    groupFloodShield: true,
    enforceHumanIntervals: true
};

class AntiBanEngine {
    constructor() {
        this.config = this.loadConfig();
        // accountLinkedDate defaults to "now", so without this first write every restart reset
        // the warmup clock and the daily cap stayed at its day-one value forever.
        if (!fs.existsSync(CONFIG_PATH)) this.saveConfig();
        this.messageTimestamps = []; // Global timestamps for rate limiting
        this.chatTimestamps = new Map(); // JID -> Array of timestamps
        this.dailyCounter = {
            dateStr: new Date().toISOString().slice(0, 10),
            count: 0
        };
        this.tripwireTriggered = false;
        this.tripwireReason = null;
        this.tripwireExpiresAt = 0;
        this.auditLog = [];
    }

    loadConfig() {
        try {
            if (fs.existsSync(CONFIG_PATH)) {
                const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8').replace(/^\uFEFF/, ''));
                return { ...DEFAULT_CONFIG, ...data };
            }
        } catch (e) {
            console.warn('[AntiBanEngine] Config load fallback:', e.message);
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
            console.error('[AntiBanEngine] Failed to save config:', e);
        }
        return this.config;
    }

    getConfig() {
        return { ...this.config };
    }

    applySafeModePreset() {
        this.saveConfig({
            enabled: true,
            warmupMode: true,
            maxMsgsPerMinPerChat: 6,
            maxMsgsPerMinGlobal: 18,
            maxMsgsPerMinGroup: 10,
            unknownContactProtection: true,
            unknownContactMinIntervalMs: 5000,
            autoBackoffOn429: true,
            groupFloodShield: true,
            enforceHumanIntervals: true
        });
        this.logAudit('SAFE_MODE_ENABLED', 'APPLIED', { mode: 'MAX_PROTECTION' });
        return this.getSecurityStatus();
    }

    logAudit(type, verdict, details = {}) {
        const entry = {
            id: 'AB_' + Date.now() + Math.random().toString(36).substring(2, 5),
            timestamp: Date.now(),
            time: new Date().toLocaleTimeString(),
            type,
            verdict,
            ...details
        };
        this.auditLog.unshift(entry);
        if (this.auditLog.length > 50) this.auditLog.pop();
        return entry;
    }

    getWarmupLimit() {
        if (!this.config.warmupMode) return 999999;
        const linkedDate = this.config.accountLinkedDate || Date.now();
        const daysActive = Math.max(1, Math.floor((Date.now() - linkedDate) / (24 * 60 * 60 * 1000)) + 1);
        
        switch (daysActive) {
            case 1: return 25;
            case 2: return 50;
            case 3: return 100;
            case 4: return 200;
            default: return 500;
        }
    }

    checkDailyCounter() {
        const today = new Date().toISOString().slice(0, 10);
        if (this.dailyCounter.dateStr !== today) {
            this.dailyCounter = { dateStr: today, count: 0 };
        }
    }

    cleanOldTimestamps(now = Date.now()) {
        const oneMinuteAgo = now - 60000;
        this.messageTimestamps = this.messageTimestamps.filter(t => t > oneMinuteAgo);
        
        for (const [jid, list] of this.chatTimestamps.entries()) {
            const filtered = list.filter(t => t > oneMinuteAgo);
            if (filtered.length === 0) {
                this.chatTimestamps.delete(jid);
            } else {
                this.chatTimestamps.set(jid, filtered);
            }
        }
    }

    checkCanSend(jid, isGroup = false, isKnownContact = true) {
        if (!this.config.enabled || !jid || jid.includes('@system')) {
            return { allowed: true };
        }

        const now = Date.now();

        // Check active tripwire
        if (this.tripwireTriggered) {
            if (now < this.tripwireExpiresAt) {
                const waitSec = Math.ceil((this.tripwireExpiresAt - now) / 1000);
                this.logAudit('TRIPWIRE_BLOCKED', 'DENIED', { jid, reason: `Tripwire active. Cooldown: ${waitSec}s remaining.` });
                return {
                    allowed: false,
                    reason: `Anti-Ban Tripwire active (${this.tripwireReason || 'Rate surge detected'}). Protection cooldown active for ${waitSec}s.`
                };
            } else {
                this.clearTripwire();
            }
        }

        // Clean timestamps older than 60s
        this.cleanOldTimestamps(now);
        this.checkDailyCounter();

        // 1. Warmup Mode Check
        const warmupLimit = this.getWarmupLimit();
        if (this.config.warmupMode && this.dailyCounter.count >= warmupLimit) {
            this.logAudit('WARMUP_LIMIT', 'DENIED', { jid, count: this.dailyCounter.count, limit: warmupLimit });
            return {
                allowed: false,
                reason: `Account Warmup protection limit reached (${this.dailyCounter.count}/${warmupLimit} msgs today). Prevents WhatsApp AI automated ban on new accounts.`
            };
        }

        // 2. Global Rate Limit Check
        if (this.messageTimestamps.length >= this.config.maxMsgsPerMinGlobal) {
            this.logAudit('GLOBAL_RATE_LIMIT', 'DENIED', { jid, current: this.messageTimestamps.length, max: this.config.maxMsgsPerMinGlobal });
            return {
                allowed: false,
                reason: `Global message throughput capped (${this.messageTimestamps.length}/${this.config.maxMsgsPerMinGlobal} msgs/min) to avoid WhatsApp network flood detection.`
            };
        }

        // 3. Chat-specific Rate Limit Check
        const chatList = this.chatTimestamps.get(jid) || [];
        const limitPerChat = isGroup ? this.config.maxMsgsPerMinGroup : this.config.maxMsgsPerMinPerChat;
        if (chatList.length >= limitPerChat) {
            this.logAudit('CHAT_RATE_LIMIT', 'DENIED', { jid, current: chatList.length, max: limitPerChat });
            return {
                allowed: false,
                reason: `Chat message speed capped (${chatList.length}/${limitPerChat} msgs/min to ${jid.slice(0, 12)}...) for anti-spam safety.`
            };
        }

        // 4. Unknown Contact Delay Check
        if (!isGroup && !isKnownContact && this.config.unknownContactProtection && chatList.length > 0) {
            const lastMsgTime = chatList[chatList.length - 1];
            const elapsed = now - lastMsgTime;
            if (elapsed < this.config.unknownContactMinIntervalMs) {
                const waitMs = this.config.unknownContactMinIntervalMs - elapsed;
                this.logAudit('UNKNOWN_CONTACT_THROTTLE', 'THROTTLED', { jid, waitMs });
                return {
                    allowed: false,
                    retryAfterMs: waitMs,
                    reason: `Unknown contact protection active. Waiting ${Math.ceil(waitMs/1000)}s between messages to unsaved contacts.`
                };
            }
        }

        this.logAudit('CHECK_PASSED', 'ALLOWED', { jid, isGroup });
        return { allowed: true };
    }

    recordSentMessage(jid, isGroup = false) {
        if (!jid || jid.includes('@system')) return;
        const now = Date.now();
        this.messageTimestamps.push(now);

        const list = this.chatTimestamps.get(jid) || [];
        list.push(now);
        this.chatTimestamps.set(jid, list);

        this.checkDailyCounter();
        this.dailyCounter.count++;
    }

    triggerTripwire(reason = 'Rate-overlimit or connection tripwire received from WhatsApp') {
        this.tripwireTriggered = true;
        this.tripwireReason = reason;
        this.tripwireExpiresAt = Date.now() + 60000; // 60s safety lockout
        this.logAudit('TRIPWIRE_TRIGGERED', 'LOCKED', { reason, expiresAt: this.tripwireExpiresAt });
        console.warn(`🛡️ [AntiBanEngine] TRIPWIRE TRIGGERED: ${reason}. Pausing outbound traffic for 60s.`);
    }

    clearTripwire() {
        this.tripwireTriggered = false;
        this.tripwireReason = null;
        this.tripwireExpiresAt = 0;
        this.logAudit('TRIPWIRE_CLEARED', 'RESTORED');
        console.log(`🛡️ [AntiBanEngine] Tripwire cleared. Standard protection resumed.`);
    }

    getBrowserSignature() {
        const fp = this.config.browserFingerprint || 'macOS_Chrome_131';
        switch (fp) {
            case 'Windows_Chrome_131':
                return ['Windows', 'Chrome', '131.0.6778.86'];
            case 'Ubuntu_Chrome_131':
                return ['Ubuntu', 'Chrome', '131.0.6778.86'];
            case 'macOS_Chrome_131':
            default:
                return ['macOS', 'Chrome', '131.0.6778.86'];
        }
    }

    getSecurityStatus() {
        const now = Date.now();
        this.cleanOldTimestamps(now);
        this.checkDailyCounter();

        const globalPerMin = this.messageTimestamps.length;
        const warmupLimit = this.getWarmupLimit();
        const daysActive = Math.max(1, Math.floor((now - (this.config.accountLinkedDate || now)) / (24 * 60 * 60 * 1000)) + 1);

        // Security / Safety score calculation (0 - 100)
        let score = 100;
        if (this.tripwireTriggered) score -= 45;
        if (globalPerMin > (this.config.maxMsgsPerMinGlobal * 0.75)) score -= 20;
        if (this.dailyCounter.count > (warmupLimit * 0.85)) score -= 15;
        if (!this.config.warmupMode) score -= 10;
        if (!this.config.unknownContactProtection) score -= 10;
        score = Math.max(10, Math.min(100, score));

        let riskLevel = 'LOW_RISK';
        if (score < 40) riskLevel = 'HIGH_RISK';
        else if (score < 70) riskLevel = 'ELEVATED';
        else if (score < 90) riskLevel = 'MODERATE';

        return {
            enabled: this.config.enabled,
            securityScore: score,
            riskLevel,
            tripwire: {
                active: this.tripwireTriggered,
                reason: this.tripwireReason,
                secondsRemaining: this.tripwireTriggered ? Math.max(0, Math.ceil((this.tripwireExpiresAt - now) / 1000)) : 0
            },
            warmup: {
                enabled: this.config.warmupMode,
                daysActive,
                dailyLimit: warmupLimit,
                sentToday: this.dailyCounter.count,
                percentUsed: Math.min(100, Math.round((this.dailyCounter.count / warmupLimit) * 100))
            },
            throughput: {
                lastMinuteMsgs: globalPerMin,
                maxAllowed: this.config.maxMsgsPerMinGlobal,
                activeChatBuckets: this.chatTimestamps.size
            },
            fingerprint: this.config.browserFingerprint,
            browserTuple: this.getBrowserSignature(),
            recentAudits: this.auditLog.slice(0, 15)
        };
    }
}

module.exports = new AntiBanEngine();

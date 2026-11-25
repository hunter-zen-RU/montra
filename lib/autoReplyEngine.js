/**
 * Rule-based WhatsApp auto replies.
 * Rule shape: { id, trigger, usage: "dms" | "groups-mentioned", message, match: "contains"|"exact"|"startsWith"|"regex", enabled, priority, cooldownMin, cooldownOff, contacts, schedule }
 * Replies are opt-in, trigger-specific, cooldown-limited and anti-ban gated.
 */
const fs = require('fs');
const path = require('path');
const humanizer = require('./humanizerEngine');
const timeEngine = require('./timeEngine');
const CONFIG_FILE = process.env.MONTRA_AUTOREPLY_CONFIG
  || path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'montraAutoReply.json');
const VALID_USAGE = new Set(['dms', 'groups-mentioned']);
const VALID_MATCH = new Set(['contains', 'exact', 'startsWith', 'regex']);

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
        if (raw && typeof raw === 'object') return raw;
    } catch { /* ignore */ }
    return {};
}
function normalizeRule(rule, index = 0) {
    if (!rule || typeof rule !== 'object') return null;
    const trigger = String(rule.trigger || '').trim().slice(0, 100);
    const message = String(rule.message || '').trim().slice(0, 800);
    const usage = String(rule.usage || 'dms').toLowerCase();
    const match = String(rule.match || 'contains');
    if (!trigger || !message || !VALID_USAGE.has(usage) || !VALID_MATCH.has(match)) return null;
    const priority = Number.isFinite(Number(rule.priority)) ? Math.max(-100, Math.min(100, Number(rule.priority))) : 0;
    let regexValid = true;
    if (match === 'regex') { try { new RegExp(trigger, 'i'); } catch { regexValid = false; } }
    if (!regexValid) return null;
    return { id: String(rule.id || `rule-${Date.now()}-${index}`), trigger, usage, message,
        match, enabled: rule.enabled !== false, priority, cooldownMin: Math.max(0, Number(rule.cooldownMin) || 0),
        // cooldownMin 0 means "inherit the global cooldown", so a rule that genuinely wants no
        // wait carries its own flag instead. Old configs without it keep inheriting.
        cooldownOff: rule.cooldownOff === true,
        contacts: Array.isArray(rule.contacts) ? rule.contacts.map(String).slice(0, 100) : [],
        schedule: rule.schedule && typeof rule.schedule === 'object' ? { start: String(rule.schedule.start || '00:00'), end: String(rule.schedule.end || '23:59') } : null,
        hits: Math.max(0, Number(rule.hits) || 0) };
}
class AutoReplyEngine {
    constructor() {
        const saved = load();
        this.config = {
            enabled: saved.enabled === true,
            cooldownMin: Number.isFinite(Number(saved.cooldownMin)) ? Math.max(0, Number(saved.cooldownMin)) : 60,
            rules: Array.isArray(saved.rules) ? saved.rules.map(normalizeRule).filter(Boolean) : [],
            // Retained only for compatibility with older Telegram UI; no blanket replies are sent.
            text: typeof saved.text === 'string' ? saved.text : 'Thanks for your message!',
            groups: saved.groups === true
        };
        this.lastReplied = new Map();
    }
    getConfig() { return { ...this.config, rules: this.config.rules.map(r => ({ ...r })) }; }
    _save() {
        try {
            fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
        } catch (e) { console.error('[Montra] auto-reply config save failed:', e.message); }
        return this.getConfig();
    }
    update(patch = {}) {
        if (typeof patch.enabled === 'boolean') this.config.enabled = patch.enabled;
        if (typeof patch.text === 'string' && patch.text.trim()) this.config.text = patch.text.trim().slice(0, 500);
        if (typeof patch.cooldownMin === 'number' && Number.isFinite(patch.cooldownMin) && patch.cooldownMin >= 0) this.config.cooldownMin = Math.round(patch.cooldownMin);
        if (typeof patch.groups === 'boolean') this.config.groups = patch.groups;
        if (Array.isArray(patch.rules)) this.config.rules = patch.rules.map(normalizeRule).filter(Boolean).slice(0, 100);
        return this._save();
    }
    addRule(input) {
        const rule = normalizeRule(input, this.config.rules.length);
        if (!rule) throw new Error('Rule needs trigger, message, and usage "dms" or "groups-mentioned".');
        if (this.config.rules.length >= 100) throw new Error('Maximum of 100 auto-reply rules reached.');
        this.config.rules.push(rule); this._save(); return { ...rule };
    }
    removeRule(idOrTrigger) {
        const needle = String(idOrTrigger || '').toLowerCase();
        const before = this.config.rules.length;
        this.config.rules = this.config.rules.filter(r => r.id.toLowerCase() !== needle && r.trigger.toLowerCase() !== needle);
        if (before !== this.config.rules.length) this._save();
        return before - this.config.rules.length;
    }
    _matches(rule, text) {
        const haystack = String(text || '').trim().toLowerCase();
        const trigger = rule.trigger.toLowerCase();
        if (rule.match === 'exact') return haystack === trigger;
        if (rule.match === 'startsWith') return haystack.startsWith(trigger);
        if (rule.match === 'regex') { try { return new RegExp(rule.trigger, 'i').test(String(text || '')); } catch { return false; } }
        return haystack.includes(trigger);
    }
    async maybeReply(sock, message, decoded, botJid) {
        try {
            if (!this.config.enabled || !sock) return false;
            const jid = message.key?.remoteJid;
            if (!jid || message.key?.fromMe || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return false;
            const isGroup = jid.endsWith('@g.us');
            const text = String(decoded?.text || '').trim();
            if (!text || !['text', 'image', 'video', 'document', 'voice', 'contact', 'location'].includes(decoded?.kind)) return false;
            const mentionedJids = (decoded?.mentionedJids || []).map(String);
            const botDigits = String(botJid || '').split('@')[0].split(':')[0];
            const mentioned = mentionedJids.some(j => j === String(botJid) || j.split('@')[0].split(':')[0] === botDigits)
                || (botDigits && new RegExp(`@${botDigits.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
            const usage = isGroup ? 'groups-mentioned' : 'dms';
            if (isGroup && !mentioned) return false;
            const sender = String(message.key?.participant || jid);
            const hhmm = timeEngine.nowTime();
            const rule = this.config.rules.filter(r => {
                if (!r.enabled || r.usage !== usage || !this._matches(r, text)) return false;
                if (r.contacts.length && !r.contacts.includes(sender) && !r.contacts.includes(jid) && !r.contacts.includes(String(message.pushName || ''))) return false;
                if (r.schedule) { const {start='00:00',end='23:59'}=r.schedule; const inWindow=start<=end ? hhmm>=start && hhmm<=end : hhmm>=start || hhmm<=end; if(!inWindow) return false; }
                return true;
            }).sort((a,b)=>b.priority-a.priority)[0];
            if (!rule) return false;
            const cooldownMs = (rule.cooldownOff ? 0 : (rule.cooldownMin || this.config.cooldownMin)) * 60000;
            const cooldownKey = `${jid}:${rule.id}`;
            const last = this.lastReplied.get(cooldownKey) || 0;
            if (Date.now() - last < cooldownMs) return false;
            let antiBan = null;
            try { antiBan = require('./antiBanEngine'); } catch { /* ignore */ }
            if (antiBan && typeof antiBan.checkCanSend === 'function') {
                const safety = antiBan.checkCanSend(jid, isGroup, true);
                if (safety && safety.allowed === false) return false;
            }
            const name = String(message.pushName || jid.split('@')[0]).slice(0, 80);
            const body = rule.message.replace(/\{name\}/g, name).replace(/\{trigger\}/g, rule.trigger).slice(0, 800);
            await humanizer.applyTypingSimulation(sock, jid, body);
            await sock.sendMessage(jid, { text: body });
            if (antiBan && typeof antiBan.recordSentMessage === 'function') antiBan.recordSentMessage(jid, isGroup);
            this.lastReplied.delete(cooldownKey);
            // Re-insert so ordering stays "least recently refreshed first"; the cap then evicts
            // long-silent senders whose cooldown has certainly expired, never an active one.
            this.lastReplied.set(cooldownKey, Date.now());
            while (this.lastReplied.size > 2000) this.lastReplied.delete(this.lastReplied.keys().next().value);
            rule.hits = (rule.hits || 0) + 1;
            this._save();
            return true;
        } catch (e) {
            console.error('[Montra] auto-reply failed:', e.message);
            return false;
        }
    }
}
module.exports = new AutoReplyEngine();

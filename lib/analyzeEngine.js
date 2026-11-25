/**
 * Montra analysis engine — rolling message log + /analyze statistics.
 * Doubles as the message-history store for /messages and /search.
 * Pure local computation: no AI, no network.
 */
const fs = require('fs');
const path = require('path');
const { decode, describe } = require('./messageDecoder');
const syncStore = require('./syncStore');
const antiBanEngine = require('./antiBanEngine');
const timeEngine = require('./timeEngine');

const STORE_FILE = path.join(process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data'), 'montraMessages.json');
const PER_CHAT_CAP = 300;
const CHAT_CAP = 40;

const STOPWORDS = new Set(('the and for you your with that this have from are was were they them there here what when where which will would could should about into over under just like then than some more very much many been being its it\'s dont don\'t cant can\'t im i\'m yeah okay ok hi hey please thanks thank').split(/\s+/));

function loadStore() {
    try {
        const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8').replace(/^\uFEFF/, ''));
        if (raw && typeof raw === 'object') return raw;
    } catch { /* ignore */ }
    return {};
}

class AnalyzeEngine {
    constructor() {
        this.store = loadStore(); // jid -> [{ts, from, fromMe, kind, text}]
        this._dirty = false;
        this._syncCache = null; // dashboard charts fall back to the sync cache until the live log has entries
        this._timer = setInterval(() => this.flush(), 10000).unref?.();
    }

    record(message, decoded) {
        try {
            const jid = message.key?.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
            const text = String(decoded?.text || '').slice(0, 200);
            const entry = {
                ts: Date.now(),
                from: message.key?.participant || message.key?.remoteJid || '',
                fromMe: Boolean(message.key?.fromMe),
                kind: decoded?.kind || 'unknown',
                text: /(?![\uDC00-\uDFFF])[\uD800-\uDBFF]|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text) ? '' : text
            };
            const arr = this.store[jid] || (this.store[jid] = []);
            arr.push(entry);
            if (arr.length > PER_CHAT_CAP) arr.splice(0, arr.length - PER_CHAT_CAP);
            const keys = Object.keys(this.store);
            if (keys.length > CHAT_CAP) {
                keys.sort((a, b) => (this.store[a][this.store[a].length - 1]?.ts || 0) - (this.store[b][this.store[b].length - 1]?.ts || 0));
                for (const k of keys.slice(0, keys.length - CHAT_CAP)) delete this.store[k];
            }
            this._dirty = true;
        } catch { /* ignore */ }
    }

    flush() {
        if (!this._dirty) return;
        this._dirty = false;
        try {
            fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
            fs.writeFileSync(STORE_FILE, JSON.stringify(this.store));
        } catch (e) {
            console.error('[Montra] analyze store save failed:', e.message);
        }
    }

    history(jid, n = 10) {
        const arr = this.store[jid] || [];
        return arr.slice(-Math.min(Math.max(n, 1), 50)).reverse();
    }

    search(query, limit = 20) {
        const q = query.toLowerCase();
        const hits = [];
        for (const [jid, arr] of Object.entries(this.store)) {
            for (const e of arr) {
                if (e.text && e.text.toLowerCase().includes(q)) hits.push({ jid, ...e });
                if (hits.length >= limit) return hits;
            }
        }
        return hits;
    }

    chats() {
        return Object.entries(this.store)
            .map(([jid, arr]) => ({ jid, count: arr.length, last: arr[arr.length - 1]?.ts || 0 }))
            .sort((a, b) => b.last - a.last);
    }

    // Until the live log has entries (fresh install or first run after an upgrade) the
    // dashboard would otherwise show empty charts even though sync has tens of thousands
    // of cached messages. Derive the same shape from the sync cache and memoise it briefly.
    _allEntries() {
        const own = [];
        for (const [jid, arr] of Object.entries(this.store)) {
            for (const e of arr) own.push({ ...e, jid });
        }
        if (own.length) return own;

        const stats = syncStore.stats();
        const now = Date.now();
        if (this._syncCache && this._syncCache.total === stats.messages && now - this._syncCache.at < 15000) {
            return this._syncCache.entries;
        }
        const entries = [];
        for (const chat of syncStore.getChats()) {
            const jid = chat.id;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
            for (const m of syncStore.getMessages(jid, 1000)) {
                let decoded = {};
                try { decoded = decode(m.message) || {}; } catch { /* ignore malformed payloads */ }
                const ts = Number(m.messageTimestamp || 0);
                entries.push({
                    jid,
                    ts: ts ? ts * 1000 : now,
                    from: m.key?.participant || jid,
                    fromMe: Boolean(m.key?.fromMe),
                    kind: decoded.kind || 'unknown',
                    text: String(decoded.text || '').slice(0, 200)
                });
            }
        }
        this._syncCache = { total: stats.messages, at: now, entries };
        return entries;
    }

    _hourly(entries) {
        const hours = new Array(24).fill(0);
        for (const e of entries) hours[timeEngine.toParts(e.ts).hour]++;
        return hours;
    }

    _topWords(entries) {
        const counts = {};
        for (const e of entries) {
            for (const w of String(e.text || '').toLowerCase().split(/[^a-z0-9']+/)) {
                if (w.length < 3 || STOPWORDS.has(w)) continue;
                counts[w] = (counts[w] || 0) + 1;
            }
        }
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    }

    _fmtTs(ts) {
        const p = timeEngine.toParts(ts);
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(p.day)}/${pad(p.month)} ${pad(p.hour)}:${pad(p.minute)}`;
    }

    getHourlyHeatmap(targetJid = null, entries = null) {
        const hours = new Array(24).fill(0);
        const source = entries || (targetJid && this.store[targetJid] ? this.store[targetJid] : this._allEntries());
        for (const e of source) {
            hours[timeEngine.toParts(e.ts).hour]++;
        }
        return hours;
    }

    getDailyTrends(days = 7, entries = null) {
        const result = [];
        const now = Date.now();
        for (let i = days - 1; i >= 0; i--) {
            result.push({ date: timeEngine.dateKey(now - i * 86400000), count: 0 });
        }
        const source = entries || this._allEntries();
        for (const e of source) {
            const dateStr = timeEngine.dateKey(e.ts);
            const item = result.find(r => r.date === dateStr);
            if (item) item.count++;
        }
        return result;
    }

    getMessageTypeDistribution(entries = null) {
        const kinds = {};
        const source = entries || this._allEntries();
        for (const e of source) {
            const k = e.kind || 'unknown';
            kinds[k] = (kinds[k] || 0) + 1;
        }
        return kinds;
    }

    getTopChatters(limit = 8, entries = null) {
        const senders = {};
        const source = entries || this._allEntries();
        for (const e of source) {
            const key = e.fromMe ? 'You (bot)' : (String(e.from || '').split('@')[0].split(':')[0] || 'unknown');
            senders[key] = (senders[key] || 0) + 1;
        }
        return Object.entries(senders)
            .map(([sender, count]) => ({ sender, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }

    aggregateDailySummary(days = 7) {
        const windowDays = Math.max(1, Math.min(30, Number(days) || 7));
        const now = Date.now();
        const dayMap = new Map();
        for (let i = windowDays - 1; i >= 0; i--) {
            const date = timeEngine.dateKey(now - i * 86400000);
            dayMap.set(date, {
                date,
                total: 0,
                incoming: 0,
                outgoing: 0,
                categories: {},
                chatTypes: { chat: 0, group: 0, channel: 0 }
            });
        }

        const allDayDates = new Set();
        const totals = {
            messages: 0,
            chats: 0,
            incoming: 0,
            outgoing: 0,
            daysActive: 0,
            categories: {},
            chatTypes: { chat: 0, group: 0, channel: 0 }
        };

        for (const chat of syncStore.getChats()) {
            const jid = chat?.id || chat?.jid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) continue;
            const rows = syncStore.getMessages(jid, 1000);
            if (!rows.length) continue;
            totals.chats += 1;
            const chatType = syncStore.chatKind(jid);
            const normalizedType = chatType === 'group' || chatType === 'channel' ? chatType : 'chat';

            for (const m of rows) {
                let decoded = {};
                try { decoded = decode(m.message) || {}; } catch { /* ignore malformed payloads */ }
                const category = String(decoded.kind || 'unknown');
                const rawTs = Number(m.messageTimestamp || 0);
                const tsMs = rawTs ? (rawTs > 1e12 ? rawTs : rawTs * 1000) : now;
                const dateStr = timeEngine.dateKey(tsMs);
                const isOut = Boolean(m.key?.fromMe);

                totals.messages += 1;
                if (isOut) totals.outgoing += 1; else totals.incoming += 1;
                totals.categories[category] = (totals.categories[category] || 0) + 1;
                totals.chatTypes[normalizedType] = (totals.chatTypes[normalizedType] || 0) + 1;
                allDayDates.add(dateStr);

                const bucket = dayMap.get(dateStr);
                if (bucket) {
                    bucket.total += 1;
                    if (isOut) bucket.outgoing += 1; else bucket.incoming += 1;
                    bucket.categories[category] = (bucket.categories[category] || 0) + 1;
                    bucket.chatTypes[normalizedType] = (bucket.chatTypes[normalizedType] || 0) + 1;
                }
            }
        }

        totals.daysActive = allDayDates.size;
        const dailyList = [...dayMap.values()];
        const windowMessages = dailyList.reduce((sum, row) => sum + row.total, 0);
        const today = dailyList[dailyList.length - 1] || null;

        return {
            windowDays,
            windowMessages,
            todayMessages: today ? today.total : 0,
            days: dailyList,
            totals,
            generatedAt: new Date(now).toISOString()
        };
    }

    getAnalyticsPayload() {
        const entries = this._allEntries();
        const chatMap = new Map();
        for (const e of entries) {
            if (!e.jid) continue;
            const chat = chatMap.get(e.jid) || { jid: e.jid, count: 0, last: 0 };
            chat.count++;
            chat.last = Math.max(chat.last, e.ts || 0);
            chatMap.set(e.jid, chat);
        }
        const chats = [...chatMap.values()].sort((a, b) => b.last - a.last);
        const totalMessages = entries.length;
        const hourlyHeatmap = this.getHourlyHeatmap(null, entries);
        const dailyTrends = this.getDailyTrends(7, entries);
        const peakMessages = Math.max(0, ...hourlyHeatmap);
        const dailySummary = this.aggregateDailySummary(7);
        return {
            totalChats: chats.length,
            totalMessages,
            hourlyHeatmap,
            dailyTrends,
            dailySummary,
            peakHour: peakMessages ? hourlyHeatmap.indexOf(peakMessages) : null,
            peakHourMessages: peakMessages,
            todayMessages: dailyTrends[dailyTrends.length - 1]?.count || 0,
            kinds: this.getMessageTypeDistribution(entries),
            topChatters: this.getTopChatters(6, entries),
            recentChats: chats.slice(0, 8),
            source: Object.keys(this.store).length ? 'live-log' : 'sync-cache',
            // Live anti-ban quota, so the dashboard can show the same limits that gate sends.
            antiBan: antiBanEngine.getSecurityStatus()
        };
    }

    analyze(jid, label = '') {
        const entries = this.store[jid] || [];
        if (!entries.length) return null;
        const total = entries.length;
        const first = entries[0].ts, last = entries[entries.length - 1].ts;
        const days = Math.max((last - first) / 86400000, 0.04);
        const perDay = (total / days).toFixed(1);

        const senders = {};
        for (const e of entries) {
            const key = e.fromMe ? 'You (bot)' : (String(e.from || '').split('@')[0].split(':')[0] || 'unknown');
            senders[key] = (senders[key] || 0) + 1;
        }
        const topSenders = Object.entries(senders).sort((a, b) => b[1] - a[1]).slice(0, 8);

        const hours = this._hourly(entries);
        const topHours = hours.map((c, h) => ({ c, h })).filter(x => x.c > 0).sort((a, b) => b.c - a.c).slice(0, 4);

        const kinds = {};
        for (const e of entries) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
        const kindList = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${describe({ kind: k }).split(' ')[0]} ${k} ${c}`);

        const links = entries.filter(e => /https?:\/\//i.test(e.text || '')).length;
        const questions = entries.filter(e => /\?\s*$/.test(e.text || '')).length;
        const words = this._topWords(entries);

        const lines = [
            `📊 <b>Chat analysis</b> — <code>${label || jid}</code>`,
            '',
            `Messages: <b>${total}</b> over ${(days).toFixed(1)} day(s) — <b>${perDay}/day</b>`,
            `Window: ${this._fmtTs(first)} → ${this._fmtTs(last)}`
        ];
        if (topSenders.length) {
            lines.push('', '<b>Top participants</b>');
            for (const [s, c] of topSenders) lines.push(`• ${s === 'You (bot)' ? '🤖 You (bot)' : `👤 <code>${s}</code>`} — ${c} (${Math.round(c / total * 100)}%)`);
        }
        if (topHours.length) {
            lines.push('', '<b>Busiest hours</b>');
            lines.push(topHours.map(x => `${String(x.h).padStart(2, '0')}:00 (${x.c})`).join(' • '));
        }
        if (kindList.length) lines.push('', '<b>Message mix</b>', kindList.slice(0, 8).join(' • '));
        if (words.length) {
            lines.push('', '<b>Top words</b>');
            lines.push(words.map(([w, c]) => `${w} (${c})`).join(' • '));
        }
        lines.push('', `Links: ${links} • Questions: ${questions}`);
        return lines.join('\n');
    }

    globalSummary() {
        const chats = this.chats();
        if (!chats.length) return null;
        const total = chats.reduce((s, c) => s + c.count, 0);
        const groups = chats.filter(c => c.jid.endsWith('@g.us')).length;
        const lines = [
            '📊 <b>Global analysis</b>',
            '',
            `Chats seen: <b>${chats.length}</b> (${groups} groups) • Messages stored: <b>${total}</b>`
        ];
        for (const c of chats.slice(0, 10)) {
            lines.push(`• <code>${c.jid}</code> — ${c.count} msgs, last ${this._fmtTs(c.last)}`);
        }
        if (chats.length > 10) lines.push(`…and ${chats.length - 10} more`);
        return lines.join('\n');
    }
}

module.exports = new AnalyzeEngine();

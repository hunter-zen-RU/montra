/**
 * Montra — bookmark (pin) engine.
 * Persists tagged WhatsApp messages so they survive cache pruning and are easy
 * to find again from Telegram. Storage shape:
 *   { version, bookmarks: [{ id, jid, messageId, sender, fromMe, ts, text, note, createdAt }] }
 * Dedupe key is (jid, messageId): pinning the same message twice updates the
 * note instead of creating a second entry.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const BOOKMARK_FILE = process.env.MONTRA_BOOKMARKS_FILE
    || path.join(DATA_DIR, 'montraBookmarks.json');

const MAX_BOOKMARKS = 2000;
const MAX_TEXT = 600;
const MAX_NOTE = 300;

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(BOOKMARK_FILE, 'utf8').replace(/^\uFEFF/, ''));
        if (raw && typeof raw === 'object' && Array.isArray(raw.bookmarks)) return raw;
    } catch { /* first run or unreadable file */ }
    return { version: 1, bookmarks: [] };
}

function newId(existing) {
    let id;
    do {
        id = `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    } while (existing.some(b => b.id === id));
    return id;
}

class BookmarkEngine {
    constructor() {
        this.bookmarks = load().bookmarks
            .filter(b => b && typeof b === 'object')
            .slice(0, MAX_BOOKMARKS);
    }

    _save() {
        try {
            fs.mkdirSync(path.dirname(BOOKMARK_FILE), { recursive: true });
            fs.writeFileSync(BOOKMARK_FILE, JSON.stringify({ version: 1, bookmarks: this.bookmarks }, null, 2), { mode: 0o600 });
        } catch (e) {
            console.error('[Montra] bookmark save failed:', e.message);
        }
    }

    /**
     * Add (or update the note of) a bookmark.
     * @param {object} entry { jid, messageKey|messageId, sender, fromMe, ts, text, note }
     * @returns {object} the stored bookmark
     */
    add(entry = {}) {
        const jid = String(entry.jid || '').trim();
        const messageId = String(entry.messageId || entry.messageKey || '').trim();
        if (!jid) throw new Error('Bookmark needs a chat JID.');
        if (!messageId) throw new Error('Bookmark needs the original message id.');
        // Only build fields that were actually passed, so an update that just
        // edits the note never clobbers the original timestamp, sender or text.
        const clean = {};
        if (entry.sender !== undefined) clean.sender = String(entry.sender).slice(0, 120);
        if (entry.fromMe !== undefined) clean.fromMe = entry.fromMe === true;
        if (entry.ts !== undefined) clean.ts = Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : Date.now();
        if (entry.text !== undefined) clean.text = String(entry.text).slice(0, MAX_TEXT);
        if (entry.note !== undefined) clean.note = String(entry.note).trim().slice(0, MAX_NOTE);
        const existing = this.bookmarks.find(b => b.jid === jid && b.messageId === messageId);
        if (existing) {
            Object.assign(existing, clean, { id: existing.id, createdAt: existing.createdAt });
            this._save();
            return { ...existing };
        }
        if (this.bookmarks.length >= MAX_BOOKMARKS) throw new Error(`Maximum of ${MAX_BOOKMARKS} bookmarks reached.`);
        const bookmark = {
            id: newId(this.bookmarks),
            jid,
            messageId,
            ...clean,
            createdAt: Date.now()
        };
        this.bookmarks.push(bookmark);
        this._save();
        return { ...bookmark };
    }

    remove(idOrIndex) {
        let removed = null;
        if (Number.isInteger(idOrIndex) && idOrIndex >= 1 && idOrIndex <= this.bookmarks.length) {
            removed = this.bookmarks.splice(idOrIndex - 1, 1)[0];
        } else {
            const needle = String(idOrIndex || '').toLowerCase();
            const at = this.bookmarks.findIndex(b => b.id.toLowerCase() === needle);
            if (at >= 0) removed = this.bookmarks.splice(at, 1)[0];
        }
        if (removed) this._save();
        return removed ? { ...removed } : null;
    }

    get(id) {
        const needle = String(id || '').toLowerCase();
        const found = this.bookmarks.find(b => b.id.toLowerCase() === needle);
        return found ? { ...found } : null;
    }

    /**
     * List bookmarks, newest first.
     * @param {object} opts { jid, limit }
     */
    list(opts = {}) {
        let rows = this.bookmarks.slice();
        if (opts.jid) rows = rows.filter(b => b.jid === opts.jid);
        rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;
        return rows.slice(0, limit).map(b => ({ ...b }));
    }

    count(jid = null) {
        if (!jid) return this.bookmarks.length;
        return this.bookmarks.filter(b => b.jid === jid).length;
    }

    stats() {
        const perChat = {};
        for (const b of this.bookmarks) perChat[b.jid] = (perChat[b.jid] || 0) + 1;
        return {
            total: this.bookmarks.length,
            max: MAX_BOOKMARKS,
            chats: Object.keys(perChat).length,
            perChat
        };
    }
}

module.exports = new BookmarkEngine();
module.exports.BookmarkEngine = BookmarkEngine;
module.exports.BOOKMARK_FILE = BOOKMARK_FILE;
module.exports.MAX_BOOKMARKS = MAX_BOOKMARKS;

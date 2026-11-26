/**
 * Montra — feature commands plugin (v1.3.0).
 *
 * Registers the newer Telegram commands WITHOUT growing lib/telegramEngine.js:
 *   /pin <n> [note], /pins [chat], /unpin <n>  — persistent message bookmarks
 *   /export ... [--format txt|csv|json]        — formatted cached-message exports
 *
 * Registration model: settings.js (the first project module index.js loads)
 * requires this file as its last line. That makes the self-registration at the
 * bottom of this file wrap TelegramEngine.prototype._registerHandlers BEFORE
 * TelegramEngine.init() runs. The wrapper does:
 *   1. registerExportOverride(bot, engine) BEFORE the engine handlers, so the
 *      formatted /export middleware sits in front of the built-in text-only
 *      /export handler (Telegraf stops the chain at the first handler that
 *      does not call next()). The middleware re-checks the security lock and
 *      the chat allow-list itself, because it runs ahead of the unified gate;
 *      anything it does not own is passed straight through to the gate.
 *   2. registerBookmarkCommands(bot, engine) AFTER the engine handlers — brand
 *      new commands, no conflicts, already behind the security gate.
 */
const { decode: decodeMessage, describe: describeMessage } = require('./messageDecoder');
const bookmarkEngine = require('./bookmarkEngine');
const exportFormatter = require('./exportFormatter');

// Local copies of the telegramEngine helpers (they are not exported).
function sanitizeUtf8(s) {
    return String(s ?? '')
        .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : ''))
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
function escapeHtml(s) {
    return sanitizeUtf8(String(s ?? '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function safeSlice(s, n) {
    return sanitizeUtf8(String(s ?? '')).slice(0, n);
}

// Telegram chat id -> last /pins list (for /unpin <n>); never persisted.
const pinSelections = new Map();

function registerExportOverride(bot, engine) {
    bot.use(async (ctx, next) => {
        const text = String(ctx.message?.text || '');
        if (!/^\/export(?:@\w+)?(?:\s|$)/i.test(text)) return next();
        // Run ahead of the unified gate, so re-apply its two checks first:
        // a locked system and unknown chats must never reach the handler.
        try {
            if (require('./securityEngine').isLocked()) return next();
            if (!engine.isAllowed(ctx)) return next();
        } catch { return next(); }

        const raw = text.replace(/^\/export(?:@\w+)?/i, '').trim();
        const active = engine._activeJid(ctx);
        // --format=csv|json|txt (or a bare csv/json/txt word) selects the file type.
        const formatFlag = raw.match(/(?:^|\s)(--format=\w+|\b(?:csv|json|txt|text)\b)(?=\s|$)/i);
        const format = formatFlag ? exportFormatter.resolveFormat(formatFlag[1]) : exportFormatter.resolveFormat('');
        if (!format) return ctx.reply('Unknown format. Supported: txt, csv, json (e.g. /export <chat> 100 --format=csv).');
        const cleaned = raw.replace(formatFlag?.[0] || '', '').trim();
        const match = cleaned.match(/^(.*?)(?:\s+(\d+))?$/);
        const target = (match?.[1] || '').trim();
        const jid = target ? engine._resolveJid(target) : active;
        const count = Math.min(100, Math.max(1, Number(match?.[2]) || 100));
        const store = engine.deps?.getSyncStore?.();
        if (!store) return ctx.reply('❌ Local sync store is unavailable.');
        if (!jid) return ctx.reply('Usage: /export [chat | JID | number] [count] [--format txt|csv|json]. Open a chat first to export it without a target.');
        const rows = store.getMessages(jid, count).slice().reverse();
        if (!rows.length) return ctx.reply('📭 No cached messages found for that chat.');
        const contacts = engine.deps?.getContacts?.() || {};
        const title = engine._chatTitle(jid, contacts);
        const output = Buffer.from(sanitizeUtf8(format.build(rows, {
            jid,
            title,
            contacts,
            fmtTs: (ts) => engine._fmtTs(ts),
            decode: decodeMessage
        })), 'utf8');
        if (output.length > 10 * 1024 * 1024) return ctx.reply('❌ Export is larger than 10 MB. Request a smaller count.');
        return ctx.replyWithDocument({ source: output, filename: `montra-${jid.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.${format.format}` }, {
            caption: `📄 Exported ${rows.length} cached messages from ${safeSlice(title, 150)} as ${format.format.toUpperCase()}.`
        });
    });
}

function registerBookmarkCommands(bot, engine) {
    bot.command('pin', async (ctx) => {
        const parts = ctx.message.text.replace(/^\/pin(?:@\w+)?/i, '').trim();
        const m = parts.match(/^(\d+)(?:\s+([\s\S]+))?$/);
        const selection = engine.historySelections.get(String(ctx.chat.id));
        const n = Number(m?.[1]);
        const row = selection?.rows?.[n - 1];
        if (!selection || !Number.isInteger(n) || n < 1 || !row) {
            return ctx.reply('Usage: /pin <n> [note] after /history. The number refers to a message in the latest history list.');
        }
        try {
            const decoded = decodeMessage(row.message) || {};
            const contacts = engine.deps?.getContacts?.() || {};
            const senderJid = row.key?.participant || selection.jid;
            const bookmark = bookmarkEngine.add({
                jid: selection.jid,
                messageId: row.key?.id,
                sender: row.key?.fromMe ? 'You' : (contacts[senderJid]?.name || senderJid.split('@')[0]),
                fromMe: row.key?.fromMe === true,
                ts: row.messageTimestamp ? row.messageTimestamp * 1000 : Date.now(),
                text: safeSlice(decoded.text || describeMessage(decoded), 600),
                note: m?.[2] || ''
            });
            engine._audit('bookmark_add', { chatId: String(ctx.chat.id), jid: bookmark.jid, messageId: bookmark.messageId });
            return ctx.reply(`📌 Bookmarked (${bookmarkEngine.count(selection.jid)} in this chat)${bookmark.note ? `\nNote: ${escapeHtml(safeSlice(bookmark.note, 150))}` : ''}\n${escapeHtml(safeSlice(bookmark.text, 150))}`);
        } catch (e) {
            return ctx.reply(`❌ Could not bookmark: ${escapeHtml(e.message)}`);
        }
    });

    bot.command('pins', async (ctx) => {
        const raw = ctx.message.text.replace(/^\/pins(?:@\w+)?/i, '').trim();
        const jid = raw ? engine._resolveJid(raw) : engine._activeJid(ctx);
        const bookmarks = bookmarkEngine.list({ jid: jid || null, limit: 20 });
        if (!bookmarks.length) {
            return ctx.reply(jid
                ? '📭 No bookmarks for that chat yet. Pin one with /history then /pin <n>.'
                : '📭 No bookmarks yet. Open a chat, run /history, then /pin <n> [note].');
        }
        const contacts = engine.deps?.getContacts?.() || {};
        const title = jid ? engine._chatTitle(jid, contacts) : 'all chats';
        pinSelections.set(String(ctx.chat.id), { jid: jid || null, rows: bookmarks });
        const lines = bookmarks.map((b, i) => {
            const who = b.fromMe ? 'You' : (b.sender || String(b.jid).split('@')[0]);
            const stamp = engine._fmtTs(Math.floor(b.ts / 1000));
            return `${i + 1}. <b>${escapeHtml(who)}</b> • ${escapeHtml(stamp)}${b.note ? ` • 🏷 ${escapeHtml(safeSlice(b.note, 80))}` : ''}\n${escapeHtml(safeSlice(b.text, 200))}`;
        });
        return ctx.reply(`📌 <b>Bookmarks: ${escapeHtml(safeSlice(title, 150))}</b> — newest first (${bookmarkEngine.count(jid)} in chat, ${bookmarkEngine.count()} total)\n\n${lines.join('\n\n')}\n\n/unpin &lt;n&gt; removes one; /pins &lt;chat&gt; switches chats.`, { parse_mode: 'HTML' });
    });

    bot.command('unpin', async (ctx) => {
        const n = Number(ctx.message.text.replace(/^\/unpin(?:@\w+)?/i, '').trim());
        const selection = pinSelections.get(String(ctx.chat.id));
        const target = selection?.rows?.[n - 1];
        if (!selection || !Number.isInteger(n) || n < 1 || !target) {
            return ctx.reply('Usage: /unpin <n> after /pins. The number refers to a bookmark in the latest /pins list.');
        }
        const removed = bookmarkEngine.remove(target.id);
        if (removed) {
            selection.rows.splice(n - 1, 1);
            engine._audit('bookmark_remove', { chatId: String(ctx.chat.id), jid: removed.jid, messageId: removed.messageId });
        }
        return ctx.reply(removed ? `🗑 Bookmark removed.\n${escapeHtml(safeSlice(removed.text, 150))}` : '❌ Bookmark was already gone.');
    });
}

module.exports = { registerExportOverride, registerBookmarkCommands, pinSelections };

// Self-registration: settings.js (the first project module index.js loads)
// pulls in this file before the bridge starts, so by the time
// TelegramEngine.init() runs, _registerHandlers below is already wrapped.
// Guarded and idempotent; requires settings.js to keep its loader line last.
const telegramEngine = require('./telegramEngine');
const EngineCtor = Object.getPrototypeOf(telegramEngine)?.constructor;
if (EngineCtor && typeof EngineCtor.prototype?._registerHandlers === 'function'
    && !EngineCtor.prototype.__montraFeatureCommands) {
    EngineCtor.prototype.__montraFeatureCommands = true;
    const origRegisterHandlers = EngineCtor.prototype._registerHandlers;
    EngineCtor.prototype._registerHandlers = function registerHandlersWithFeatures() {
        registerExportOverride(this.bot, this);
        origRegisterHandlers.call(this);
        registerBookmarkCommands(this.bot, this);
    };
}

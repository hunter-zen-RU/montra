/**
 * Montra — cached-message export formatters.
 * Pure functions: no fs, no network, no Telegram. /export picks the format,
 * these functions build the payload. Row shape is a sync store message:
 *   { key: { remoteJid, id, fromMe, participant }, message, messageTimestamp }
 */
const MAX_BODY = 3000;

function clip(value, max = MAX_BODY) {
    const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function senderLabel(row, contacts = {}, jid = '') {
    if (row?.key?.fromMe) return 'You';
    const senderJid = row?.key?.participant || jid;
    return contacts[senderJid]?.name || String(senderJid).split('@')[0] || 'unknown';
}

function bodyOf(row, decode) {
    const decoded = decode(row.message) || {};
    if (decoded.text) return decoded.text;
    if (decoded.kind) return `[${decoded.kind}]`;
    return '[media]';
}

/** Tab-separated text export (the classic Montra format). */
function toText(rows, { jid = '', title = '', contacts = {}, fmtTs = (t) => String(t), decode }) {
    const lines = [
        `Montra message export: ${clip(title, 150)}`,
        `Chat: ${jid}`,
        `Messages: ${rows.length}`,
        ''
    ];
    for (const row of rows) {
        const stamp = row.messageTimestamp ? fmtTs(row.messageTimestamp) : 'time unavailable';
        lines.push(`[${stamp}] ${senderLabel(row, contacts, jid)}: ${clip(bodyOf(row, decode))}`);
    }
    return lines.join('\n');
}

const CSV_COLUMNS = ['timestamp', 'sender', 'from_me', 'message_id', 'body'];

function csvField(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180-ish CSV; newlines inside a body are quoted, header row always present. */
function toCsv(rows, { jid = '', contacts = {}, fmtTs = (t) => String(t), decode }) {
    const lines = [CSV_COLUMNS.join(',')];
    for (const row of rows) {
        const stamp = row.messageTimestamp ? fmtTs(row.messageTimestamp) : '';
        const body = bodyOf(row, decode).replace(/\r?\n/g, ' ').trim();
        lines.push([
            csvField(stamp),
            csvField(senderLabel(row, contacts, jid)),
            csvField(row?.key?.fromMe ? 'true' : 'false'),
            csvField(row?.key?.id || ''),
            csvField(clip(body))
        ].join(','));
    }
    return lines.join('\n');
}

/** JSON export: decoded metadata plus body, one object per message. */
function toJson(rows, { jid = '', title = '', contacts = {}, fmtTs = (t) => String(t), decode }) {
    return JSON.stringify({
        source: 'montra',
        chat: jid,
        title: clip(title, 150),
        messages: rows.map(row => ({
            id: row?.key?.id || '',
            chat: jid,
            sender: senderLabel(row, contacts, jid),
            fromMe: row?.key?.fromMe === true,
            timestamp: row.messageTimestamp ? fmtTs(row.messageTimestamp) : null,
            body: clip(bodyOf(row, decode), 8000)
        }))
    }, null, 2);
}

/**
 * Pick a formatter by name. Accepts the flag form ("--format=csv") or bare
 * ("csv", "json", "txt"/"text"). Unknown names return null so callers can
 * show a usage hint instead of silently exporting the wrong thing.
 */
function resolveFormat(name) {
    const value = String(name || '').toLowerCase().replace(/^--format=/, '').trim();
    if (['txt', 'text', ''].includes(value)) return { format: 'txt', build: toText };
    if (value === 'csv') return { format: 'csv', build: toCsv };
    if (value === 'json') return { format: 'json', build: toJson };
    return null;
}

module.exports = { toText, toCsv, toJson, resolveFormat, clip, csvField, senderLabel, bodyOf, CSV_COLUMNS, MAX_BODY };

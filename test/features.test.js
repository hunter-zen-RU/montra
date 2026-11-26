const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolated data dir so the bookmark store never touches a live installation.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'montra-features-'));
process.env.MONTRA_DATA_DIR = dataDir;
process.env.MONTRA_BOOKMARKS_FILE = path.join(dataDir, 'montraBookmarks.json');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const bookmarkEngine = require('../lib/bookmarkEngine');
const exportFormatter = require('../lib/exportFormatter');
const { renderTemplate } = require('../lib/autoReplyEngine');
const { decode } = require('../lib/messageDecoder');

test('bookmark engine adds, dedupes, lists and removes bookmarks', () => {
    const jid = '15550002000@s.whatsapp.net';
    const first = bookmarkEngine.add({
        jid,
        messageId: 'msg-1',
        sender: 'Alice',
        fromMe: false,
        ts: 1700000000000,
        text: 'meeting at noon',
        note: 'agenda'
    });
    assert.match(first.id, /^bm-/);
    assert.equal(first.note, 'agenda');

    // Same chat + message id updates the note instead of duplicating.
    const updated = bookmarkEngine.add({ jid, messageId: 'msg-1', note: 'moved to 3pm' });
    assert.equal(updated.id, first.id);
    assert.equal(updated.note, 'moved to 3pm');
    assert.equal(bookmarkEngine.count(jid), 1);

    bookmarkEngine.add({ jid, messageId: 'msg-2', sender: 'Alice', ts: 1700000900000, text: 'second' });
    bookmarkEngine.add({ jid: 'other@s.whatsapp.net', messageId: 'msg-3', ts: 1700000100000, text: 'other chat' });

    const rows = bookmarkEngine.list({ jid, limit: 10 });
    assert.deepEqual(rows.map(r => r.messageId), ['msg-2', 'msg-1']); // newest first
    assert.equal(bookmarkEngine.count(jid), 2);
    assert.equal(bookmarkEngine.count(), 3);

    const stats = bookmarkEngine.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.chats, 2);

    const removed = bookmarkEngine.remove(first.id);
    assert.equal(removed.messageId, 'msg-1');
    assert.equal(bookmarkEngine.remove(first.id), null);
    assert.equal(bookmarkEngine.get(first.id), null);
    assert.equal(bookmarkEngine.remove(1).messageId, 'msg-2');

    assert.throws(() => bookmarkEngine.add({ messageId: 'x' }), /JID/);
    assert.throws(() => bookmarkEngine.add({ jid: 'a@s.whatsapp.net' }), /message id/);
});

test('bookmarks persist to disk with restrictive permissions and reload', () => {
    const jid = '15550003000@s.whatsapp.net';
    bookmarkEngine.add({ jid, messageId: 'persist-1', text: 'survives reload' });
    const file = bookmarkEngine.BOOKMARK_FILE;
    assert.ok(fs.existsSync(file));
    // fs.statSync.mode reports the owner bits actually applied (umask-independent check).
    const mode = fs.statSync(file).mode & 0o777;
    assert.ok(mode <= 0o600, `file mode ${mode.toString(8)} should not be looser than 0600`);

    const { BookmarkEngine } = bookmarkEngine;
    const reloaded = new BookmarkEngine();
    assert.equal(reloaded.count(jid), 1);
    assert.equal(reloaded.list({ jid })[0].text, 'survives reload');
});

test('export formatter builds text, csv and json payloads', () => {
    const rows = [
        { key: { remoteJid: 'c@s.whatsapp.net', id: 'a', fromMe: false }, message: { conversation: 'hello "world"' }, messageTimestamp: 100 },
        { key: { remoteJid: 'c@s.whatsapp.net', id: 'b', fromMe: true }, message: { imageMessage: { caption: 'photo' } }, messageTimestamp: 200 }
    ];
    const contacts = { 'c@s.whatsapp.net': { name: 'Carol' } };
    const opts = { jid: 'c@s.whatsapp.net', title: 'Carol', contacts, fmtTs: (t) => `<${t}>`, decode };

    const text = exportFormatter.toText(rows, opts);
    assert.match(text, /Montra message export: Carol/);
    assert.match(text, /Messages: 2/);
    assert.match(text, /\[<100>\] Carol: hello "world"/);
    assert.match(text, /\[<200>\] You: photo/);

    const csv = exportFormatter.toCsv(rows, opts);
    const csvLines = csv.split('\n');
    assert.deepEqual(csvLines[0].split(','), exportFormatter.CSV_COLUMNS);
    assert.equal(csvLines[2], `<200>,You,true,b,photo`);

    const json = JSON.parse(exportFormatter.toJson(rows, opts));
    assert.equal(json.chat, 'c@s.whatsapp.net');
    assert.equal(json.messages.length, 2);
    assert.deepEqual(json.messages[0], {
        id: 'a',
        chat: 'c@s.whatsapp.net',
        sender: 'Carol',
        fromMe: false,
        timestamp: '<100>',
        body: 'hello "world"'
    });
    assert.equal(json.messages[1].sender, 'You');
    assert.equal(json.messages[1].body, 'photo');
});

test('csv quoting escapes commas, quotes and newlines', () => {
    assert.equal(exportFormatter.csvField('plain'), 'plain');
    assert.equal(exportFormatter.csvField('a,b'), '"a,b"');
    assert.equal(exportFormatter.csvField('say "hi"'), '"say ""hi"""');
    assert.equal(exportFormatter.csvField('line1\nline2'), '"line1\nline2"');
});

test('resolveFormat picks txt by default and rejects unknown names', () => {
    assert.equal(exportFormatter.resolveFormat('').format, 'txt');
    assert.equal(exportFormatter.resolveFormat('csv').format, 'csv');
    assert.equal(exportFormatter.resolveFormat('--format=json').format, 'json');
    assert.equal(exportFormatter.resolveFormat('TEXT').format, 'txt');
    assert.equal(exportFormatter.resolveFormat('xml'), null);
});

test('auto-reply templates expand name, trigger, chat, date and time', () => {
    const rendered = renderTemplate(
        'Hi {name}! You asked about "{trigger}" on {date} at {time} (chat {chat}).',
        { name: 'Alice', trigger: 'pricing', chat: '1555@s.whatsapp.net', date: '2026-11-25', time: '09:30' }
    );
    assert.equal(rendered, 'Hi Alice! You asked about "pricing" on 2026-11-25 at 09:30 (chat 1555@s.whatsapp.net).');

    // Unknown placeholders stay literal; text is capped at 800 chars.
    assert.equal(renderTemplate('keep {unknown} here', {}), 'keep {unknown} here');
    assert.equal(renderTemplate('x'.repeat(900), {}).length, 800);
    assert.equal(renderTemplate(null, {}), '');
});

test('featureCommands wires /export ahead of built-ins and bookmarks behind them', () => {
    const featureCommands = require('../lib/featureCommands');
    const calls = [];
    const bot = {
        use: (mw) => calls.push(['use', mw]),
        command: (name) => calls.push(['command', name])
    };
    const engine = {
        isAllowed: () => true,
        deps: {},
        historySelections: new Map()
    };
    featureCommands.registerExportOverride(bot, engine);
    featureCommands.registerBookmarkCommands(bot, engine);
    assert.equal(calls[0][0], 'use'); // /export interceptor must be middleware, registered first
    assert.deepEqual(calls.slice(1).map(c => [c[0], c[1]]), [['command', 'pin'], ['command', 'pins'], ['command', 'unpin']]);

    // Non-export messages pass straight through the interceptor.
    const nexted = [];
    const interceptor = calls[0][1];
    return Promise.resolve(interceptor({ message: { text: '/ping' } }, () => nexted.push(1)))
        .then(() => assert.deepEqual(nexted, [1]));
});

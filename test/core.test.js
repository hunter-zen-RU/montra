const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'montra-test-'));
process.env.MONTRA_DATA_DIR = dataDir;
process.env.MONTRA_SYNC_STORE = path.join(dataDir, 'syncStore.json');
delete process.env.TELEGRAM_START_PIN;
delete process.env.MONTRA_DEFAULT_GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.MONTRA_AI_API_KEY;

const { decode, describe } = require('../lib/messageDecoder');
const syncStore = require('../lib/syncStore');
const statusScheduler = require('../lib/statusScheduler');
const alertEngine = require('../lib/alertEngine');
const securityEngine = require('../lib/securityEngine');
const gemini = require('../lib/geminiResilient');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('message decoder unwraps text, captions and media', () => {
  const text = decode({ conversation: 'hello' });
  assert.equal(text.kind, 'text');
  assert.equal(text.text, 'hello');

  const photo = decode({ imageMessage: { caption: 'sunset', mimetype: 'image/jpeg' } });
  assert.equal(photo.kind, 'image');
  assert.equal(photo.text, 'sunset');
  assert.equal(describe(photo), '🖼 photo');

  const viewOnce = decode({ viewOnceMessageV2: { message: { imageMessage: {} } } });
  assert.equal(viewOnce.kind, 'image');
  assert.match(describe(viewOnce), /viewOnceV2/);
});

test('sync store keeps one copy per message and sorts newest first', () => {
  const jid = '15550001111@s.whatsapp.net';
  syncStore.recordMessage({ key: { remoteJid: jid, id: 'a' }, message: { conversation: 'first' }, messageTimestamp: 100 });
  syncStore.recordMessage({ key: { remoteJid: jid, id: 'b' }, message: { conversation: 'second' }, messageTimestamp: 200 });
  syncStore.recordMessage({ key: { remoteJid: jid, id: 'a' }, message: { conversation: 'duplicate' }, messageTimestamp: 100 });
  assert.deepEqual(syncStore.getMessages(jid, 10).map(m => m.key.id), ['b', 'a']);
  assert.equal(syncStore.stats().messages, 2);
  assert.equal(syncStore.chatKind(jid), 'chat');
  assert.equal(syncStore.chatKind('123@newsletter'), 'channel');
});

test('status scheduler writes a dated manifest and caption only for text', () => {
  const when = new Date(Date.now() + 3600_000).toISOString();
  const story = statusScheduler.scheduleStatus({ when, caption: 'Hello status', type: 'text' });
  assert.equal(story.status, 'pending');
  assert.equal(story.caption, 'Hello status');
  assert.equal(story.mediaFile, null);
  assert.match(story.folder, /^stories\/\d{4}-\d{2}-\d{2}$/);

  const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'stories', story.date, `${story.id}.json`), 'utf8'));
  assert.equal(manifest.caption, 'Hello status');
  assert.equal(manifest.scheduledAt, story.scheduledAt);

  const image = statusScheduler.scheduleStatus({ when, caption: 'ignored', type: 'image', mediaBuffer: Buffer.from('x'), filename: 'x.png' });
  assert.equal(image.caption, '');
  assert.match(image.mediaFile, /\.png$/);

  assert.throws(() => statusScheduler.scheduleStatus({ when: 'not-a-time', caption: 'x' }));
  assert.throws(() => statusScheduler.scheduleStatus({ when, caption: '   ' }));
  assert.equal(statusScheduler.deleteScheduled(story.date, story.id), true);
  assert.equal(statusScheduler.deleteScheduled(story.date, '../escape'), false);
});

test('scheduled status posts include the status audience', async () => {
  const own = '15559990000@s.whatsapp.net';
  const friend = '15559990001@s.whatsapp.net';
  syncStore.upsertContacts([{ id: friend, name: 'Bob' }]);
  const story = statusScheduler.scheduleStatus({ when: '+1m', caption: 'Audience test', type: 'text' });
  const sent = [];
  const sock = {
    user: { id: '15559990000:3@s.whatsapp.net', name: 'Test User' },
    sendMessage: async (jid, payload, options) => {
      sent.push({ jid, payload, options });
      return { key: { id: 'status-test' } };
    }
  };
  const telegramEngine = require('../lib/telegramEngine');
  telegramEngine.deps.getSocket = () => sock;

  await statusScheduler.postStatusPayload(sock, story);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, 'status@broadcast');
  assert.ok(sent[0].options.statusJidList.includes(own));
  assert.ok(sent[0].options.statusJidList.includes(friend));

  // Posted scheduled statuses must reach the dashboard status list, not just the queue.
  const mine = telegramEngine.getDashboardStatuses().find(row => row.id === 'status-test');
  assert.ok(mine);
  assert.equal(mine.participant, own);
  assert.equal(mine.kind, 'text');
  assert.equal(mine.text, 'Audience test');
});

test('scheduled media statuses are archived for the dashboard', async () => {
  const story = statusScheduler.scheduleStatus({ when: '+2m', type: 'image', mediaBuffer: Buffer.from('fake-image-bytes'), filename: 'scheduled.png' });
  const sock = {
    user: { id: '15559990000:3@s.whatsapp.net', name: 'Test User' },
    sendMessage: async () => ({ key: { id: 'status-media-test' } })
  };
  const telegramEngine = require('../lib/telegramEngine');
  telegramEngine.deps.getSocket = () => sock;

  await statusScheduler.postStatusPayload(sock, story);
  const row = telegramEngine.getDashboardStatuses().find(entry => entry.id === 'status-media-test');
  assert.ok(row);
  assert.equal(row.kind, 'image');
  assert.ok(row.mediaId, 'scheduled media should be archived and exposed to the dashboard');
});

test('status media resolves from a status id when the first archive attempt missed', async () => {
  const mediaArchive = require('../lib/mediaArchive');
  const telegramEngine = require('../lib/telegramEngine');
  const participant = '254711122233@s.whatsapp.net';
  const item = mediaArchive.saveBuffer(Buffer.from('lazy-image'), {
    jid: 'status@broadcast', messageId: 'lazy-status-1', isStatus: true,
    kind: 'image', mime: 'image/jpeg', filename: 'lazy.jpg'
  });
  telegramEngine.statusCache.unshift({
    jid: 'status@broadcast', from: participant, name: 'Lazy', ts: Date.now(),
    kind: 'image', text: 'lazy photo', archiveSkip: 'download_failed',
    message: {
      key: { remoteJid: 'status@broadcast', id: 'lazy-status-1', participant },
      message: { imageMessage: { caption: 'lazy photo', mimetype: 'image/jpeg' } }
    }
  });

  const row = telegramEngine.getDashboardStatuses().find(entry => entry.id === 'lazy-status-1');
  assert.equal(row.mediaId, '');
  assert.equal(row.hasMedia, true);

  // The viewer falls back to the status id, so a missed archive is retried by lookup.
  const resolved = await telegramEngine.resolveStatusMedia({ id: 'lazy-status-1', participant });
  assert.equal(resolved.item.id, item.id);
  assert.equal(mediaArchive.readBuffer(resolved.item).toString(), 'lazy-image');
  assert.equal(telegramEngine.statusCache[0].archiveId, item.id);
});

test('alert engine matches triggers, keywords and template variables', () => {
  fs.rmSync(path.join(dataDir, 'alertRules.json'), { force: true });
  const keyword = alertEngine.addRule('keyword:invoice', '🧾 {name} in {group}: {text}');
  const channel = alertEngine.addRule('channel', '📢 {chat_type}: {group} — {text}');

  const keywordHits = alertEngine.evaluate({
    type: 'dm', name: 'Alice', group: 'Direct Message', text: 'Please send the Invoice today', jid: '1@s.whatsapp.net'
  });
  assert.ok(keywordHits.some(hit => hit.ruleId === keyword.id && /Alice/.test(hit.message)));

  const channelHits = alertEngine.evaluate({
    type: 'channel', name: 'News', group: 'Montra News', text: 'v1.3 shipped', jid: '2@newsletter'
  });
  assert.ok(channelHits.some(hit => hit.ruleId === channel.id && /channel: Montra News/.test(hit.message)));

  alertEngine.toggleRule(keyword.id, false);
  assert.equal(alertEngine.evaluate({ type: 'dm', text: 'invoice' }).some(hit => hit.ruleId === keyword.id), false);
  assert.equal(alertEngine.removeRule(channel.id), true);
  assert.throws(() => alertEngine.addRule('bogus', 'nope'));
});

test('security engine hashes the PIN and enforces unlock lockout', () => {
  assert.equal(securityEngine.setPin('1234').ok, true);
  assert.equal(securityEngine.isLocked(), false);
  assert.equal(securityEngine.lock(undefined, 'test').ok, true);
  assert.equal(securityEngine.unlock('0000').ok, false);
  assert.equal(securityEngine.unlock('1234').ok, true);
  assert.equal(securityEngine.isLocked(), false);

  const raw = fs.readFileSync(path.join(dataDir, 'securityLock.json'), 'utf8');
  assert.equal(raw.includes('"1234"'), false);
  assert.match(raw, /pinHash/);
  assert.equal((fs.statSync(path.join(dataDir, 'securityLock.json')).mode & 0o777), 0o600);

  securityEngine.lock(undefined, 'test');
  for (let i = 0; i < 5; i++) securityEngine.unlock('9999');
  assert.ok(securityEngine.getStatus().lockoutUntil > Date.now());
  assert.equal(securityEngine.unlock('1234').ok, false);
});

test('forwarded-message buttons quote the message and stop streaming', async () => {
  const telegramEngine = require('../lib/telegramEngine');
  const jid = '15550002222@s.whatsapp.net';
  syncStore.recordMessage({
    key: { remoteJid: jid, id: 'qr-1', fromMe: false },
    message: { conversation: 'original text' },
    messageTimestamp: 300
  });

  const quoted = telegramEngine._quotedFor(jid, 'qr-1');
  assert.equal(quoted.key.id, 'qr-1');
  assert.equal(quoted.key.remoteJid, jid);
  assert.equal(quoted.message.conversation, 'original text');
  assert.equal(telegramEngine._quotedFor(jid, 'missing'), null);

  const buttons = telegramEngine._quickKeyboard(jid).inline_keyboard.flat();
  assert.ok(buttons.some(b => /^act:quickreply_/.test(b.callback_data)));
  assert.ok(buttons.some(b => /^act:stopstream_/.test(b.callback_data)));

  const replies = [];
  const ctx = { chat: { id: 4242 }, reply: (text) => { replies.push(text); return Promise.resolve(); } };
  await telegramEngine._beginQuickReply(ctx, jid, { messageId: 'qr-1', text: 'original text', fromMe: false });
  const pending = telegramEngine.pendingReplies.get('4242');
  assert.equal(pending.jid, jid);
  assert.equal(pending.messageId, 'qr-1');
  assert.equal(telegramEngine.config.activeChats['4242'], jid);
  assert.match(replies[0], /Quick reply/);
  assert.match(replies[0], /original text/);
  telegramEngine.pendingReplies.delete('4242');

  telegramEngine.config.streamMode = true;
  await telegramEngine._stopStreaming(ctx);
  assert.equal(telegramEngine.config.streamMode, false);
  assert.match(replies[1], /Stream mode stopped/);
});

test('gemini key resolution prefers default keys and defers custom providers', () => {
  const clear = () => ['MONTRA_DEFAULT_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MONTRA_AI_API_KEY'].forEach(k => delete process.env[k]);

  clear();
  assert.equal(gemini.hasDefaultGeminiKey(), false);
  assert.equal(gemini.getGeminiClient(), null);

  process.env.GEMINI_API_KEY = 'AIza-test-gemini';
  let status = gemini.getProviderStatus();
  assert.equal(status.defaultKeySource, 'GEMINI_API_KEY');
  assert.equal(status.usingDefaultGeminiKey, true);
  assert.notEqual(gemini.getGeminiClient(), null);

  process.env.MONTRA_DEFAULT_GEMINI_API_KEY = 'AIza-test-default';
  assert.equal(gemini.getProviderStatus().defaultKeySource, 'MONTRA_DEFAULT_GEMINI_API_KEY');

  clear();
  process.env.MONTRA_AI_API_KEY = 'sk-test-custom';
  status = gemini.getProviderStatus();
  assert.equal(status.provider, 'custom_other');
  assert.equal(status.customOtherProviderSpecified, true);
  assert.equal(gemini.getGeminiClient(), null);
  clear();
});

test('analyzeEngine aggregates daily synced counts and categories', () => {
  const analyzeEngine = require('../lib/analyzeEngine');
  const nowSec = Math.floor(Date.now() / 1000);
  const dmJid = '15551112222@s.whatsapp.net';
  const groupJid = '120363000000000001@g.us';
  syncStore.recordMessage({ key: { remoteJid: dmJid, id: 'sum-1', fromMe: false }, message: { conversation: 'hello' }, messageTimestamp: nowSec });
  syncStore.recordMessage({ key: { remoteJid: groupJid, id: 'sum-2', fromMe: true }, message: { imageMessage: { caption: 'pic', mimetype: 'image/jpeg' } }, messageTimestamp: nowSec });

  const summary = analyzeEngine.aggregateDailySummary(7);
  assert.equal(summary.windowDays, 7);
  assert.equal(summary.days.length, 7);
  assert.ok(summary.todayMessages >= 2);
  assert.ok(summary.totals.messages >= 2);
  assert.ok(summary.totals.categories.text >= 1);
  assert.ok(summary.totals.categories.image >= 1);
  assert.ok(summary.totals.chatTypes.chat >= 1);
  assert.ok(summary.totals.chatTypes.group >= 1);
});

test('dashboard serves settings export, daily summary, QR matrix, and phone pairing', async () => {
  const http = require('http');
  const dashboard = require('../lib/dashboard');
  const otmEngine = require('../lib/otmEngine');
  const timeEngine = require('../lib/timeEngine');

  securityEngine.state.isLocked = false;
  securityEngine.state.lockoutUntil = 0;
  timeEngine.setConfig({ timeZone: 'UTC', shiftMinutes: 0 });
  const server = dashboard.start({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    getConnection: () => ({ status: 'qr_ready', connected: false, user: null, qr: 'mock-qr-payload', qrUpdatedAt: 12345 }),
    requestPairingCode: async (digits) => `ABCD${digits.slice(-4)}`
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const getJson = (urlPath) => new Promise((resolve, reject) => {
    http.get(`${base}${urlPath}`, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });

  try {
    const exp = await getJson('/api/settings/export?token=test-token');
    assert.equal(exp.status, 200);
    assert.match(exp.headers['content-disposition'], /montra-system-settings\.json/);
    const exported = JSON.parse(exp.body);
    assert.equal(exported.timeConfig.timeZone, 'UTC');
    assert.ok(exported.systemSettings.app.name);

    const daily = await getJson('/api/daily-summary?token=test-token');
    assert.equal(daily.status, 200);
    const dailyJson = JSON.parse(daily.body);
    assert.equal(dailyJson.days.length, 7);

    const conn = await getJson('/api/connection?token=test-token');
    assert.equal(conn.status, 200);
    const connJson = JSON.parse(conn.body);
    assert.equal(connJson.hasQr, true);
    assert.ok(connJson.qrMatrix && connJson.qrMatrix.size > 0);

    const pairRes = await fetch(`${base}/api/connection/pair?token=test-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '+1 555 234 5678' })
    });
    assert.equal(pairRes.status, 200);
    const pairJson = await pairRes.json();
    assert.equal(pairJson.ok, true);
    assert.equal(pairJson.code, 'ABCD-5678');
  } finally {
    dashboard.stop();
    otmEngine.stop();
  }
});

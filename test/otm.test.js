const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'montra-otm-'));
process.env.MONTRA_DATA_DIR = dataDir;
process.env.MONTRA_SYNC_STORE = path.join(dataDir, 'syncStore.json');
process.env.MONTRA_OTM_KEY = 'otm-test-key-123456';
delete process.env.OTM_KEY;
delete process.env.TELEGRAM_START_PIN;

const otmEngine = require('../lib/otmEngine');
const syncStore = require('../lib/syncStore');
const securityEngine = require('../lib/securityEngine');
const dashboard = require('../lib/dashboard');

const KEY = 'otm-test-key-123456';
const calls = [];
const sender = async (jid, text) => {
  calls.push({ jid, text });
  return { ok: true, out: { key: { id: `mock-${calls.length}` } } };
};
otmEngine.start(sender);

test.after(() => {
  otmEngine.stop();
  dashboard.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('OTM key is required and separate from the dashboard token', () => {
  const missing = otmEngine.verifyKey('');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 401);
  assert.equal(missing.code, 'missing_key');

  const wrong = otmEngine.verifyKey('dashboard-token');
  assert.equal(wrong.code, 'invalid_key');

  const right = otmEngine.verifyKey(KEY);
  assert.equal(right.ok, true);

  const saved = process.env.MONTRA_OTM_KEY;
  delete process.env.MONTRA_OTM_KEY;
  const unconfigured = otmEngine.verifyKey(KEY);
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.code, 'otm_not_configured');
  process.env.MONTRA_OTM_KEY = saved;
});

test('invalid syntax returns a help message', async () => {
  const result = await otmEngine.execute({ method: 'GET', query: { key: KEY }, key: KEY });
  assert.equal(result.status, 400);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.returnValue, 1);
  assert.equal(result.json.code, 'invalid_syntax');
  assert.match(result.json.help, /api\/otm\?key=/);
});

test('link-style instant send substitutes {name} and records the job', async () => {
  const jid = '15550001111@s.whatsapp.net';
  syncStore.upsertContacts([{ id: jid, name: 'Alice' }]);
  const result = await otmEngine.execute({
    method: 'GET',
    query: { key: KEY, to: '15550001111', message: 'Hello {name} from {phone}' },
    key: KEY
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.returnValue, 0);
  assert.equal(result.json.code, 'sent');
  assert.equal(result.json.status, 'sent');
  assert.match(result.json.message, /sent/i);
  assert.equal(calls.at(-1).jid, jid);
  assert.equal(calls.at(-1).text, 'Hello Alice from 15550001111');
  const mode = fs.statSync(path.join(dataDir, 'otmJobs.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('messages are capped at 600 characters after substitution', async () => {
  const tooLong = await otmEngine.execute({
    method: 'GET',
    query: { key: KEY, to: '15550002222', message: 'x'.repeat(601) },
    key: KEY
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.code, 'message_too_long');

  const renderedTooLong = await otmEngine.execute({
    method: 'GET',
    query: { key: KEY, to: '15550002222', message: 'x'.repeat(590) + '{v}', vars: JSON.stringify({ v: 'y'.repeat(30) }) },
    key: KEY
  });
  assert.equal(renderedTooLong.status, 400);
  assert.equal(renderedTooLong.json.ok, false);
  assert.equal(renderedTooLong.json.code, 'message_too_long');
});

test('custom vars are validated and applied', async () => {
  const bad = await otmEngine.execute({
    method: 'GET',
    query: { key: KEY, to: '15550003333', message: 'Hi', vars: '[1,2]' },
    key: KEY
  });
  assert.equal(bad.json.code, 'invalid_vars');

  const ok = await otmEngine.execute({
    method: 'GET',
    query: { key: KEY, to: '15550003333', message: 'Code {code}', vars: JSON.stringify({ code: 'A1B2' }) },
    key: KEY
  });
  assert.equal(ok.json.ok, true);
  assert.equal(calls.at(-1).text, 'Code A1B2');
});

test('idempotency replays the original result without sending twice', async () => {
  const query = { key: KEY, to: '15550004444', message: 'Once', idempotencyKey: 'order-42' };
  const first = await otmEngine.execute({ method: 'GET', query, key: KEY });
  assert.equal(first.json.ok, true);
  const sentCount = calls.length;

  const second = await otmEngine.execute({ method: 'GET', query, key: KEY });
  assert.equal(second.json.ok, true);
  assert.equal(second.json.duplicate, true);
  assert.equal(second.json.id, first.json.id);
  assert.equal(calls.length, sentCount);
});

test('scheduled jobs stay pending until due and then send', async () => {
  const result = await otmEngine.execute({
    method: 'POST',
    body: { to: '15550005555', message: 'Later {name}', scheduleAt: '+1h' },
    key: KEY
  });
  assert.equal(result.status, 200);
  assert.equal(result.json.code, 'scheduled');
  assert.equal(result.json.status, 'scheduled');
  assert.ok(result.json.scheduledAt > Date.now());

  const job = otmEngine.jobs.find(row => row.id === result.json.id);
  assert.equal(job.status, 'pending');
  const before = calls.length;
  await otmEngine.processDue();
  assert.equal(calls.length, before);

  job.scheduledAt = Date.now() - 1;
  const processed = await otmEngine.processDue();
  assert.equal(processed.processed, 1);
  assert.equal(job.status, 'sent');
  assert.equal(calls.at(-1).text, 'Later +15550005555');
});

test('channel and broadcast recipients are rejected', async () => {
  const channel = await otmEngine.execute({
    method: 'GET',
    query: { key: KEY, to: '123456789@newsletter', message: 'hello' },
    key: KEY
  });
  assert.equal(channel.json.ok, false);
  assert.equal(channel.json.code, 'invalid_recipient');
});

test('HTTP endpoint bypasses the dashboard token but enforces the OTM key and lock', async () => {
  const server = dashboard.start({ host: '127.0.0.1', port: 0, token: 'dashboard-secret', sendOtm: sender });
  assert.ok(server);
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const help = await fetch(`${base}/api/otm/help`);
  assert.equal(help.status, 200);
  assert.match(await help.text(), /OTM API/);

  const noKey = await fetch(`${base}/api/otm?to=15550006666&message=hi`);
  assert.equal(noKey.status, 401);
  const noKeyBody = await noKey.json();
  assert.equal(noKeyBody.code, 'missing_key');
  assert.match(noKeyBody.help, /api\/otm/);

  // The dashboard token must never authenticate this API.
  const tokenAsKey = await fetch(`${base}/api/otm?token=dashboard-secret&to=15550006666&message=hi`);
  assert.equal(tokenAsKey.status, 401);
  assert.equal((await tokenAsKey.json()).code, 'missing_key');

  const wrongKey = await fetch(`${base}/api/otm?key=nope&to=15550006666&message=hi`);
  assert.equal(wrongKey.status, 401);

  const getSend = await fetch(`${base}/api/otm?key=${encodeURIComponent(KEY)}&to=15550006666&message=Link%20send`);
  assert.equal(getSend.status, 200);
  assert.equal((await getSend.json()).code, 'sent');

  const postSend = await fetch(`${base}/api/otm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-otm-key': KEY },
    body: JSON.stringify({ to: '15550007777', message: 'JSON send' })
  });
  assert.equal(postSend.status, 200);
  assert.equal((await postSend.json()).code, 'sent');

  const badJson = await fetch(`${base}/api/otm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-otm-key': KEY },
    body: '{not json'
  });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).code, 'invalid_json');

  securityEngine.lock('9999', 'test');
  const locked = await fetch(`${base}/api/otm?key=${encodeURIComponent(KEY)}&to=15550006666&message=hi`);
  assert.equal(locked.status, 423);
  securityEngine.unlock('9999', 'test');
});

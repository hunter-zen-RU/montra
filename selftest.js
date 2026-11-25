'use strict';
// Self-test engine: loads every module against a throwaway data directory, exercises each
// one, checks the dashboard over HTTP, then runs the node:test suite. Run with `npm run selftest`.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'montra-selftest-'));
process.env.MONTRA_DATA_DIR = dataDir;
process.env.MONTRA_SYNC_STORE = path.join(dataDir, 'syncStore.json');
process.env.MONTRA_FILE_STORE_DIR = path.join(dataDir, 'files');
for (const key of [
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_START_PIN', 'MONTRA_OTM_KEY', 'DASHBOARD_TOKEN',
  'MONTRA_DEFAULT_GEMINI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'MONTRA_AI_API_KEY'
]) delete process.env[key];

const LIB_DIR = path.join(ROOT, 'lib');
const TEST_DIR = path.join(ROOT, 'test');
const libFiles = fs.readdirSync(LIB_DIR).filter(name => name.endsWith('.js')).sort().map(name => path.join(LIB_DIR, name));
const testFiles = fs.readdirSync(TEST_DIR).filter(name => name.endsWith('.js')).sort().map(name => path.join(TEST_DIR, name));
const rootFiles = fs.readdirSync(ROOT).filter(name => name.endsWith('.js')).sort().map(name => path.join(ROOT, name));

let passed = 0;
const failures = [];

function detail(value) {
  return String(value && value.message ? value.message : value).split('\n').slice(0, 6).join('\n      ');
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}`);
    console.log(`      ${detail(error)}`);
  }
}

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function run() {
  console.log(`Montra self-test — data dir ${dataDir}\n`);

  await check('syntax: every project JavaScript file parses', () => {
    for (const file of [...rootFiles, ...libFiles, ...testFiles]) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${path.relative(ROOT, file)}: ${(result.stderr || '').trim()}`);
    }
  });

  await check('dependencies: every package.json dependency resolves', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies || {})) {
      try {
        require.resolve(name);
      } catch (err) {
        if (err && err.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
          const fallback = name === 'firebase' ? 'firebase/app' : path.join(ROOT, 'node_modules', name, 'package.json');
          if (name === 'firebase') require.resolve(fallback);
          else assert.ok(fs.existsSync(fallback), `Missing package ${name}`);
        } else {
          throw err;
        }
      }
    }
  });

  await check('modules: every lib module loads with exports', () => {
    for (const file of libFiles) {
      const loaded = require(file);
      assert.ok(loaded !== null && loaded !== undefined, `${path.basename(file)} exported nothing`);
      const names = [...Object.keys(loaded), ...Object.getOwnPropertyNames(loaded)];
      assert.ok(names.length > 0, `${path.basename(file)} has no exports`);
    }
  });

  await check('settings: package metadata is complete', () => {
    const settings = require('./settings');
    assert.equal(settings.name, 'Montra');
    assert.match(settings.version, /^v\d+\.\d+\.\d+/);
    assert.equal(typeof settings.ownerNumber, 'string');
    assert.match(settings.dataDir, /data$/);
  });

  await check('messageDecoder: text, captions and wrapped media decode', () => {
    const { decode, describe, bodyText, unwrapLayers } = require('./lib/messageDecoder');
    assert.equal(decode({ conversation: 'hello' }).text, 'hello');
    const photo = decode({ imageMessage: { caption: 'sunset', mimetype: 'image/jpeg' } });
    assert.equal(photo.kind, 'image');
    assert.equal(photo.text, 'sunset');
    assert.equal(describe(photo), '🖼 photo');
    const wrapped = decode({ viewOnceMessageV2: { message: { videoMessage: { caption: 'clip' } } } });
    assert.equal(wrapped.kind, 'video');
    assert.equal(bodyText(wrapped), 'clip');
    const layers = unwrapLayers({ ephemeralMessage: { message: { conversation: 'x' } } });
    assert.equal(layers.inner.conversation, 'x');
    assert.ok(layers.layers.length > 0);
  });

  await check('timeEngine: zones, wall-clock parsing and date keys', () => {
    const timeEngine = require('./lib/timeEngine');
    assert.equal(timeEngine.validateZone('Africa/Nairobi').ok, true);
    assert.equal(timeEngine.validateZone('Not/AZone').ok, false);
    const now = Date.now();
    const parsed = timeEngine.parseWallClock('+30m', now);
    assert.equal(typeof parsed, 'number');
    assert.ok(parsed >= now + 29 * 60000 && parsed <= now + 31 * 60000);
    assert.match(timeEngine.dateKey(now), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof timeEngine.describe().timeZone, 'string');
  });

  await check('syncStore: messages, contacts and chat kinds persist', () => {
    const syncStore = require('./lib/syncStore');
    const jid = '15550009999@s.whatsapp.net';
    syncStore.upsertContacts([{ id: jid, name: 'Self Test' }]);
    syncStore.recordMessage({
      key: { remoteJid: jid, id: 'selftest-msg' },
      message: { conversation: 'self test' },
      messageTimestamp: Math.floor(Date.now() / 1000)
    });
    assert.equal(syncStore.getMessageById(jid, 'selftest-msg').key.id, 'selftest-msg');
    assert.ok(syncStore.getMessages(jid, 5).length >= 1);
    assert.equal(syncStore.getContacts()[jid].name, 'Self Test');
    assert.equal(syncStore.chatKind(jid), 'chat');
    assert.equal(syncStore.chatKind('123@newsletter'), 'channel');
    assert.ok(syncStore.stats().messages >= 1);
  });

  await check('mediaArchive: saves, reads and removes media', () => {
    const mediaArchive = require('./lib/mediaArchive');
    const item = mediaArchive.saveBuffer(Buffer.from('selftest-media'), {
      jid: 'status@broadcast', messageId: 'selftest-media-1', isStatus: true,
      kind: 'image', mime: 'image/png', filename: 'self.png'
    });
    assert.ok(item && item.id, 'saveBuffer did not return an archive item');
    assert.equal(mediaArchive.getById(item.id).id, item.id);
    assert.equal(mediaArchive.readBuffer(item.id).toString(), 'selftest-media');
    assert.equal(mediaArchive.remove(item.id), true);
    assert.equal(mediaArchive.getById(item.id), null);
    assert.equal(mediaArchive.remove('missing'), false);
  });

  await check('statusScheduler: schedules, lists and deletes story manifests', () => {
    const statusScheduler = require('./lib/statusScheduler');
    const story = statusScheduler.scheduleStatus({ when: '+1h', caption: 'Self-test status', type: 'text' });
    assert.equal(story.status, 'pending');
    assert.equal(story.caption, 'Self-test status');
    assert.match(statusScheduler.getDateString(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(statusScheduler.listScheduled().some(row => row.id === story.id));
    assert.equal(statusScheduler.deleteScheduled(story.date, story.id), true);
    assert.equal(statusScheduler.deleteScheduled(story.date, '../escape'), false);
    assert.throws(() => statusScheduler.scheduleStatus({ when: 'not-a-time', caption: 'x' }));
  });

  await check('securityEngine: status shape and PIN verification', () => {
    const securityEngine = require('./lib/securityEngine');
    const status = securityEngine.getStatus();
    assert.equal(typeof status.isLocked, 'boolean');
    assert.equal(status.hasPin, true);
    assert.equal(typeof securityEngine.isLocked(), 'boolean');
    const wrong = securityEngine.unlock('0000');
    assert.equal(wrong.ok, false);
    assert.equal(securityEngine.setPin('selftest-pin').ok, true);
    assert.equal(securityEngine.unlock('selftest-pin').ok, true);
  });

  await check('otmEngine: help, status and key validation', () => {
    const otmEngine = require('./lib/otmEngine');
    assert.match(otmEngine.helpText(), /\/api\/otm/);
    const status = otmEngine.status();
    assert.equal(status.endpoint, '/api/otm');
    assert.equal(typeof status.pending, 'number');
    assert.equal(typeof otmEngine.keyInfo().configured, 'boolean');
    assert.equal(otmEngine.verifyKey('not-the-key').ok, false);
  });

  await check('alertEngine: rules evaluate and can be removed', () => {
    const alertEngine = require('./lib/alertEngine');
    const rule = alertEngine.addRule('keyword:selftest', 'Selftest hit: {text}');
    assert.ok(alertEngine.listRules().some(row => row.id === rule.id));
    const hits = alertEngine.evaluate({ type: 'dm', name: 'Tester', group: 'Direct', text: 'selftest ping', jid: '15550009999@s.whatsapp.net' });
    assert.ok(hits.some(hit => hit.ruleId === rule.id));
    assert.equal(alertEngine.removeRule(rule.id), true);
    assert.equal(alertEngine.listRules().some(row => row.id === rule.id), false);
  });

  await check('analyzeEngine: records messages and builds the dashboard payload', () => {
    const analyzeEngine = require('./lib/analyzeEngine');
    analyzeEngine.record(
      { key: { remoteJid: '15550008888@s.whatsapp.net', id: 'selftest-analytics', fromMe: false } },
      { kind: 'text', text: 'analytics self test' }
    );
    const payload = analyzeEngine.getAnalyticsPayload();
    assert.ok(payload && typeof payload === 'object');
    assert.ok(payload.totalMessages >= 1);
    assert.ok(Array.isArray(payload.hourlyHeatmap));
    assert.ok(Array.isArray(payload.dailyTrends));
    analyzeEngine.flush();
  });

  await check('antiBanEngine: config and send gate return expected shapes', () => {
    const antiBanEngine = require('./lib/antiBanEngine');
    const config = antiBanEngine.getConfig();
    assert.equal(typeof config.enabled, 'boolean');
    assert.equal(typeof config.warmupMode, 'boolean');
    const verdict = antiBanEngine.checkCanSend('15550007777@s.whatsapp.net', false, false);
    assert.equal(typeof verdict.allowed, 'boolean');
    assert.equal(typeof antiBanEngine.getSecurityStatus(), 'object');
  });

  await check('autoReplyEngine + humanizerEngine: rules and typing delays', () => {
    const autoReplyEngine = require('./lib/autoReplyEngine');
    const humanizerEngine = require('./lib/humanizerEngine');
    assert.equal(typeof autoReplyEngine.getConfig().enabled, 'boolean');
    const delay = humanizerEngine.calculateTypingDuration('hello there');
    assert.equal(typeof delay, 'number');
    assert.ok(delay >= 0);
    assert.equal(typeof humanizerEngine.getConfig().enabled, 'boolean');
  });

  await check('crmEngine: tags round-trip for a contact', () => {
    const crmEngine = require('./lib/crmEngine');
    const jid = '15550006666@s.whatsapp.net';
    assert.notEqual(crmEngine.addTag(jid, 'selftest', 'Tester'), false);
    assert.ok(crmEngine.getContact(jid).tags.includes('selftest'));
    assert.equal(crmEngine.removeTag(jid, 'selftest'), true);
    assert.equal(crmEngine.getContact(jid).tags.includes('selftest'), false);
  });

  await check('fileStoreEngine: sandboxed write, read, list and delete', () => {
    const fileStore = require('./lib/fileStoreEngine');
    const entry = fileStore.write('selftest/note.txt', Buffer.from('file-store'));
    assert.ok(entry);
    assert.equal(fileStore.read('selftest/note.txt').toString(), 'file-store');
    assert.ok(fileStore.list('selftest').total >= 1);
    assert.equal(fileStore.exists('selftest/note.txt'), true);
    const removed = fileStore.remove('selftest', { recursive: true });
    assert.equal(removed.removed, 'selftest');
    assert.equal(fileStore.exists('selftest/note.txt'), false);
    assert.throws(() => fileStore.toAbsolute('../outside'));
  });

  await check('backupManager: encrypted snapshot round-trips', () => {
    const backupManager = require('./lib/backupManager');
    const created = backupManager.createBackup('selftest-passphrase');
    assert.ok(created.encryptedFile, 'encrypted backup was not created');
    const restored = backupManager.decryptBackup(created.encryptedFile, 'selftest-passphrase');
    assert.equal(restored.manifest.encrypted, true);
    assert.equal(restored.manifest.excludesSessionCredentials, true);
    assert.ok(backupManager.listBackups().length >= 1);
  });

  await check('markdownEngine + telegramFormatting: rendering and sanitising', () => {
    const markdownEngine = require('./lib/markdownEngine');
    assert.match(markdownEngine.render('**bold**'), /<strong>bold<\/strong>/);
    assert.equal(markdownEngine.plainText('**bold** and `code`'), 'bold and code');
    const { sanitizeTelegramHtml } = require('./lib/telegramFormatting');
    const safe = sanitizeTelegramHtml('<b>ok</b><script>alert(1)</script>');
    assert.match(safe, /<b>ok<\/b>/);
    assert.equal(safe.includes('<script>'), false);
  });

  await check('geminiResilient + aiAssistant: provider status without network', () => {
    const gemini = require('./lib/geminiResilient');
    assert.equal(gemini.isTransientError({ status: 429, message: 'Too Many Requests' }), true);
    assert.equal(gemini.isTransientError('400 invalid request'), false);
    assert.ok(Array.isArray(gemini.TEXT_MODELS_CASCADE));
    const aiAssistant = require('./lib/aiAssistant');
    const status = aiAssistant.getProviderStatus();
    assert.equal(typeof status.provider, 'string');
    assert.equal(typeof aiAssistant.hasDefaultGeminiKey(), 'boolean');
  });

  await check('automationWizard: flows and sessions build', () => {
    const wizard = require('./lib/automationWizard');
    const flows = wizard.listFlows();
    assert.ok(Array.isArray(flows) && flows.length > 0);
    const flow = wizard.getFlow(flows[0].id);
    assert.ok(Array.isArray(flow.steps) && flow.steps.length > 0);
    const session = wizard.createSession(flows[0].id);
    assert.equal(wizard.currentStepOf(session).key, flow.steps[0].key);
  });

  await check('telegramEngine: posted statuses reach the dashboard list', () => {
    const telegramEngine = require('./lib/telegramEngine');
    telegramEngine.recordPostedStatus({
      message: { key: { id: 'selftest-status', remoteJid: 'status@broadcast' } },
      kind: 'text', text: 'self-test status', from: '15550005555:4@s.whatsapp.net', name: 'Self Test'
    });
    const row = telegramEngine.getDashboardStatuses().find(status => status.id === 'selftest-status');
    assert.ok(row, 'posted status was not exposed to the dashboard');
    assert.equal(row.participant, '15550005555@s.whatsapp.net');
    assert.equal(row.text, 'self-test status');
    assert.equal(row.hasMedia, false);
    assert.ok(telegramEngine.getStatusById('selftest-status', row.participant));
    assert.match(telegramEngine.sanitizeTelegramHtml('<b>x</b>'), /<b>x<\/b>/);
  });

  await check('dashboard: inline UI script parses and required views exist', () => {
    const html = fs.readFileSync(path.join(LIB_DIR, 'dashboard.html'), 'utf8');
    const open = html.indexOf('<script>');
    const close = html.indexOf('</script>', open);
    assert.ok(open >= 0 && close > open, 'dashboard inline script was not found');
    new Function(html.slice(open + 8, close));
    for (const id of ['app', 'conversation', 'statusViewer', 'toasts', 'lockScreen', 'chatSearch']) {
      assert.ok(html.includes(`id="${id}"`), `dashboard.html is missing #${id}`);
    }
  });

  await check('dashboard: authenticated HTTP API serves views and status', async () => {
    const dashboard = require('./lib/dashboard');
    const otmEngine = require('./lib/otmEngine');
    const server = dashboard.start({ host: '127.0.0.1', port: 0, token: 'selftest-token' });
    assert.ok(server, 'dashboard.start returned no server');
    try {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const denied = await request(`${base}/api/security`);
      assert.equal(denied.status, 401);
      const allowed = await request(`${base}/api/security?token=selftest-token`);
      assert.equal(allowed.status, 200);
      assert.equal(typeof JSON.parse(allowed.body).isLocked, 'boolean');
      const shell = await request(`${base}/?token=selftest-token`);
      assert.equal(shell.status, 200);
      assert.match(shell.body, /id="statusViewer"/);
    } finally {
      dashboard.stop();
      otmEngine.stop();
    }
  });

  await check('node:test: existing suite passes', () => {
    const result = spawnSync(process.execPath, ['--test'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    if (result.status !== 0) {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      throw new Error(output.slice(-2500) || `node --test exited with ${result.status}`);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`- ${failure.name}: ${detail(failure.error)}`);
  }
  process.exitCode = failures.length ? 1 : 0;
}

run()
  .catch(error => {
    console.error('\nSelf-test crashed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

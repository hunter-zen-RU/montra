'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'montra-fleet-test-'));
process.env.MONTRA_DATA_DIR = dataDir;
process.env.MONTRA_SYNC_STORE = path.join(dataDir, 'syncStore.json');
delete process.env.TELEGRAM_START_PIN;
delete process.env.MONTRA_DEFAULT_GEMINI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.MONTRA_AI_API_KEY;

const backupManager = require('../lib/backupManager');
const mediaArchive = require('../lib/mediaArchive');
const systemMonitor = require('../lib/systemMonitor');
const botEngine = require('../lib/botEngine');
const securityEngine = require('../lib/securityEngine');
const dashboard = require('../lib/dashboard');
const otmEngine = require('../lib/otmEngine');

test.after(() => {
  botEngine.stop();
  systemMonitor.stop();
  dashboard.stop();
  otmEngine.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('backupManager persists BACKUP_HOUR, enabled toggle and snapshot frequency', () => {
  const initial = backupManager.getScheduleConfig();
  assert.equal(typeof initial.enabled, 'boolean');
  assert.equal(typeof initial.backupHour, 'number');

  const updated = backupManager.setScheduleConfig({
    enabled: false,
    backupHour: 17,
    frequency: 'every6h',
    keepCount: 7
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.backupHour, 17);
  assert.equal(updated.frequency, 'every6h');
  assert.equal(updated.keepCount, 7);

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'backupConfig.json'), 'utf8'));
  assert.equal(persisted.backupHour, 17);
  assert.equal(persisted.frequency, 'every6h');
  assert.equal(persisted.enabled, false);

  assert.throws(() => backupManager.setScheduleConfig({ backupHour: 24 }));
  assert.throws(() => backupManager.setScheduleConfig({ frequency: 'minutely' }));

  const ts = Date.UTC(2026, 4, 10, 17, 15, 0);
  const keyEvery6h = backupManager.windowKeyFor(ts, { backupHour: 17, frequency: 'every6h' });
  assert.equal(keyEvery6h.due, true);
  assert.match(keyEvery6h.key, /^\d{4}-\d{2}-\d{2}-h\d{2}$/);
  const keyDaily = backupManager.windowKeyFor(ts, { backupHour: 17, frequency: 'daily' });
  assert.equal(typeof keyDaily.due, 'boolean');
  assert.match(keyDaily.key, /^\d{4}-\d{2}-\d{2}$/);
});

test('mediaArchive reports quota stats and clears cache', () => {
  const saved = mediaArchive.saveBuffer(Buffer.alloc(4096, 65), {
    jid: '15550003333@s.whatsapp.net',
    messageId: 'cache-test-1',
    kind: 'image',
    mime: 'image/jpeg',
    filename: 'cache.jpg'
  });
  assert.ok(saved && saved.id);

  const stats = mediaArchive.stats();
  assert.ok(stats.files >= 1);
  assert.ok(stats.usedBytes >= 4096);
  assert.equal(typeof stats.maxMb, 'number');
  assert.equal(typeof stats.usedMb, 'number');
  assert.equal(typeof stats.exceeded, 'boolean');

  // If below limit, onlyIfExceeded keeps files
  if (!stats.exceeded) {
    const skipped = mediaArchive.clearCache({ onlyIfExceeded: true });
    assert.equal(skipped.cleared, false);
    assert.equal(skipped.clearedFiles, 0);
  }

  // Force clear removes cached files and clears index
  const cleared = mediaArchive.clearCache({ onlyIfExceeded: false });
  assert.equal(cleared.cleared, true);
  assert.ok(cleared.clearedFiles >= 1);
  assert.ok(cleared.freedBytes >= 4096);
  assert.equal(mediaArchive.stats().files, 0);
});

test('systemMonitor measures CPU, RAM, storage buckets and history', () => {
  const snap = systemMonitor.snapshot();
  assert.ok(snap.cpu && typeof snap.cpu.systemPercent === 'number');
  assert.ok(snap.cpu.cores >= 1);
  assert.ok(snap.memory && snap.memory.totalMb > 0);
  assert.ok(snap.memory.process && snap.memory.process.rssMb > 0);
  assert.ok(snap.storage && snap.storage.dataDir);
  assert.ok(snap.runtime && snap.runtime.nodeVersion);
  const hist = systemMonitor.getHistory();
  assert.ok(hist.length >= 1);
});

test('botEngine coordinates website-bot + 6 bots, Selinah moderation, shell, AI fallback, and Telegram', async () => {
  const sentTelegram = [];
  const qrCalls = [];
  botEngine.init({
    getConnection: () => ({ status: 'qr_ready', connected: false, user: null }),
    refreshQr: async () => { qrCalls.push('refreshed'); return { ok: true }; },
    requestPairingCode: async (phone) => `PAIR-${phone.slice(-4)}`,
    getTelegramStatus: () => ({ configured: true, running: true, allowedChats: 1 }),
    sendTelegramAlert: (html) => { sentTelegram.push(html); }
  });

  const snap = botEngine.getSnapshot();
  const ids = snap.bots.map(b => b.id);
  for (const required of ['website-bot', 'bot-montra', 'bot-selinah', 'bot-caleb', 'bot-ruri', 'bot-katelina', 'bot-derric']) {
    assert.ok(ids.includes(required), `Missing bot ${required}`);
  }

  // Inter-bot communication & memory
  const busMsg = botEngine.sendBusMessage({ from: 'bot-derric', to: 'bot-montra', topic: 'ram_check', content: 'RAM healthy' });
  assert.equal(busMsg.from, 'bot-derric');
  assert.equal(busMsg.to, 'bot-montra');
  assert.ok(botEngine.getBot('bot-montra').memory.some(m => m.summary.includes('RAM healthy')));

  // Personality rules & memory update
  const updatedBot = botEngine.updateBotPersonality('bot-caleb', {
    personalityRules: ['Keep responses crisp', 'Verify chat context before replying'],
    addMemory: 'VIP contact prefers morning updates'
  });
  assert.equal(updatedBot.personalityRules.length, 2);
  assert.ok(updatedBot.memory.some(m => m.summary.includes('VIP contact')));

  // Selinah moderates shell commands strictly
  const allowedShell = await botEngine.requestShellCommand({ botId: 'bot-derric', command: 'node', args: ['-v'], reason: 'Check Node runtime' });
  assert.equal(allowedShell.ok, true);
  assert.equal(allowedShell.moderation.decision, 'allow');
  assert.match(allowedShell.stdout, /^v\d+/);

  const deniedInjection = await botEngine.requestShellCommand({ botId: 'bot-derric', command: 'uptime', args: ['&&', 'rm', '-rf', '/'] });
  assert.equal(deniedInjection.ok, false);
  assert.equal(deniedInjection.moderation.decision, 'deny');

  const deniedShellBin = await botEngine.requestShellCommand({ botId: 'bot-caleb', command: 'bash', args: ['-c', 'echo hi'] });
  assert.equal(deniedShellBin.ok, false);
  assert.equal(deniedShellBin.moderation.decision, 'deny');

  const deniedSecret = await botEngine.requestShellCommand({ botId: 'bot-derric', command: 'ls', args: ['.env'] });
  assert.equal(deniedSecret.ok, false);
  assert.equal(deniedSecret.moderation.decision, 'deny');

  // Strict mode queues medium-risk command for approval and executes after resolveApproval
  botEngine.updateSettings({ selinahStrictMode: true });
  const confirmReq = await botEngine.requestShellCommand({ botId: 'bot-derric', command: 'ls', args: ['package.json'], reason: 'Inspect package' });
  assert.equal(confirmReq.ok, false);
  assert.equal(confirmReq.moderation.decision, 'confirm');
  assert.ok(confirmReq.moderation.approvalId);
  const resolved = await botEngine.resolveApproval(confirmReq.moderation.approvalId, true);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.executed.ok, true);

  // Telegram dispatch from bot (HTML escaped + DLP checked)
  const tgOk = await botEngine.sendTelegramFromBot('bot-ruri', 'Report <ok> & ready', { kind: 'report' });
  assert.equal(tgOk.ok, true);
  assert.equal(tgOk.delivered, true);
  assert.ok(sentTelegram.some(msg => msg.includes('[bot-ruri]') && msg.includes('&lt;ok&gt;')));

  const tgBlocked = await botEngine.sendTelegramFromBot('bot-ruri', 'AIzaSyTestFakeSecretKeyValue1234567890');
  assert.equal(tgBlocked.ok, false);

  // Dispatch collaborative task + Website Bot action + Autonomous cycle
  const taskOut = await botEngine.dispatchTask({
    targetBot: 'bot-montra',
    prompt: 'Check RAM cache and today chat messages',
    useAi: true,
    deep: true,
    notifyTelegram: true
  });
  assert.equal(taskOut.ok, true);
  assert.ok(taskOut.responses.length >= 2);
  assert.ok(taskOut.report && taskOut.report.summary);

  const wbOut = await botEngine.runWebsiteBotAction('refresh_qr');
  assert.equal(wbOut.ok, true);
  assert.equal(qrCalls.length, 1);

  const beforeCycles = botEngine.getSnapshot().cycleCount;
  const cycleOut = await botEngine.runAutonomousCycle({ trigger: 'test_cycle', useAi: false });
  assert.equal(cycleOut.ok, true);
  assert.equal(cycleOut.cycleCount, beforeCycles + 1);

  // Communication stream & D3 dependency graph
  const streamAll = botEngine.getCommunicationStream({ limit: 50 });
  assert.ok(streamAll.items.length >= 4);
  assert.ok(streamAll.counts.thought >= 1);
  assert.ok(streamAll.counts.bus >= 1);
  assert.ok(streamAll.items.every(it => it.botColor && it.botName && it.category));

  const streamBus = botEngine.getCommunicationStream({ category: 'bus', botId: 'bot-derric' });
  assert.ok(streamBus.items.every(it => it.category === 'bus' && (it.botId === 'bot-derric' || it.targetBotId === 'bot-derric')));

  const graph = botEngine.getDependencyGraph();
  assert.equal(graph.nodes.length, 8);
  const selinahNode = graph.nodes.find(n => n.id === 'bot-selinah');
  const montraNode = graph.nodes.find(n => n.id === 'bot-montra');
  assert.equal(selinahNode.tier, 0);
  assert.equal(montraNode.tier, 1);
  assert.equal(typeof selinahNode.isActive, 'boolean');
  assert.equal(typeof selinahNode.resourceUsage.percent, 'number');
  assert.ok(graph.links.some(l => l.source === 'bot-selinah' && l.relation === 'moderates'));
});

test('dashboard serves backup config, media cache clear, monitor and bot API endpoints', async () => {
  securityEngine.state.isLocked = false;
  securityEngine.state.lockoutUntil = 0;

  const server = dashboard.start({
    host: '127.0.0.1',
    port: 0,
    token: 'fleet-token',
    getConnection: () => ({ status: 'qr_ready', connected: false, user: null, qr: 'mock-qr' })
  });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const reqJson = async (p, opts = {}) => {
    const res = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}token=fleet-token`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    return { status: res.status, data: await res.json() };
  };

  try {
    const bCfg = await reqJson('/api/backups/config', {
      method: 'POST',
      body: JSON.stringify({ enabled: true, backupHour: 4, frequency: 'daily' })
    });
    assert.equal(bCfg.status, 200);
    assert.equal(bCfg.data.config.backupHour, 4);

    const mStats = await reqJson('/api/media/stats');
    assert.equal(mStats.status, 200);
    assert.equal(typeof mStats.data.maxMb, 'number');

    const mClear = await reqJson('/api/media/clear-cache', {
      method: 'POST',
      body: JSON.stringify({ onlyIfExceeded: true })
    });
    assert.equal(mClear.status, 200);
    assert.equal(mClear.data.ok, true);

    const mon = await reqJson('/api/monitor');
    assert.equal(mon.status, 200);
    assert.ok(mon.data.cpu && mon.data.memory && mon.data.storage && Array.isArray(mon.data.history));

    const bots = await reqJson('/api/bots');
    assert.equal(bots.status, 200);
    assert.equal(bots.data.bots.length, 8);

    const shellRes = await reqJson('/api/bots/shell', {
      method: 'POST',
      body: JSON.stringify({ botId: 'bot-derric', command: 'node', args: ['-v'], reason: 'HTTP test' })
    });
    assert.equal(shellRes.status, 200);
    assert.equal(shellRes.data.ok, true);

    const dispRes = await reqJson('/api/bots/message', {
      method: 'POST',
      body: JSON.stringify({ targetBot: 'bot-montra', prompt: 'Inspect storage and chat metrics', useAi: false })
    });
    assert.equal(dispRes.status, 200);
    assert.equal(dispRes.data.ok, true);

    const commsRes = await reqJson('/api/bots/comms?limit=30');
    assert.equal(commsRes.status, 200);
    assert.ok(Array.isArray(commsRes.data.items) && commsRes.data.items.length >= 1);

    const graphRes = await reqJson('/api/bots/graph');
    assert.equal(graphRes.status, 200);
    assert.equal(graphRes.data.nodes.length, 8);
    assert.ok(Array.isArray(graphRes.data.links) && graphRes.data.links.length >= 8);

    const fbCfgRes = await reqJson('/api/firebase-config');
    assert.equal(fbCfgRes.status, 200);
    assert.equal(fbCfgRes.data.projectId, 'gen-lang-client-0514443416');
    assert.ok(fbCfgRes.data.appId && fbCfgRes.data.apiKey);

    const wsUnauth = await reqJson('/api/workspace/drive/files');
    assert.equal(wsUnauth.status, 401);

    const tokenStatusUnauth = await reqJson('/api/workspace/token-status');
    assert.equal(tokenStatusUnauth.status, 401);

    const d3Res = await fetch(`${base}/vendor/d3.min.js`);
    assert.equal(d3Res.status, 200);
    assert.match(await d3Res.text(), /d3/i);

    const fbFsRes = await fetch(`${base}/vendor/firebase-firestore.js`);
    assert.equal(fbFsRes.status, 200);
    const fbFsText = await fbFsRes.text();
    assert.match(fbFsText, /\/vendor\/firebase-app\.js/);
    assert.equal(fbFsText.includes('gstatic.com/firebasejs'), false);

    const badVendor = await fetch(`${base}/vendor/evil.js`);
    assert.equal(badVendor.status, 404);
  } finally {
    dashboard.stop();
    otmEngine.stop();
    systemMonitor.stop();
    botEngine.stop();
  }
});

test('OAuth token status parser classifies valid, expiring_soon, expired and Workspace service scopes', () => {
  const now = 1700000000000;
  const fullScopes = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/contacts.readonly',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/chat.spaces.readonly'
  ].join(' ');

  const valid = dashboard.parseTokenInfoResponse(true, {
    expires_in: '3540',
    scope: fullScopes,
    email: 'operator@example.com'
  }, now);
  assert.equal(valid.valid, true);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.expiresIn, 3540);
  assert.equal(valid.expiresAtMs, now + 3540 * 1000);
  assert.equal(valid.scopeCount, 6);
  assert.deepEqual(valid.services, {
    drive: true,
    gmail: true,
    contacts: true,
    calendar: true,
    tasks: true,
    chat: true
  });

  const expiring = dashboard.parseTokenInfoResponse(true, {
    expires_in: '180',
    scope: 'https://www.googleapis.com/auth/drive.readonly'
  }, now);
  assert.equal(expiring.valid, true);
  assert.equal(expiring.status, 'expiring_soon');
  assert.equal(expiring.services.drive, true);
  assert.equal(expiring.services.gmail, false);

  const expired = dashboard.parseTokenInfoResponse(false, {
    error: 'invalid_token',
    error_description: 'Invalid Value'
  }, now);
  assert.equal(expired.valid, false);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.expiresIn, 0);
  assert.equal(expired.expiresAtMs, 0);
});

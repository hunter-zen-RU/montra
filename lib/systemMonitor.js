'use strict';
/**
 * System & Bridge Resource Monitor
 * Collects live CPU, memory, disk, event-loop, and Montra data directory metrics.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const MAX_HISTORY = 40;
const MiB = 1024 * 1024;

let prevCpuTimes = null;
let prevProcCpu = process.cpuUsage();
let prevProcAt = Date.now();
let eventLoopLagMs = 0;
let lagTimer = null;
let sampleTimer = null;
const history = [];

function sampleCpuTimes() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times || {};
    idle += Number(t.idle || 0);
    total += Number(t.user || 0) + Number(t.nice || 0) + Number(t.sys || 0) + Number(t.idle || 0) + Number(t.irq || 0);
  }
  return { idle, total, count: cpus.length, model: cpus[0]?.model || 'Unknown CPU', speedMhz: cpus[0]?.speed || 0 };
}

function measureCpuUsage() {
  const now = sampleCpuTimes();
  let systemPercent = 0;
  if (prevCpuTimes) {
    const idleDelta = now.idle - prevCpuTimes.idle;
    const totalDelta = now.total - prevCpuTimes.total;
    if (totalDelta > 0) {
      systemPercent = Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
    }
  } else {
    const load1 = (os.loadavg()[0] || 0);
    systemPercent = now.count > 0 ? Math.min(100, Math.round((load1 / now.count) * 1000) / 10) : 0;
  }
  prevCpuTimes = now;

  const nowAt = Date.now();
  const procDelta = process.cpuUsage(prevProcCpu);
  const elapsedMs = Math.max(1, nowAt - prevProcAt);
  const procPercent = Math.min(100 * Math.max(1, now.count), Math.round((((procDelta.user + procDelta.system) / 1000) / elapsedMs) * 1000) / 10);
  prevProcCpu = process.cpuUsage();
  prevProcAt = nowAt;

  return {
    cores: now.count,
    model: now.model,
    speedMhz: now.speedMhz,
    systemPercent,
    processPercent: Math.round(procPercent * 10) / 10,
    loadAvg: os.loadavg().map(n => Math.round(Number(n || 0) * 100) / 100)
  };
}

function measureMemory() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const proc = process.memoryUsage();
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    totalMb: Math.round(totalBytes / MiB),
    freeMb: Math.round(freeBytes / MiB),
    usedMb: Math.round(usedBytes / MiB),
    percentUsed: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    process: {
      rssBytes: proc.rss,
      rssMb: Math.round((proc.rss / MiB) * 10) / 10,
      heapUsedBytes: proc.heapUsed,
      heapUsedMb: Math.round((proc.heapUsed / MiB) * 10) / 10,
      heapTotalBytes: proc.heapTotal,
      heapTotalMb: Math.round((proc.heapTotal / MiB) * 10) / 10,
      externalMb: Math.round(((proc.external || 0) / MiB) * 10) / 10
    }
  };
}

function dirStats(target, maxDepth = 3) {
  let bytes = 0;
  let files = 0;
  if (!fs.existsSync(target) || maxDepth < 0) return { bytes, files };
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return { bytes: stat.size, files: 1 };
    if (!stat.isDirectory()) return { bytes, files };
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) {
        const sub = dirStats(full, maxDepth - 1);
        bytes += sub.bytes;
        files += sub.files;
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return { bytes, files };
}

function measureStorage() {
  let fsInfo = null;
  try {
    if (typeof fs.statfsSync === 'function') {
      const base = fs.existsSync(DATA_DIR) ? DATA_DIR : path.join(__dirname, '..');
      const s = fs.statfsSync(base);
      const totalBytes = Number(s.blocks) * Number(s.bsize);
      const freeBytes = Number(s.bavail) * Number(s.bsize);
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      fsInfo = {
        totalBytes,
        freeBytes,
        usedBytes,
        totalGb: Math.round((totalBytes / (1024 * 1024 * 1024)) * 100) / 100,
        freeGb: Math.round((freeBytes / (1024 * 1024 * 1024)) * 100) / 100,
        percentUsed: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
      };
    }
  } catch { fsInfo = null; }

  const buckets = {
    media: dirStats(path.join(DATA_DIR, 'media')),
    backups: dirStats(path.join(DATA_DIR, 'backups')),
    files: dirStats(path.join(DATA_DIR, 'files')),
    stories: dirStats(path.join(DATA_DIR, 'stories')),
    session: dirStats(path.join(DATA_DIR, 'session'))
  };
  const dataTotal = dirStats(DATA_DIR);

  return {
    filesystem: fsInfo,
    dataDir: {
      path: DATA_DIR,
      bytes: dataTotal.bytes,
      mb: Math.round((dataTotal.bytes / MiB) * 100) / 100,
      files: dataTotal.files,
      buckets
    }
  };
}

function recordSample(snap) {
  history.push({
    ts: snap.at,
    cpuPercent: snap.cpu.systemPercent,
    ramPercent: snap.memory.percentUsed,
    heapMb: snap.memory.process.heapUsedMb,
    rssMb: snap.memory.process.rssMb,
    eventLoopLagMs: snap.runtime.eventLoopLagMs
  });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

function snapshot(extra = {}) {
  const cpu = measureCpuUsage();
  const memory = measureMemory();
  const storage = measureStorage();
  const snap = {
    at: new Date().toISOString(),
    cpu,
    memory,
    storage,
    runtime: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      nodeVersion: process.version,
      pid: process.pid,
      osUptimeSec: Math.round(os.uptime()),
      processUptimeSec: Math.round(process.uptime()),
      eventLoopLagMs
    },
    ...extra
  };
  recordSample(snap);
  return snap;
}

function getHistory() {
  return history.slice();
}

function start(intervalMs = 10000) {
  if (sampleTimer) return;
  prevCpuTimes = sampleCpuTimes();
  let expected = Date.now() + 1000;
  lagTimer = setInterval(() => {
    const now = Date.now();
    eventLoopLagMs = Math.max(0, Math.round((now - expected) * 10) / 10);
    expected = now + 1000;
  }, 1000);
  lagTimer.unref?.();

  const ms = Math.max(2000, Number(intervalMs) || 10000);
  sampleTimer = setInterval(() => {
    try { snapshot(); } catch { /* ignore */ }
  }, ms);
  sampleTimer.unref?.();
}

function stop() {
  if (lagTimer) { clearInterval(lagTimer); lagTimer = null; }
  if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
}

module.exports = {
  snapshot,
  getHistory,
  start,
  stop,
  measureCpuUsage,
  measureMemory,
  measureStorage
};

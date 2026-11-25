const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'montra-time-test-'));
process.env.MONTRA_DATA_DIR = dataDir;
delete process.env.MONTRA_TIMEZONE;
delete process.env.MONTRA_TIME_SHIFT_MINUTES;

const timeEngine = require('../lib/timeEngine');
const statusScheduler = require('../lib/statusScheduler');

function iso(epoch) {
  return new Date(epoch).toISOString();
}

test.after(() => {
  timeEngine.reset();
  delete process.env.MONTRA_TIMEZONE;
  delete process.env.MONTRA_TIME_SHIFT_MINUTES;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('wall-clock input uses the configured IANA zone', () => {
  timeEngine.setConfig({ timeZone: 'Africa/Nairobi', shiftMinutes: 0 });
  const base = Date.parse('2026-10-28T10:00:00Z'); // 13:00 in Nairobi
  assert.equal(iso(timeEngine.parseWallClock('18:30', base)), '2026-10-28T15:30:00.000Z');
  assert.equal(iso(timeEngine.parseWallClock('2026-10-28', base)), '2026-10-27T21:00:00.000Z');
  assert.equal(iso(timeEngine.parseWallClock('2026-10-28T18:30', base)), '2026-10-28T15:30:00.000Z');
  assert.equal(timeEngine.parseWallClock('quarter past six', base), null);
});

test('a wall-clock time already past rolls to tomorrow', () => {
  timeEngine.setConfig({ timeZone: 'Africa/Nairobi', shiftMinutes: 0 });
  const base = Date.parse('2026-10-28T16:00:00Z'); // 19:00 in Nairobi
  assert.equal(iso(timeEngine.parseWallClock('18:30', base)), '2026-10-29T15:30:00.000Z');
  assert.equal(iso(timeEngine.parseWallClock('18:30', base, { rollForward: false })), '2026-10-28T15:30:00.000Z');
});

test('story date folders follow the user zone, not the server zone', () => {
  timeEngine.setConfig({ timeZone: 'Africa/Nairobi', shiftMinutes: 0 });
  const lateUtc = Date.parse('2026-10-28T22:00:00Z'); // already 29 Oct in Nairobi
  assert.equal(timeEngine.dateKey(lateUtc), '2026-10-29');
  assert.equal(statusScheduler.getDateString(lateUtc), '2026-10-29');
});

test('DST transitions keep local times correct', () => {
  timeEngine.setConfig({ timeZone: 'America/New_York', shiftMinutes: 0 });
  assert.equal(iso(timeEngine.parseWallClock('2026-03-07T09:00')), '2026-03-07T14:00:00.000Z'); // EST
  assert.equal(iso(timeEngine.parseWallClock('2026-03-08T09:00')), '2026-03-08T13:00:00.000Z'); // EDT
});

test('explicit offsets stay absolute regardless of the configured zone', () => {
  timeEngine.setConfig({ timeZone: 'Asia/Tokyo', shiftMinutes: 0 });
  const stamp = '2026-10-28T09:00:00+02:00';
  assert.equal(timeEngine.parseWallClock(stamp), Date.parse(stamp));
});

test('manual shift changes wall-clock meaning, not absolute input', () => {
  timeEngine.setConfig({ timeZone: 'Africa/Nairobi', shiftMinutes: 90 });
  const base = Date.parse('2026-10-28T10:00:00Z');
  // 10:00Z is 14:30 on the corrected clock; 18:30 on that clock is 14:00Z.
  assert.equal(timeEngine.timeOfDay(base), '14:30');
  assert.equal(iso(timeEngine.parseWallClock('18:30', base)), '2026-10-28T14:00:00.000Z');
  assert.equal(timeEngine.parseWallClock('2026-10-28T09:00:00Z'), Date.parse('2026-10-28T09:00:00Z'));
});

test('configuration persists as 0600 and reset falls back to the environment', () => {
  process.env.MONTRA_TIMEZONE = 'Europe/London';
  timeEngine.reset();
  assert.equal(timeEngine.getConfig().timeZone, 'Europe/London');
  assert.equal(timeEngine.getConfig().source.timeZone, 'env');

  timeEngine.setConfig({ timeZone: 'Asia/Dubai' });
  timeEngine.setConfig({ shiftMinutes: -30 });
  const stat = fs.statSync(path.join(dataDir, 'timeConfig.json'));
  assert.equal(stat.mode & 0o777, 0o600);
  const config = timeEngine.getConfig();
  assert.equal(config.timeZone, 'Asia/Dubai');
  assert.equal(config.shiftMinutes, -30);
  assert.equal(config.source.timeZone, 'file');
  assert.equal(config.source.shiftMinutes, 'file');

  timeEngine.reset();
  const after = timeEngine.getConfig();
  assert.equal(after.timeZone, 'Europe/London');
  assert.equal(after.shiftMinutes, 0);
  delete process.env.MONTRA_TIMEZONE;
});

test('invalid zones and shifts are rejected', () => {
  timeEngine.setConfig({ timeZone: 'Africa/Nairobi', shiftMinutes: 0 });
  assert.throws(() => timeEngine.setConfig({ timeZone: 'Mars/Olympus' }));
  assert.throws(() => timeEngine.setConfig({ shiftMinutes: 'soon' }));
  assert.throws(() => timeEngine.setConfig({ shiftMinutes: 60 * 24 * 365 }));
  assert.equal(timeEngine.parseShiftMinutes('+2h'), 120);
  assert.equal(timeEngine.parseShiftMinutes('-1d'), -1440);
});

/**
 * Montra Status Post Scheduler (v1.3.0)
 * Stores scheduled WhatsApp statuses in dedicated folders: stories/{date}/
 * Each folder contains manifest JSON with when to post, caption, and optional media file.
 */
const fs = require('fs');
const path = require('path');
const syncStore = require('./syncStore');
const timeEngine = require('./timeEngine');

const DATA_DIR = process.env.MONTRA_DATA_DIR || path.join(__dirname, '..', 'data');
const STORIES_DIR = path.join(DATA_DIR, 'stories');

// Parse a schedule string (+30m, 14:30, 2026-10-26T14:30:00Z) into a real epoch.
// Wall-clock forms are interpreted in the configured user timezone (lib/timeEngine.js),
// and null is returned for input that cannot be understood so a typo never silently
// schedules the post at the wrong hour.
function parseScheduleTime(whenStr, baseDateStr = null) {
  let baseEpoch = Date.now();
  let rollForward = true;
  if (baseDateStr) {
    const asNumber = Number(baseDateStr);
    baseEpoch = Number.isFinite(asNumber) && asNumber > 0 ? asNumber : Date.parse(baseDateStr);
    if (!Number.isFinite(baseEpoch)) baseEpoch = Date.now();
    rollForward = false;
  }
  return timeEngine.parseWallClock(whenStr, baseEpoch, { rollForward });
}

function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function isStoryId(value) {
  return /^story-[A-Za-z0-9-]+$/.test(String(value || ''));
}

function writeJsonAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

class StatusScheduler {
  constructor() {
    this._timer = null;
    this._kick = null;
    this._busy = false;
    this.ensureDir(STORIES_DIR);
  }

  ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
    }
  }

  getDateString(timestamp) {
    return timeEngine.dateKey(timestamp);
  }

  /**
   * Schedule a new text or media status post.
   */
  scheduleStatus({
    when,
    caption = '',
    type = 'text',
    mediaBuffer = null,
    filename = null,
    backgroundColor = '#075e54',
    font = 1
  }) {
    const kind = ['text', 'image', 'video'].includes(type) ? type : 'text';
    const scheduledAt = parseScheduleTime(when);
    if (!scheduledAt) throw new Error('Could not understand the schedule time. Use +30m, 18:30, or a full date/time.');

    // The manifest carries a caption for text posts only; media statuses are posted as-is.
    const textCaption = kind === 'text' ? String(caption || '').trim() : '';
    if (kind === 'text' && !textCaption) throw new Error('Text statuses need a caption.');
    if (kind !== 'text' && (!mediaBuffer || !mediaBuffer.length)) throw new Error(`${kind} statuses need a media file.`);

    const dateStr = this.getDateString(scheduledAt);
    const folder = path.join(STORIES_DIR, dateStr);
    this.ensureDir(folder);

    const storyId = `story-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    let storedMediaFile = null;

    if (mediaBuffer && mediaBuffer.length && filename) {
      const rawExt = path.extname(String(filename)).toLowerCase();
      const ext = /^\.[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : (kind === 'video' ? '.mp4' : '.jpg');
      storedMediaFile = `${storyId}${ext}`;
      const mediaPath = path.join(folder, storedMediaFile);
      fs.writeFileSync(mediaPath, mediaBuffer, { mode: 0o600 });
    }

    const manifestFile = path.join(folder, `${storyId}.json`);
    const details = {
      id: storyId,
      date: dateStr,
      folder: `stories/${dateStr}`,
      whenOriginal: String(when || ''),
      scheduledAt,
      scheduledAtIso: new Date(scheduledAt).toISOString(),
      type: kind, // 'text' | 'image' | 'video'
      caption: textCaption,
      mediaFile: storedMediaFile,
      backgroundColor,
      font,
      status: 'pending', // 'pending' | 'posted' | 'failed'
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
      postedAt: null,
      error: null
    };

    writeJsonAtomic(manifestFile, details);
    return details;
  }

  /**
   * List scheduled stories across all date folders.
   */
  listScheduled(dateFilter = null) {
    this.ensureDir(STORIES_DIR);
    const result = [];
    const dates = fs.readdirSync(STORIES_DIR).filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name));

    for (const d of dates) {
      if (dateFilter && d !== dateFilter) continue;
      const folder = path.join(STORIES_DIR, d);
      try {
        const files = fs.readdirSync(folder).filter(f => f.endsWith('.json'));
        for (const f of files) {
          try {
            const content = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
            if (!content || !content.id) continue;
            result.push({ ...content, folder: `stories/${d}` });
          } catch { /* ignore malformed manifest */ }
        }
      } catch { /* ignore unreadable folder */ }
    }

    return result.sort((a, b) => Number(a.scheduledAt || 0) - Number(b.scheduledAt || 0));
  }

  /**
   * Delete a scheduled story.
   */
  deleteScheduled(dateStr, storyId) {
    if (!isDateString(dateStr) || !isStoryId(storyId)) return false;
    const folder = path.join(STORIES_DIR, dateStr);
    const jsonFile = path.join(folder, `${storyId}.json`);
    let deleted = false;

    if (fs.existsSync(jsonFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        if (manifest.mediaFile) {
          const mediaPath = path.join(folder, path.basename(manifest.mediaFile));
          if (fs.existsSync(mediaPath)) fs.unlinkSync(mediaPath);
        }
        fs.unlinkSync(jsonFile);
        deleted = true;
      } catch { /* ignore */ }
    }
    return deleted;
  }

  /**
   * Build the status audience. Without statusJidList Baileys encrypts a
   * status@broadcast message for no devices: the send succeeds but nobody sees it.
   */
  statusAudience(sock) {
    const jids = new Set();
    if (sock?.user?.id) jids.add(String(sock.user.id).split(':')[0] + '@s.whatsapp.net');
    for (const [jid, contact] of Object.entries(syncStore.getContacts() || {})) {
      if (jid.endsWith('@s.whatsapp.net') && contact) jids.add(jid);
      if (jids.size >= 1000) break;
    }
    return [...jids];
  }

  /**
   * Execute posting of a single status payload via Baileys socket.
   */
  async postStatusPayload(sock, story) {
    if (!sock) throw new Error('WhatsApp socket is not connected');

    // Anti-ban safety check
    let antiBan = null;
    try { antiBan = require('./antiBanEngine'); } catch { /* ignore */ }
    if (antiBan && typeof antiBan.checkCanSend === 'function') {
      const safety = antiBan.checkCanSend('status@broadcast', false, true);
      if (safety && safety.allowed === false) {
        throw new Error(`Anti-ban tripwire: ${safety.reason || 'status posting throttled'}`);
      }
    }

    const sendOptions = { statusJidList: this.statusAudience(sock) };
    let out = null;
    let archiveId = null;

    if (story.type === 'text') {
      if (!story.caption) throw new Error('Text status has no caption.');
      out = await sock.sendMessage('status@broadcast', {
        text: story.caption,
        backgroundColor: story.backgroundColor || '#075e54',
        font: story.font || 1
      }, sendOptions);
    } else {
      const folder = path.join(STORIES_DIR, story.date);
      const mediaPath = path.join(folder, path.basename(story.mediaFile || ''));
      if (!story.mediaFile || !fs.existsSync(mediaPath)) throw new Error(`Media file missing: ${story.mediaFile || 'unknown'}`);
      const buffer = fs.readFileSync(mediaPath);

      if (story.type === 'image') {
        out = await sock.sendMessage('status@broadcast', { image: buffer }, sendOptions);
      } else if (story.type === 'video') {
        out = await sock.sendMessage('status@broadcast', { video: buffer }, sendOptions);
      } else {
        throw new Error(`Unsupported status type: ${story.type}`);
      }

      // Keep a copy so the dashboard's Status tab can render the post it just published.
      try {
        const mediaArchive = require('./mediaArchive');
        const ext = path.extname(story.mediaFile || '').toLowerCase();
        const mime = story.type === 'video' ? 'video/mp4' : (ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg');
        const archived = mediaArchive.saveBuffer(buffer, {
          jid: 'status@broadcast',
          messageId: String(out?.key?.id || `scheduled-status:${story.id}`),
          source: 'scheduler',
          isStatus: true,
          kind: story.type,
          filename: story.mediaFile,
          mime,
          caption: ''
        });
        archiveId = archived?.id || null;
      } catch { /* the archive is best-effort; the status itself already posted */ }
    }

    // Scheduled posts went out through the raw socket, bypassing the dashboard sender.
    // Register them so /api/statuses (and "My status") updates instead of staying empty.
    try {
      const telegramEngine = require('./telegramEngine');
      telegramEngine.recordPostedStatus?.({
        message: out,
        kind: story.type,
        text: story.type === 'text' ? story.caption : '',
        archiveId,
        from: sock?.user?.id || null,
        name: sock?.user?.name || null
      });
    } catch { /* dashboard cache is best-effort */ }

    if (antiBan && typeof antiBan.recordSentMessage === 'function') {
      try { antiBan.recordSentMessage('status@broadcast', false); } catch { /* ignore */ }
    }
  }

  /**
   * Run one scheduler pass over pending posts.
   */
  async processDueStories(sock, notifyCallback = null) {
    const pending = this.listScheduled().filter(s => s.status === 'pending');
    const now = Date.now();

    for (const story of pending) {
      if (story.scheduledAt <= now) {
        const folder = path.join(STORIES_DIR, story.date);
        const manifestFile = path.join(folder, `${story.id}.json`);

        try {
          await this.postStatusPayload(sock, story);
          story.status = 'posted';
          story.postedAt = new Date().toISOString();
          story.error = null;
          story.lastError = null;
          writeJsonAtomic(manifestFile, story);
          if (notifyCallback) {
            notifyCallback({ success: true, story });
          }
        } catch (err) {
          story.attempts = Number(story.attempts || 0) + 1;
          story.lastError = err.message;
          // Rate limits and a disconnected socket are temporary: leave the post queued
          // instead of burning it as failed, and only notify on the first attempt.
          const transient = !sock || /anti-ban|rate|throttl|not connected|timeout|socket|connection/i.test(err.message || '');
          if (transient) {
            story.status = 'pending';
            writeJsonAtomic(manifestFile, story);
            if (notifyCallback && story.attempts === 1) {
              notifyCallback({ success: false, story, error: `${err.message} (will retry)`, retry: true });
            }
          } else {
            story.status = 'failed';
            story.error = err.message;
            writeJsonAtomic(manifestFile, story);
            if (notifyCallback) {
              notifyCallback({ success: false, story, error: err.message });
            }
          }
        }
      }
    }
  }

  /**
   * Start 30-second background polling timer.
   */
  start(getSocket, onResult = null) {
    this.stop();
    const run = async () => {
      // A media upload can take longer than the poll interval; without this guard the
      // next tick would read the same still-pending manifest and post it twice.
      if (this._busy) return;
      this._busy = true;
      try {
        const sock = typeof getSocket === 'function' ? getSocket() : null;
        if (sock) {
          await this.processDueStories(sock, onResult);
        }
      } catch (e) {
        console.error('[StatusScheduler] Process error:', e.message);
      } finally {
        this._busy = false;
      }
    };
    this._timer = setInterval(run, 30000);
    this._timer.unref?.();
    // A restart after a scheduled time should not wait the full 30 seconds.
    this._kick = setTimeout(run, 2000);
    this._kick.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    if (this._kick) clearTimeout(this._kick);
    this._timer = null;
    this._kick = null;
    this._busy = false;
  }
}

module.exports = Object.assign(new StatusScheduler(), { parseScheduleTime });

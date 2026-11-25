/**
 * Montra v1.0.0-montra — lightweight WhatsApp + Telegram bridge.
 *
 * Design contract (what makes this version different):
 *  - NOTHING is ever sent to WhatsApp by commands or events. No .menu, no
 *    "bot connected", no welcome/goodbye, nothing. WhatsApp is receive-only.
 *  - The single exception is the auto-reply configured from Telegram
 *    (lib/autoReplyEngine.js) — off by default, cooldown-limited, anti-ban gated.
 *  - Telegram has full control: every command lives in lib/telegramEngine.js.
 *  - All outbound WhatsApp traffic (auto-reply + every Telegram-initiated send)
 *    passes the anti-ban choke point and the humanizer typing simulation.
 *
 * Run:  node index.js   (inside the montra/ folder)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const settings = require('./settings');

const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const telegramEngine = require('./lib/telegramEngine');
const autoReplyEngine = require('./lib/autoReplyEngine');
const analyzeEngine = require('./lib/analyzeEngine');
const messageDecoder = require('./lib/messageDecoder');
const syncStore = require('./lib/syncStore');
const mediaArchive = require('./lib/mediaArchive');
const dashboard = require('./lib/dashboard');
const backupManager = require('./lib/backupManager');
const alertEngine = require('./lib/alertEngine');
const statusScheduler = require('./lib/statusScheduler');
const systemMonitor = require('./lib/systemMonitor');
const botEngine = require('./lib/botEngine');
const workspaceTokenManager = require('./lib/workspaceTokenManager');
const facebookBot = require('./lib/facebookBot');
let antiBan = null;
try { antiBan = require('./lib/antiBanEngine'); } catch { /* ignore */ }

const SESSION_DIR = path.join(__dirname, 'data', 'session');
const WA_LOGGER = pino({ level: 'silent' });

// ---------- state ----------

let sock = null;
let isStarting = false;
let pairingRequested = false;

const state = {
    status: 'disconnected', // disconnected | connecting | qr_ready | pairing | open | closed | paused
    user: null,
    paused: false,
    startedAt: null,
    lastDisconnect: null,
    qr: null,
    qrUpdatedAt: null,
    pairingCode: null,
    pairingPhone: null
};

function log(...args) {
    console.log(`[Montra ${settings.version}]`, ...args);
}

// ---------- contacts cache (for pretty names in Telegram) ----------

const contacts = {}; // jid -> { name }

function rememberContact(jid, name) {
    if (!jid || !name) return;
    const j = String(jid);
    if (j.endsWith('@broadcast') || j.endsWith('@newsletter')) return;
    contacts[j] = { ...(contacts[j] || {}), name: String(name).slice(0, 80) };
}

// ---------- session helpers ----------

function resetSessionFolder() {
    try {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        log('Session folder cleared — next start will ask for a fresh link.');
    } catch (e) {
        log('Failed to clear session folder:', e.message);
    }
}

function restartServer() {
    log('Restarting process…');
    analyzeEngine.flush();
    setTimeout(() => {
        try {
            const { spawn } = require('child_process');
            const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
                detached: true,
                stdio: 'inherit',
                cwd: __dirname,
                env: process.env
            });
            child.unref();
        } catch (e) {
            log('Self-spawn failed, exiting anyway:', e.message);
        }
        process.exit(0);
    }, 400);
}

// ---------- WhatsApp connection ----------

async function startWhatsApp() {
    if (isStarting) return;
    if (state.paused) { state.status = 'paused'; return; }
    isStarting = true;
    state.status = 'connecting';
    pairingRequested = false;

    try {
        const { state: authState, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

        sock = makeWASocket({
            version,
            auth: {
                creds: authState.creds,
                keys: makeCacheableSignalKeyStore(authState.keys, WA_LOGGER)
            },
            logger: WA_LOGGER,
            browser: Browsers.macOS('Chrome'),
            markOnlineOnConnect: false,
            syncFullHistory: true,
            generateHighQualityLinkPreview: false
        });
        sock.ev.process(async (events) => {
            try {
                if (events['connection.update']) await onConnectionUpdate(events['connection.update'], saveCreds);
                if (events['creds.update']) await saveCreds();
                if (events['messages.upsert']) await onMessages(events['messages.upsert']);
                if (events['messages.update']) {
                    for (const row of events['messages.update']) {
                        const jid = row?.key?.remoteJid;
                        const id = row?.key?.id;
                        if (jid && id) syncStore.updateMessage(jid, id, row.update || {});
                    }
                }
                // Baileys emits these events during initial sync and as the phone changes.
                if (events['messages.set']) {
                    const historical = events['messages.set'].messages || [];
                    syncStore.recordMessages(historical);
                    for (const m of historical) void mediaArchive.archiveMessage(sock, m, { isStatus: m.key?.remoteJid === 'status@broadcast' }).catch(e => log('History media archive error:', e.message));
                }
                if (events['messaging-history.set']) {
                    const h = events['messaging-history.set'];
                    syncStore.upsertContacts(h.contacts || []);
                    syncStore.upsertChats(h.chats || []);
                    syncStore.recordMessages(h.messages || []);
                    for (const m of (h.messages || [])) void mediaArchive.archiveMessage(sock, m, { isStatus: m.key?.remoteJid === 'status@broadcast' }).catch(e => log('History media archive error:', e.message));
                }
                if (events['chats.set']) syncStore.upsertChats(events['chats.set'].chats || []);
                if (events['chats.upsert']) syncStore.upsertChats(events['chats.upsert']);
                if (events['chats.update']) syncStore.upsertChats(events['chats.update']);
                if (events['presence.update']) onPresence(events['presence.update']);
                if (events['contacts.set']) syncStore.upsertContacts(events['contacts.set'].contacts || []);
                if (events['contacts.upsert']) {
                    for (const c of events['contacts.upsert']) { rememberContact(c.id, c.name || c.notify || c.verifiedName); syncStore.upsertContacts([c]); }
                }
                if (events['contacts.update']) {
                    for (const c of events['contacts.update']) if (c.id) { rememberContact(c.id, c.name || c.notify || c.verifiedName); syncStore.upsertContacts([c]); }
                }
                if (events['groups.upsert']) {
                    for (const g of events['groups.upsert']) { rememberContact(g.id, g.subject); syncStore.upsertContacts([{ id: g.id, name: g.subject, isGroup: true }]); syncStore.upsertChats([{ id: g.id, subject: g.subject }]); }
                }
                if (events['groups.update']) {
                    for (const g of events['groups.update']) if (g.id) { rememberContact(g.id, g.subject); syncStore.upsertContacts([{ id: g.id, name: g.subject, isGroup: true }]); syncStore.upsertChats([{ id: g.id, subject: g.subject }]); }
                }
                if (events['call']) {
                    for (const call of events['call']) {
                        const callerName = contacts[call.from]?.name || String(call.from || '').split('@')[0];
                        alertEngine.recordCall(call);
                        const alerts = alertEngine.evaluate({
                            type: 'call',
                            name: callerName,
                            phone: String(call.from || '').split('@')[0],
                            action: call.isVideo ? 'tried to video call you on WhatsApp' : 'tried to call you on WhatsApp',
                            jid: call.from,
                            text: `Call status: ${call.status || 'offer'}`
                        });
                        for (const a of alerts) {
                            telegramEngine.broadcastAlert(a.message);
                        }
                    }
                }
            } catch (e) {
                log('Event processing error:', e.message);
            }
        });
    } catch (e) {
        log('Failed to start WhatsApp socket:', e.message);
        state.status = 'closed';
        isStarting = false;
        scheduleReconnect(10000);
    }
}

let reconnectTimer = null;
function scheduleReconnect(ms) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!state.paused) startWhatsApp();
    }, ms);
}

async function onConnectionUpdate(update, saveCreds) {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !state.paused) {
        state.status = 'qr_ready';
        state.qr = qr;
        state.qrUpdatedAt = Date.now();
        log('Scan this QR in WhatsApp → Linked devices → Link a device:');
        qrcode.generate(qr, { small: true });
        const phone = process.env.PHONE_NUMBER || settings.ownerNumber;
        if (phone && !pairingRequested) {
            pairingRequested = true;
            try {
                const digits = phone.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(digits);
                const formatted = String(code).match(/.{1,4}/g)?.join('-') || String(code);
                state.pairingCode = formatted;
                state.pairingPhone = digits;
                log(`Or pair with code: ${formatted}`);
            } catch (e) {
                log('Pairing code request failed (QR still available):', e.message);
            }
        }
        return;
    }

    if (connection === 'connecting') {
        state.status = 'connecting';
        return;
    }

    if (connection === 'open') {
        isStarting = false;
        state.status = 'open';
        state.user = sock?.user ? jidNormalizedUser(sock.user.id) : null;
        state.startedAt = Date.now();
        state.qr = null;
        state.qrUpdatedAt = null;
        state.pairingCode = null;
        state.pairingPhone = null;
        // Silence by design: no greeting, no announcement — WhatsApp hears nothing.
        log(`WhatsApp linked${sock?.user ? ` as ${String(sock.user.id).split(':')[0]}` : ''}. Staying quiet on WhatsApp as designed.`);
        return;
    }

    if (connection === 'close') {
        isStarting = false;
        state.user = null;
        state.qr = null;
        state.qrUpdatedAt = null;
        const code = lastDisconnect?.error?.output?.statusCode
            ?? lastDisconnect?.error?.output?.payload?.statusCode ?? -1;
        state.lastDisconnect = { code, at: Date.now() };

        if (code === DisconnectReason.loggedOut) {
            state.status = 'closed';
            state.pairingCode = null;
            state.pairingPhone = null;
            log('Logged out of WhatsApp. Clearing session and relinking with a fresh QR…');
            resetSessionFolder();
            scheduleReconnect(2000);
            return;
        }
        if (code === DisconnectReason.pairing) {
            state.status = 'pairing';
            log('Waiting for pairing confirmation…');
            return;
        }

        // Rate limiting / connection resets: arm the anti-ban tripwire so any
        // queued sends stand down while WhatsApp is unhappy with us.
        if (code === 429 || code === 440 || code === DisconnectReason.timedOut || code === DisconnectReason.connectionClosed) {
            try { antiBan?.triggerTripwire?.(`connection event ${code}`); } catch { /* ignore */ }
        }

        state.status = 'closed';
        const wait = code === DisconnectReason.restartRequired ? 3000 : 8000;
        log(`Connection closed (code ${code}) — reconnecting in ${wait / 1000}s…`);
        scheduleReconnect(wait);
    }
}

// ---------- message pipeline (receive-only) ----------

async function onMessages(upsert) {
    if (!sock || state.paused) return;
    // 'append' = history sync — never reply or forward history, only record quietly.
    const live = upsert.type === 'notify' || upsert.type === 'unread';

    for (const mek of upsert.messages || []) {
        try {
            const jid = mek.key?.remoteJid;
            if (!jid) continue;
            const decoded = messageDecoder.decode(mek.message);
            if (!decoded) continue;

            // Persist media to the bounded local archive before forwarding or other actions.
            // History sync and live updates share the same deduplicating archive index.
            if (['image', 'video', 'voice', 'sticker', 'document'].includes(decoded.kind)) {
                const archived = await mediaArchive.archiveMessage(sock, mek, { isStatus: jid === 'status@broadcast', attemptWithoutKey: live && jid === 'status@broadcast' });
                if (archived?.skipped && archived.reason === 'file_limit') log(`Media not archived: ${mek.key?.id || 'unknown'} exceeds per-file archive limit.`);
            }

            if (jid === 'status@broadcast') {
                if (live) await telegramEngine.handleStatusMessage(sock, mek);
                continue;
            }

            analyzeEngine.record(mek, decoded);
            syncStore.recordMessage(mek);
            if (!live) continue;

            // 1. mirror to Telegram (forwarding config decides what is shown)
            await telegramEngine.handleWhatsAppMessage(sock, mek);

            // 2. the ONLY automated WhatsApp outbound in Montra. Channels are
            // broadcast-only, so an auto-reply there could never be delivered.
            if (jid.endsWith('@newsletter')) continue;
            const botJid = sock.user ? jidNormalizedUser(sock.user.id) : null;
            await autoReplyEngine.maybeReply(sock, mek, decoded, botJid);
        } catch (e) {
            log('Message pipeline error:', e.message);
        }
    }
}

function onPresence(update) {
    try {
        const jid = update?.id || update?.jid;
        if (!jid) return;
        const p = Array.isArray(update.presences)
            ? update.presences.find(x => x?.lastKnownPresence)
            : Object.values(update.presences || {}).find(x => x?.lastKnownPresence);
        if (!p) return;
        dashboard.recordPresence(jidNormalizedUser(jid), p.lastKnownPresence, p.lastSeen);
        telegramEngine.recordPresence(jidNormalizedUser(jid), p.lastKnownPresence, p.lastSeen);
    } catch { /* ignore */ }
}

// ---------- dependency wiring for the Telegram engine ----------

async function requestWhatsAppPairingCode(num) {
    const digits = String(num || '').replace(/[^0-9]/g, '');
    if (digits.length < 7 || digits.length > 15) {
        throw new Error('Enter a phone number with country code (7–15 digits).');
    }
    if (state.status === 'open') {
        throw new Error('WhatsApp is already linked.');
    }
    if (!sock) {
        state.paused = false;
        await startWhatsApp();
        for (let i = 0; i < 20 && !sock; i++) await new Promise(r => setTimeout(r, 500));
        if (!sock) throw new Error('WhatsApp socket could not start.');
    }
    state.paused = false;
    const code = await sock.requestPairingCode(digits);
    const formatted = String(code).match(/.{1,4}/g)?.join('-') || String(code);
    state.pairingCode = formatted;
    state.pairingPhone = digits;
    return code;
}

dashboard.start({
    sendMessage: (jid, text, quoted) => telegramEngine.sendDashboardText(jid, text, quoted),
    sendOtm: (jid, text) => telegramEngine.sendOtmText(jid, text),
    sendMedia: (jid, mediaId, caption) => telegramEngine.sendDashboardMedia(jid, mediaId, caption),
    reactToMessage: (jid, key, emoji) => telegramEngine.sendDashboardReaction(jid, key, emoji),
    deleteMessage: (jid, key) => telegramEngine.sendDashboardDelete(jid, key),
    markRead: async keys => { if (state.status !== 'open' || !sock) throw new Error('WhatsApp is not connected.'); await sock.readMessages(keys); },
    getConnection: () => ({
        status: state.status,
        connected: state.status === 'open',
        user: state.user,
        qr: state.status === 'open' ? null : state.qr,
        qrUpdatedAt: state.status === 'open' ? null : state.qrUpdatedAt,
        pairingCode: state.status === 'open' ? null : state.pairingCode,
        pairingPhone: state.status === 'open' ? null : state.pairingPhone
    }),
    requestPairingCode: requestWhatsAppPairingCode,
    refreshQr: async () => {
        if (state.status === 'open') return { alreadyLinked: true };
        state.paused = false;
        state.qr = null;
        state.qrUpdatedAt = null;
        if (!sock || state.status === 'closed' || state.status === 'disconnected') {
            await startWhatsApp();
        }
        return { ok: true };
    },
    subscribePresence: async jid => { if (state.status !== 'open' || !sock) throw new Error('WhatsApp is not connected.'); await sock.presenceSubscribe(jid); },
    setTyping: async (jid, typing) => { if (state.status !== 'open' || !sock) throw new Error('WhatsApp is not connected.'); await sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid); },
    getAvatarUrl: async jid => {
        if (state.status !== 'open' || !sock) throw new Error('WhatsApp is not connected.');
        try { return await sock.profilePictureUrl(jid, 'image') || ''; } catch { return ''; }
    },
    getChatInfo: async jid => {
        if (state.status !== 'open' || !sock) throw new Error('WhatsApp is not connected.');
        const contacts = syncStore.getContacts();
        const info = {
            jid: String(jid), isGroup: String(jid).endsWith('@g.us'),
            isChannel: String(jid).endsWith('@newsletter'), picture: ''
        };
        try { info.picture = await sock.profilePictureUrl(jid, 'image') || ''; } catch { /* ignore */ }
        if (info.isChannel) {
            const meta = await sock.newsletterMetadata('jid', String(jid)).catch(() => null);
            const name = meta?.name?.text || meta?.name || '';
            info.name = String(name || contacts[String(jid)]?.name || '');
            info.description = String(meta?.description?.text || meta?.description || '');
            info.created = Number(meta?.creation_time || 0);
            info.owner = meta?.owner ? jidNormalizedUser(meta.owner) : '';
            info.subscribers = Number(meta?.subscribers || 0);
            info.verified = meta?.verification === 'VERIFIED';
            if (!info.picture && meta?.picture?.directPath) info.hasPicture = true;
        } else if (info.isGroup) {
            const meta = await sock.groupMetadata(jid).catch(() => null);
            info.name = String(meta?.subject || '');
            info.description = String(meta?.desc || '');
            info.created = Number(meta?.creation || 0);
            info.owner = meta?.owner ? jidNormalizedUser(meta.owner) : '';
            info.participants = (meta?.participants || []).slice(0, 512).map(p => {
                const participantJid = jidNormalizedUser(p.id);
                return { jid: participantJid, name: contacts[participantJid]?.name || contacts[participantJid]?.notify || '', admin: p.admin || null };
            });
        } else {
            const contact = contacts[String(jid)] || {};
            info.name = String(contact.name || contact.notify || contact.verifiedName || '');
            try {
                const row = (await sock.fetchStatus(jid))?.[0];
                const value = row?.status?.status || row?.status?.text || row?.status;
                if (typeof value === 'string') info.about = value;
            } catch { /* ignore */ }
        }
        return info;
    },
    // Display name + picture for one chat, asked a few at a time by the dashboard.
    resolveChatMetaProvider: async jid => {
        if (state.status !== 'open' || !sock) throw new Error('WhatsApp is not connected.');
        const j = String(jid);
        let name = '';
        if (j.endsWith('@g.us')) name = String((await sock.groupMetadata(j).catch(() => null))?.subject || '');
        else if (j.endsWith('@newsletter')) {
            const meta = await sock.newsletterMetadata('jid', j).catch(() => null);
            name = String(meta?.name?.text || meta?.name || '');
        } else {
            const contact = syncStore.getContacts()[j] || {};
            name = String(contact.name || contact.notify || contact.verifiedName || '');
        }
        let picture = false;
        try { picture = Boolean(await sock.profilePictureUrl(j, 'image')); } catch { /* ignore */ }
        return { name: name.slice(0, 120), picture };
    },
    getProfile: async () => {
        if (state.status !== 'open' || !sock?.user) throw new Error('WhatsApp is not connected.');
        const jid = jidNormalizedUser(sock.user.id);
        let picture = '';
        try { picture = await sock.profilePictureUrl(jid, 'image') || ''; } catch { /* ignore */ }
        let about = '';
        try {
            const row = (await sock.fetchStatus(jid))?.[0];
            const value = row?.status?.status || row?.status?.text || row?.status;
            if (typeof value === 'string') about = value;
        } catch { /* ignore */ }
        about = about || String(state.profileAbout || '');
        return { jid, name: String(state.profileName || sock.user.name || ''), about, picture };
    },
    updateProfile: async ({ name, about }) => {
        if (state.status !== 'open' || !sock?.user) throw new Error('WhatsApp is not connected.');
        if (name !== undefined) await sock.updateProfileName(name);
        if (about !== undefined) await sock.updateProfileStatus(about);
        if (name !== undefined) state.profileName = name;
        if (about !== undefined) state.profileAbout = about;
        return { name: String(sock.user.name || name || ''), about: state.profileAbout || '' };
    },
    updateProfilePicture: async (buffer) => {
        if (state.status !== 'open' || !sock?.user) throw new Error('WhatsApp is not connected.');
        await sock.updateProfilePicture(sock.user.id, buffer);
    },
    removeProfilePicture: async () => {
        if (state.status !== 'open' || !sock?.user) throw new Error('WhatsApp is not connected.');
        await sock.removeProfilePicture(sock.user.id);
    },
    getStatuses: () => telegramEngine.getDashboardStatuses(),
    postStatus: async payload => {
        const result = await telegramEngine.sendDashboardStatus(payload);
        if (!result?.ok) throw new Error(result?.error || 'Status could not be posted.');
    },
    viewStatus: async (id, participant) => {
        if (state.status !== 'open' || !sock) throw new Error('WhatsApp is not connected.');
        const entry = telegramEngine.getDashboardStatuses().find(status => status.id === id && status.participant === participant);
        if (!entry) throw new Error('Status is no longer available.');
        await sock.readMessages([{ remoteJid: 'status@broadcast', id: entry.id, participant: entry.participant }]);
    },
    resolveStatusMedia: query => telegramEngine.resolveStatusMedia(query)
});
backupManager.scheduleDaily();
setInterval(() => { try { syncStore.pruneExpired(); mediaArchive.prune(); } catch { /* ignore */ } }, 60 * 60 * 1000).unref?.();

telegramEngine.init({
    getSocket: () => (state.paused ? null : sock),
    getContacts: () => Object.assign({}, syncStore.getContacts(), contacts),
    getSyncStore: () => syncStore,
    getBotState: () => ({
        status: state.status,
        user: state.user,
        paused: state.paused,
        startedAt: state.startedAt
    }),
    pauseBot: async () => {
        state.paused = true;
        state.status = 'paused';
        try { sock?.ev.removeAllListeners('connection.update'); } catch { /* ignore */ }
        try { await sock?.end(undefined); } catch { /* ignore */ }
        sock = null;
        log('WhatsApp paused from Telegram.');
    },
    resumeBot: async () => {
        state.paused = false;
        log('WhatsApp resumed from Telegram.');
        await startWhatsApp();
    },
    restartServer,
    requestPairingCode: requestWhatsAppPairingCode,
    resetSessionFolder
});

systemMonitor.start();
botEngine.init({
    getConnection: () => ({
        status: state.status,
        connected: state.status === 'open',
        user: state.user
    }),
    refreshQr: async () => {
        if (state.status === 'open') return { alreadyLinked: true };
        state.paused = false;
        state.qr = null;
        state.qrUpdatedAt = null;
        if (!sock || state.status === 'closed' || state.status === 'disconnected') {
            await startWhatsApp();
        }
        return { ok: true };
    },
    requestPairingCode: requestWhatsAppPairingCode,
    sendMessage: (jid, text, quoted) => telegramEngine.sendDashboardText(jid, text, quoted),
    getTelegramStatus: () => telegramEngine.getStatus(),
    sendTelegramAlert: (html) => telegramEngine.broadcastAlert(html)
});
botEngine.start();

workspaceTokenManager.start({
    onRefreshNeeded: (trigger) => {
        try {
            botEngine.sendBusMessage({
                from: 'bot-ruri',
                to: 'bot-montra',
                topic: 'oauth_refresh_due',
                priority: 'high',
                content: `Google Workspace OAuth countdown reached ${trigger.remainingSec}s (<= ${trigger.thresholdSec}s). Refresh triggered (${trigger.mode}).`
            });
        } catch { /* ignore */ }
    }
});

facebookBot.init({
    sendTelegramAlert: (html) => telegramEngine.broadcastAlert(html),
    onBotModeration: ({ botId, action, content }) => {
        try {
            const mod = botEngine.selinahModerate('facebook_post', {
                botId: botId || 'facebook-bot',
                text: content || '',
                reason: `Facebook ${action || 'post'}`
            });
            return { allowed: mod.decision !== 'deny', reason: mod.reason };
        } catch {
            return { allowed: true };
        }
    }
});
facebookBot.start();

// ---------- lifecycle ----------

process.on('SIGINT', () => {
    analyzeEngine.flush();
    process.exit(0);
});
process.on('SIGTERM', () => {
    analyzeEngine.flush();
    process.exit(0);
});
process.on('unhandledRejection', (reason) => {
    log('Unhandled rejection:', reason?.message || reason);
});

(async () => {
    log('Starting — WhatsApp silent mode, Telegram control room.');
    telegramEngine.init(); // deps already wired above; init is idempotent
    if (!telegramEngine.getStatus().configured) {
        log('Telegram disabled — add TELEGRAM_BOT_TOKEN to montra/.env and restart.');
    }
    // Start background status post scheduler (checks stories/{date} every 30s)
    statusScheduler.start(
        () => sock,
        ({ success, story, error, retry }) => {
            if (success) {
                const captionLine = story.type === 'text' ? `\nCaption: <i>${story.caption || 'No caption'}</i>` : '';
                telegramEngine.broadcastAlert(`📢 <b>Scheduled Status Published!</b>\nType: <b>${story.type}</b>${captionLine}`);
            } else if (retry) {
                telegramEngine.broadcastAlert(`⏳ <b>Scheduled Status Delayed:</b> ${error || 'temporary failure'}\nWill retry automatically (attempt ${story.attempts || 1}).`);
            } else {
                telegramEngine.broadcastAlert(`⚠️ <b>Scheduled Status Failed:</b> ${error || 'Unknown error'}`);
            }
        }
    );
    await startWhatsApp();
})();

/**
 * Montra message decoder — "proper message decryption" for inbound WhatsApp.
 * Baileys wraps the real payload in layers (ephemeral / view-once / edited /
 * document-with-caption). This unwraps every layer and produces one flat,
 * typed description used for Telegram forwarding, auto-reply and analysis.
 */

const UNWRAP_KEYS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage'
];

function unwrapLayers(msg) {
    let inner = msg;
    const layers = [];
    let guard = 0;
    while (inner && typeof inner === 'object' && guard++ < 6) {
        const wrapper = UNWRAP_KEYS.find(k => inner[k] && typeof inner[k] === 'object');
        if (!wrapper) break;
        layers.push(wrapper.replace('Message', ''));
        inner = inner[wrapper].message || inner[wrapper];
    }
    return { inner, layers };
}

function firstText(inner) {
    return String(
        inner?.conversation
        || inner?.extendedTextMessage?.text
        || inner?.imageMessage?.caption
        || inner?.videoMessage?.caption
        || inner?.documentMessage?.caption
        || ''
    ).trim();
}

// Returns null for protocol noise that carries nothing user-visible.
function decode(message) {
    if (!message || typeof message !== 'object') return null;
    const { inner, layers } = unwrapLayers(message);

    if (inner?.reactionMessage) {
        return { kind: 'reaction', text: String(inner.reactionMessage.text || '👍'), layers };
    }
    if (inner?.protocolMessage) {
        const t = inner.protocolMessage.type;
        if (t === 0 || t === 8) return { kind: 'revoke', text: 'message deleted', layers };
        if (t === 14) return { kind: 'edit', text: 'message edited', layers };
        return null; // history sync, app state etc.
    }
    if (inner?.senderKeyDistributionMessage) return null;
    if (inner?.pollCreationMessage) {
        return { kind: 'poll', text: String(inner.pollCreationMessage.name || 'poll'), layers };
    }
    if (inner?.pollUpdateMessage) return null;
    if (inner?.contactMessage) {
        const vc = String(inner.contactMessage.vcard || '');
        const num = (vc.match(/waid=(\d+)/) || [])[1] || '';
        return { kind: 'contact', text: `${inner.contactMessage.displayName || 'contact'}${num ? ` (${num})` : ''}`, layers };
    }
    if (inner?.locationMessage) {
        const { latitude, longitude } = inner.locationMessage;
        // Baileys can deliver a location payload without coordinates; never print "NaN".
        const coord = value => Number.isFinite(Number(value)) ? Number(value).toFixed(5) : '';
        const text = [coord(latitude), coord(longitude)].filter(Boolean).join(', ');
        return { kind: 'location', text: text || 'shared a location', layers };
    }
    if (inner?.liveLocationMessage) {
        return { kind: 'location', text: 'live location', layers };
    }
    if (inner?.imageMessage) {
        return { kind: 'image', text: firstText(inner), mime: inner.imageMessage.mimetype || 'image/jpeg', fileLength: Number(inner.imageMessage.fileLength || 0), layers };
    }
    if (inner?.videoMessage) {
        return { kind: 'video', text: firstText(inner), mime: inner.videoMessage.mimetype || 'video/mp4',
            seconds: Math.round(inner.videoMessage.seconds || 0), fileLength: Number(inner.videoMessage.fileLength || 0), layers };
    }
    if (inner?.audioMessage) {
        return { kind: 'voice', text: '', mime: inner.audioMessage.mimetype || 'audio/ogg',
            seconds: Math.round(inner.audioMessage.seconds || 0), fileLength: Number(inner.audioMessage.fileLength || 0), layers };
    }
    if (inner?.stickerMessage) {
        return { kind: 'sticker', text: '', mime: inner.stickerMessage.mimetype || 'image/webp', fileLength: Number(inner.stickerMessage.fileLength || 0), layers };
    }
    if (inner?.documentMessage) {
        const d = inner.documentMessage;
        return { kind: 'document', text: String(d.caption || ''), fileName: d.fileName || 'file',
            mime: d.mimetype || 'application/octet-stream', fileLength: Number(d.fileLength || 0), layers };
    }
    const text = firstText(inner);
    if (text) {
        const quoted = inner?.extendedTextMessage?.contextInfo?.quotedMessage;
        const mentioned = (inner?.extendedTextMessage?.contextInfo?.mentionedJid
            || inner?.imageMessage?.contextInfo?.mentionedJid
            || inner?.videoMessage?.contextInfo?.mentionedJid
            || []).map(String);
        return { kind: 'text', text, quoted: Boolean(quoted), mentionedJids: mentioned, layers };
    }
    return null;
}

const KIND_ICON = {
    text: '💬', image: '🖼', video: '🎬', voice: '🎙', sticker: '✨',
    document: '📄', reaction: '⚡', revoke: '🗑', edit: '✏️',
    poll: '📊', contact: '👤', location: '📍'
};

// One-line description, e.g. "🖼 photo", "🎙 voice (12s)", "✨ [view-once] sticker"
function describe(decoded) {
    if (!decoded) return 'message';
    let s = `${KIND_ICON[decoded.kind] || '💬'} `;
    switch (decoded.kind) {
        case 'voice': s += `voice (${decoded.seconds || 0}s)`; break;
        case 'video': s += `video${decoded.seconds ? ` (${decoded.seconds}s)` : ''}`; break;
        case 'document': s += decoded.fileName || 'file'; break;
        case 'image': s += 'photo'; break;
        default: s += decoded.kind;
    }
    if (decoded.layers?.length) s += ` [${decoded.layers.join(' + ')}]`;
    return s;
}

// Text-safe body used by auto-reply triggering (reactions/revokes never trigger)
function bodyText(decoded) {
    if (!decoded) return '';
    if (['text', 'image', 'video', 'document'].includes(decoded.kind)) return decoded.text || '';
    return '';
}

module.exports = { decode, describe, bodyText, unwrapLayers };

# Montra — WhatsApp + Telegram automation bridge

Montra links an authorized WhatsApp Web session to a Telegram control bot. It supports local chat/contact/message caching, trigger-based auto-replies, scheduled jobs, story tools, optional AI helpers and an optional authenticated local dashboard.

> **Important:** Baileys uses the WhatsApp Web protocol, which can change and may not expose all phone history, contacts, expired statuses or media. The application can only cache information that WhatsApp delivers to the linked session. Test all live WhatsApp features on an account you control. Use automation respectfully, obey WhatsApp terms, and repost only content you own or have permission to share.


> **about:** This is a very lightwheight version of zero bot with version v1.0.0 (the most lightwheight version)
## Requirements

- Node.js 18 or newer (Node 20+ recommended for built-in `fetch`, `FormData` and `Blob` support).
- A WhatsApp account you are authorized to link.
- A Telegram bot token from BotFather.
- Optional AI provider API key for AI functions.

## Install

```bash
npm install
cp .env.example .env
# edit .env, then:
npm test
npm start
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

Set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and preferably `TELEGRAM_START_PIN`. `BOT_OWNER_NUMBER` / `PHONE_NUMBER` may be used by the existing pairing flow. Never share `.env`, `data/session`, or the sync cache. If credentials leak, revoke the linked device and rotate tokens.

## Core commands

### Chat, history and sync

- `/status` — connection status.
- `/chats` — cached chats.
- `/open <jid|phone|name>` and `/close` — select a chat.
- `/history [target] [count]` — show cached messages.
- `/historymedia <n>` — attempt to retrieve media from the selected history result when the original message still contains downloadable media.
- `/search <text> [--from sender] [--after YYYY-MM-DD] [--before YYYY-MM-DD]` — search cached messages.
- `/contacts`, `/chatinfo <target>`, `/groups` — contact/chat/group information.
- `/syncstatus` — cached chat/contact/message counts and cache limits.
- `/backup` — create a private snapshot of configuration, sync cache, scheduled jobs and audit log (session credentials excluded).

History commands search local data; they cannot force WhatsApp to provide arbitrary missing or expired history. Message content is stored in `data/syncStore.json` and may contain private information.

### Trigger-based auto-replies

Replies are disabled by default. Manage rules using `/autoreply`; supported rule fields include:

- `trigger`, `usage` (`dms` or `groups-mentioned`), `message`
- `match`: `contains`, `exact`, `startsWith`, or `regex`
- `priority` (higher runs first), `cooldownMin`
- optional `contacts` allow-list (JIDs or names)
- optional `schedule: { "start": "09:00", "end": "17:00" }` in server local time. Telegram rule syntax can pass priority, a comma-separated contact allow-list, and `HH:MM-HH:MM` as fields 5–7

Placeholders include `{name}` and `{trigger}`. Invalid regular expressions are rejected. Group rules require a bot mention. Cooldowns and anti-ban send guards are applied. Rule hit counts are persisted as analytics.

### Jobs, reminders and AI cron

- `/remind +30m call John` — one-time Telegram reminder.
- `/remind 09:00 daily standup` — daily Telegram reminder.
- `/notify +2h check deployment` — one-time Telegram notification.
- `/cron` — list scheduled jobs.
- `/cron add <when> <target|me> <message>` — schedule a message.
- `/cron del <n>`, `/cron pause <n>`, `/cron resume <n>` — manage jobs.
- `/ai cron 18:00 Summarize today's priorities` — AI-generated scheduled Telegram update.
- `/ai story 09:00 <image prompt>` — generate and post an AI image as WhatsApp status daily (requires image API access and a connected WhatsApp session).

`<when>` accepts `HH:MM` (daily), `+30m`, `+2h`, `+1d` (one-time), or an ISO date/time such as `2026-12-31T15:00`. The scheduler checks every 30 seconds. Failed jobs retry with bounded delays and stop after three attempts. Keep the process running for scheduled jobs to fire.

### AI tools (optional)

Set `MONTRA_AI_API_KEY` to enable:

- `/ai summarize [chat|all]` — summarize available cached messages.
- `/ai reply <message context>` — draft a reply; it is not sent automatically.
- `/ai cron <when> <prompt>` — scheduled AI-generated update.
- `/ai transcribe` while replying to a Telegram voice/audio attachment — transcribe that audio.
- `/ai story <HH:MM> <prompt>` — scheduled AI image story.

AI requests can transmit the supplied message text/audio to the configured provider. Configure this only if that data sharing is acceptable. AI-generated text and images can be wrong; review content before using it. AI image generation requires a provider endpoint and account with image-generation access. Transcription requires audio transcription access.

### Stories

- `/stories` — list status updates observed by the running session.
- `/downloadstatus <n>` — attempt to retrieve cached status media.
- `/repoststatus <n>` — repost a status when media is still available and you have permission.
- `/poststatus <text>` or reply to an image/video with `/poststatus` — publish your own status.

WhatsApp does not guarantee that every contact's story or expired story media is available to the linked session. Scheduled AI stories post generated media to the account's status audience; verify the audience and privacy settings on the linked account first.

### Optional dashboard

The dashboard is disabled unless `DASHBOARD_TOKEN` is set. Configure:

```dotenv
DASHBOARD_TOKEN=use-a-long-random-secret
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8787
```

Then restart Montra and open `http://127.0.0.1:8787/?token=YOUR_TOKEN`. API endpoints `/api/stats` and `/api/chats` accept the same token as a query parameter or `Authorization: Bearer ...` header. Avoid exposing the dashboard directly to the internet; use localhost or a properly secured reverse proxy. The dashboard currently provides a read-only overview, stats and chat metadata—not full configuration editing.

### Cache retention and backups

- `SYNC_MAX_MESSAGES_PER_CHAT=500` controls messages retained per chat (minimum 50).
- `SYNC_RETENTION_DAYS=0` disables time-based pruning. Set a positive value to delete older cached messages; pruning runs hourly.
- `/backup` creates local snapshots in `data/backups/`; daily snapshots run at `BACKUP_HOUR` (default 03:00 server local time) and only the newest `BACKUP_KEEP_COUNT` (default 7) are retained. Snapshots include sync cache/config/audit files but exclude `data/session/`. Backups still contain private chat content: restrict filesystem access and encrypt off-device copies.
- Audit events are written to `data/tgAudit.jsonl`.

## Security

- Only allow trusted Telegram control chat IDs; configure `TELEGRAM_START_PIN` before allowing new chats to register.
- Keep `DASHBOARD_TOKEN` strong and private.
- Never publish tokens, auth sessions, personal chat exports or sync cache files.
- Bulk sending and unsolicited messaging are intentionally not encouraged. Existing anti-ban/rate controls can block sends.
- Ensure group moderation and auto-replies comply with participant expectations and applicable law.

## Testing and verification

```bash
npm test
node --check index.js
node --check lib/telegramEngine.js
node --check lib/syncStore.js
node --check lib/autoReplyEngine.js
node --check lib/aiAssistant.js
node --check lib/dashboard.js
```

Unit tests cover auto-reply matching and priority, invalid regex rejection, sync upserts/deduplication, cached search and sync statistics. They do not log in to WhatsApp or Telegram and do not make external AI API calls.

## Known limitations / live verification required

1. WhatsApp full-history sync is controlled by WhatsApp/Baileys and may be partial.
2. Contact names and chat metadata update only when sync events are delivered.
3. Media retrieval depends on original message keys and media still being accessible; expired status media may be unavailable.
4. AI provider key, model access, image generation, and audio transcription must be verified with your provider.
5. Dashboard is a minimal read-only starter, not a full visual configuration editor.
6. Cron jobs run only while Montra is running; use a process manager for availability and backups.
7. Scheduled AI status posting and all outbound WhatsApp sends require live testing, valid account access and review of status privacy settings.

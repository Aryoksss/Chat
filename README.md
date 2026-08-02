# WhatsApp AI Bot

A TypeScript WhatsApp bot with separate owner and group personas, an OpenAI-compatible AI API, tool calling, per-chat memory, media downloaders, contextual stickers, Hu Tao voice notes, and automatic reconnect.

## Features

- Separate, Markdown-based owner and group personas.
- AI retries, fallback models, tool calling, and per-chat memory.
- SQLite storage for group members, replies, media jobs, reminders, and sticker usage.
- Context-aware sticker pool with semantic analysis and recent-use rotation.
- Hu Tao voice notes using Edge-TTS and RVC, including optional automatic replies.
- Interactive WhatsApp menus with text-command fallback.
- Image generation/editing, video downloaders, anime search, weather, translation, QR codes, reminders, and web search.
- Group allowlist, bot-loop protection, rate limiting, deduplication, and graceful shutdown.
- SSRF protection for URL-fetching tools.

## Requirements

- Node.js 22 recommended; Node.js 20 minimum.
- A WhatsApp account that can be linked through Linked Devices.
- An API key for an OpenAI-compatible AI service.
- Cloudflare AI is optional for image generation/editing.
- Instagram and Twitter/X cookies are optional for authenticated downloads.

## Installation

```bash
git clone git@github.com:Aryoksss/Chat.git
cd Chat
npm install
cp .env.example .env
```

Set the required values in `.env`:

```env
NINE_ROUTER_API_KEY=your_api_key
NINE_ROUTER_BASE_URL=https://your-openai-compatible-api.example/v1
AI_MODEL=your_model
AI_FALLBACK_MODEL=your_fallback_model

OWNER_NUMBER=62812xxxxxxxx
OWNER_LID=
BOT_LID=
IGNORED_BOT_IDS=
GROUP_JID=1234567890-123456@g.us

PREFIX=.
SESSION_DIR=data/sessions
LOG_LEVEL=info
DATABASE_FILE=data/bot.db
```

Optional image configuration:

```env
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_API_KEY=your_cloudflare_api_token
CF_IMAGE_MODEL=@cf/black-forest-labs/flux-2-klein-9b
```

For multiple Cloudflare accounts, use one-line JSON:

```env
CF_ACCOUNTS=[{"accountId":"...","apiKey":"..."},{"accountId":"...","apiKey":"..."}]
```

Optional Hu Tao voice configuration:

```env
HUTAO_VOICE_SCRIPT=
HUTAO_AUTO_VOICE_ENABLED=true
HUTAO_AUTO_VOICE_CHANCE=0.18
HUTAO_AUTO_VOICE_COOLDOWN_MS=600000
HUTAO_AUTO_VOICE_MAX_CHARS=240
```

`OWNER_LID` is needed when WhatsApp reports the owner with a Linked ID. `BOT_LID` helps detect bot mentions in groups. Put other bot numbers or LIDs in `IGNORED_BOT_IDS`, separated by commas, to prevent reply loops.

When the bot is added to a group, the owner receives a notification with the group name, ID, and access status. Group access can be changed with the notification buttons or with commands such as `Izinkan Nama Grup`, `Blokir Nama Grup`, and `.groups`.

## Running

```bash
npm start
```

Development mode:

```bash
npm run dev
```

If no WhatsApp session exists, scan the QR code from WhatsApp → Linked Devices. The session is stored locally and normally only needs to be paired once.

## Commands

Commands accept `.`, `/`, and `!` prefixes. The configured `PREFIX` is used in menus.

| Command | Description |
|---|---|
| `.menu` / `.help` / `.commands` | Show the interactive menu |
| `.helper` | Show AI usage examples |
| `.sticker` / `.st` | Create a sticker from an image or reply |
| `.smeme TOP \| BOTTOM` | Create a meme sticker from an image or video |
| `.sticker-pool <context>` / `.sp <context>` | Send a context-matching sticker |
| `.anggota` / `.siapa <name>` | Find known group members |
| `.panggil-aku <name>` | Set your group nickname |
| `.jobs` / `.cancel <id>` | View or cancel your media jobs |
| `.reminder <request>` | Create a one-time or recurring reminder |
| `.reminders` / `.cancel-reminder <id>` | Manage reminders |
| `.yt <url>` | Download YouTube media; add `--audio` for audio |
| `.ig <url>` / `.tt <url>` / `.tw <url>` | Download Instagram, TikTok, or Twitter/X media |
| `.brainly <question>` | Search for school answers |
| `.qr <text>` | Create a QR code |
| `.gambar <prompt>` | Generate or edit an image |
| `.translate <language> <text>` | Translate text |
| `.shortlink <url>` / `.weather <city>` | Shorten a URL or check weather |
| `.anime <title>` | Search anime information |
| `.web-search <query>` | Search the web |
| `.4khd-search <query>` | Search 4KHD galleries |
| `.4khd-latest` / `.4khd-detail <url>` | Browse 4KHD galleries |

Incoming stickers from the owner and groups are archived, analyzed, and added to the contextual pool when analysis succeeds. Recent usage prevents the same sticker from being repeated unnecessarily.

### Owner commands

| Command | Description |
|---|---|
| `/status` | Show connection, uptime, model, and tool count |
| `/reload` | Reload personas without restarting |
| `/log` | Show the active log level |
| `/memory` / `/clear` | View or clear memory for the current chat |
| `.stickers` | List stickers and their tags |
| `.retag <number> tags \| description` | Update sticker context |
| `.hapus-sticker <number>` | Remove a sticker from the pool |

## Cookies

Optional Netscape cookie files can be stored as:

```text
data/cookies/instagram.txt
data/cookies/instagram-cookies.txt
data/cookies/twitter.txt
data/cookies/twitter-cookies.txt
```

## Personas and memory

Personas are stored in `personas/owner/` and `personas/group/`. Their main files are `AGENT.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, and `USER.md`.

Long-term memory is scoped by chat and stored under `memory/`.

## Build and test

```bash
npm run build
npm test
```

## Troubleshooting

- `401 loggedOut`: check WhatsApp Linked Devices and pair the session again if needed.
- `Router returned null`: check `OWNER_NUMBER`, `OWNER_LID`, `GROUP_JID`, and `BOT_LID`.
- The bot does not answer in a group: mention the bot, reply to one of its messages, or use a command.
- Image tools fail: check `CF_ACCOUNT_ID`, `CF_API_KEY`, or `CF_ACCOUNTS`.
- Downloader cookies fail: export fresh Netscape cookies and use the filenames above.

## Indonesian documentation

See [README.id.md](README.id.md) for the Indonesian version.

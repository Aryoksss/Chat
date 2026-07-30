# 🤖 WhatsApp AI Bot

Multi-persona WhatsApp bot with AI integration via 9router. Berbeda kepribadian untuk chat owner vs grup, dilengkapi tools lengkap dan memori jangka panjang.

## ✨ Fitur

| Fitur | Description |
|-------|-------------|
| **🧠 Multi-Persona** | Beda karakter buat owner DM vs grup, diatur lewat `AGENT.md`, `SOUL.md`, `TOOLS.md` |
| **🤖 AI Integration** | OpenAI-compatible API via 9router — ganti model kapan aja |
| **🛠 Tools** | AI bisa panggil tools sendiri sesuai konteks |
| **🧠 Long-term Memory** | Ingatan jangka panjang lewat `MEMORY.md`, auto-summarize |
| **🎛 System Commands** | Control bot dari chat: `/reload`, `/status`, `/model`, `/log` |
| **🔧 Auto Reconnect** | Bot reconnect otomatis kalau koneksi putus |

## 🛠 Daftar Tools

| Tool | Command | Fungsi |
|------|---------|--------|
| Sticker Maker | `.st` | Convert gambar → sticker WA. Author: **yoks** |
| YouTube Downloader | `.yt <url>` | Download YT video/audio |
| Instagram Downloader | `.ig <url>` | Download IG post/reels/story |
| TikTok Downloader | `.tt <url>` | Download TikTok tanpa watermark |
| Twitter/X Downloader | `.tw <url>` | Download video/gambar dari X |
| Brainly | `.brainly <soal>` | Cari jawaban soal pelajaran |
| QR Generator | `.qr <teks>` | Bikin QR code |
| Translate | `.tr <teks>` | Translate teks |
| Shortlink | `.short <url>` | Bikin link pendek |
| Weather | `.weather <kota>` | Cek cuaca |
| Anime Search | `.anime <judul>` | Cari info anime |

## 🚀 Cara Pakai

### 1. Clone & Install

```bash
git clone git@github.com:Aryoksss/Chat.git
cd Chat
npm install
```

### 2. Setup Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
NINE_ROUTER_API_KEY=your_api_key_here
NINE_ROUTER_BASE_URL=https://api.9router.com/v1
AI_MODEL=gpt-4o-mini
OWNER_NUMBER=62812xxxxxxxx
```

### 3. Cookies (untuk IG & Twitter)

Install extension **Get cookies.txt** di browser:
- Login ke Instagram → Export cookies → paste ke `data/cookies/instagram-cookies.txt`
- Login ke Twitter/X → Export cookies → paste ke `data/cookies/twitter-cookies.txt`

### 4. Jalankan Bot

```bash
npx tsx src/index.ts
```

Scan QR code di terminal dengan WhatsApp → **Linked Devices**.

### 5. System Commands (Owner Only)

| Command | Fungsi |
|---------|--------|
| `/reload` | Reload persona tanpa restart |
| `/status` | Cek koneksi, uptime, tools |
| `/model <nama>` | Ganti model AI on-the-fly |
| `/log` | Info logging |
| `/memory` | Lihat memory bot |
| `/clear` | Hapus memory & temp files |

## 📁 Struktur Project

```
whatsapp-bot/
├── src/
│   ├── index.ts                  # Entry point
│   ├── core/
│   │   ├── client.ts             # Baileys koneksi + reconnect
│   │   ├── ai.ts                 # 9router API bridge
│   │   ├── router.ts             # Owner vs Group router
│   │   └── types.ts              # Shared types
│   ├── persona/
│   │   └── loader.ts             # Parse AGENT.md / SOUL.md / TOOLS.md
│   ├── tools/
│   │   ├── registry.ts           # Tool registration
│   │   ├── executor.ts           # Tool execution
│   │   └── handlers/             # 11 tool implementations
│   ├── memory/
│   │   └── manager.ts            # MEMORY.md R/W + summarizer
│   ├── message/
│   │   └── handler.ts            # Main pipeline
│   └── system/
│       ├── config.ts, logger.ts
│       └── cmd-handler.ts        # /reload, /status, dll
├── personas/
│   ├── owner/ (AGENT.md, SOUL.md, TOOLS.md)
│   └── group/ (AGENT.md, SOUL.md, TOOLS.md)
├── data/
│   ├── sessions/                 # Baileys auth
│   └── cookies/                  # IG & Twitter cookies
├── memory/MEMORY.md
├── .env.example
└── package.json
```

## 🔧 Tech Stack

| Komponen | |
|----------|-|
| WhatsApp | `@whiskeysockets/baileys` (multi-device) |
| Bahasa | TypeScript + Node.js 22 |
| AI | 9router (OpenAI-compatible) |
| Memory | `MEMORY.md` + auto-summarize |
| Daemon | PM2 (opsional) |

## 📝 Tips

- **Setelah restart bot** → scan QR hanya sekali pertama, selanjutnya otomatis
- **Chat pribadi owner** pake persona owner, **grup** pake persona grup
- **Cookies IG/Twitter** kadang expired — re-export & paste ulang kalau error
- **Ganti model** kapan aja pake `/model gpt-4` atau `/model claude-sonnet-4`

## Co-Authored-By

Claude <noreply@anthropic.com>

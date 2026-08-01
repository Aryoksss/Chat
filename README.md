# WhatsApp AI Bot

Bot WhatsApp berbasis TypeScript dengan persona terpisah untuk owner dan grup, integrasi AI melalui API OpenAI-compatible, pemanggilan tool, memory per chat, downloader media, serta reconnect otomatis.

## Fitur Utama

- Persona owner dan grup yang dapat diatur melalui file Markdown.
- AI dengan retry, exponential backoff, fallback model, dan tool calling.
- Memory jangka pendek per chat serta memory jangka panjang yang diarsipkan dan diringkas otomatis.
- Menu WhatsApp interaktif dengan fallback ke menu teks.
- Prefix command `.`, `/`, dan `!`. Nilai `PREFIX` menjadi prefix utama yang ditampilkan di menu.
- Antrean pesan per chat, rate limiter grup, deduplikasi pesan, dan graceful shutdown.
- Session WhatsApp tersimpan lokal dan reconnect dengan backoff tanpa menghapus session otomatis.
- File hasil tool menggunakan direktori sementara dan dihapus setelah selesai dikirim.
- Perlindungan SSRF pada tool pembaca URL (`web-fetch`).

## Persyaratan

- Node.js 22 direkomendasikan; minimal Node.js 20 sesuai dependency Baileys.
- Akun WhatsApp yang dapat ditautkan melalui Linked Devices.
- API key layanan AI OpenAI-compatible.
- Cloudflare AI bersifat opsional untuk generate/edit gambar.
- Cookie Instagram dan Twitter/X bersifat opsional untuk fallback konten yang memerlukan login.

## Instalasi

```bash
git clone git@github.com:Aryoksss/Chat.git
cd Chat
npm install
cp .env.example .env
```

Isi konfigurasi minimal di `.env`:

```env
NINE_ROUTER_API_KEY=your_api_key
NINE_ROUTER_BASE_URL=https://your-openai-compatible-api.example/v1
AI_MODEL=your_model
AI_FALLBACK_MODEL=your_fallback_model

OWNER_NUMBER=62812xxxxxxxx
OWNER_LID=
BOT_LID=
GROUP_JID=1234567890-123456@g.us

PREFIX=.
SESSION_DIR=data/sessions
LOG_LEVEL=info
```

Konfigurasi gambar opsional:

```env
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_API_KEY=your_cloudflare_api_token
CF_IMAGE_MODEL=@cf/black-forest-labs/flux-2-klein-9b
```

Untuk beberapa akun Cloudflare, gunakan JSON satu baris:

```env
CF_ACCOUNTS=[{"accountId":"...","apiKey":"..."},{"accountId":"...","apiKey":"..."}]
```

Konfigurasi opsional lainnya:

```env
WHISPER_API_URL=
HUTAO_VOICE_SCRIPT=
KUSONIME_DOMAIN=https://kusonime.com
AI_TIMEOUT_MS=60000
CF_IMAGE_TIMEOUT_MS=60000
```

`OWNER_LID` diperlukan jika WhatsApp melaporkan chat owner memakai Linked ID (`@lid`) dan nomor biasa tidak cocok. `BOT_LID` membantu mendeteksi mention bot di grup.

## Menjalankan Bot

Mode normal:

```bash
npm start
```

Mode development dengan watch:

```bash
npm run dev
```

Saat session belum tersedia, scan QR dari terminal melalui WhatsApp > Linked Devices. Session disimpan di `data/sessions/`, sehingga QR normalnya hanya diperlukan saat pairing pertama atau session sudah dicabut dari WhatsApp.

## Prefix

Semua command menerima tiga prefix berikut:

```text
.menu   /menu   !menu
.yt     /yt     !yt
.anime  /anime  !anime
```

Prefix pada `PREFIX` dipakai sebagai prefix utama untuk row menu dan prompt lanjutan. Secara default nilainya `.`.

## Command dan Tool

| Command | Fungsi |
|---|---|
| `.menu` / `.help` / `.commands` | Menampilkan menu interaktif |
| `.helper` | Panduan dan aksi cepat AI |
| `.sticker` / `.st` | Membuat sticker dari gambar atau gambar yang di-reply |
| `.yt <url>` | Mengunduh video YouTube; tambahkan `--audio` untuk audio |
| `.ig <url>` | Mengunduh media Instagram |
| `.tt <url>` | Mengunduh video TikTok |
| `.tw <url>` | Mengunduh media Twitter/X |
| `.brainly <soal>` | Mencari jawaban soal pelajaran |
| `.qr <teks>` | Membuat QR code |
| `.gambar <prompt>` | Generate gambar atau edit gambar yang dikirim/di-reply |
| `.translate <bahasa> <teks>` | Menerjemahkan teks, misalnya `.translate en halo` |
| `.shortlink <url>` | Memendekkan URL |
| `.weather <kota>` | Melihat cuaca kota |
| `.anime <judul>` | Mencari informasi anime |
| `.web-search <query>` | Mencari informasi di web |
| `.anime-search <judul>` | Mencari anime download dari Kusonime |
| `.anime-links <url\|nomor>` | Membuka link download dari URL atau hasil pencarian terakhir |
| `.4khd-search <query>` | Mencari galeri 4KHD |
| `.4khd-latest` | Menampilkan galeri 4KHD terbaru |
| `.4khd-detail <url>` | Membuka atau mengirim gambar dari galeri 4KHD |

`web-fetch` digunakan oleh AI untuk membaca halaman hasil pencarian dan tidak ditampilkan sebagai command menu. Tool `pap` khusus owner, tidak ditampilkan di menu, dan ditolak saat dipanggil dari grup.

### Command Owner

Command berikut hanya dijalankan untuk persona owner:

| Command | Fungsi |
|---|---|
| `/status` | Menampilkan koneksi, uptime, model, dan jumlah tool |
| `/reload` | Memuat ulang seluruh persona tanpa restart |
| `/log` | Menampilkan level log aktif |
| `/memory` | Menampilkan memory untuk chat saat ini |
| `/clear` | Menghapus memory untuk chat saat ini |

Command owner juga menerima prefix `.` dan `!`, misalnya `.status` atau `!reload`.

## Cookies Instagram dan Twitter/X

Simpan export Netscape cookies di salah satu nama berikut:

```text
data/cookies/instagram.txt
data/cookies/instagram-cookies.txt
data/cookies/twitter.txt
data/cookies/twitter-cookies.txt
```

Cookie hanya dikirim ke domain layanan asal ketika fallback authenticated digunakan. Cookie tidak diteruskan ke API downloader publik. Seluruh isi `data/cookies/` diabaikan Git.

## Persona dan Memory

Persona berada di:

```text
personas/owner/
personas/group/
```

File utama setiap persona:

- `AGENT.md`: aturan dan perilaku agent.
- `SOUL.md`: gaya bicara dan karakter.
- `TOOLS.md`: definisi tool untuk AI.
- `IDENTITY.md` dan `USER.md`: konteks personal owner, tidak disimpan ke Git.

Memory jangka panjang dipisahkan berdasarkan chat:

```text
memory/MEMORY-owner.md
memory/MEMORY-group-<hash>.md
memory/MEMORY-*-archive.md
```

File memory personal dan archive diabaikan Git agar konteks privat tidak ikut ter-commit.

## Struktur Project

```text
whatsapp-bot/
|-- src/
|   |-- index.ts
|   |-- core/                 # WhatsApp client, AI bridge, router, types
|   |-- message/              # Queue dan pipeline pesan
|   |-- memory/               # Memory per chat dan summarizer
|   |-- persona/              # Loader persona Markdown
|   |-- system/               # Config, logger, system command
|   `-- tools/
|       |-- registry.ts
|       |-- executor.ts
|       `-- handlers/         # Implementasi seluruh tool
|-- personas/
|   |-- owner/
|   `-- group/
|-- data/
|   |-- cookies/              # Cookie privat, diabaikan Git
|   |-- pap/                  # Dataset PAP owner, diabaikan Git
|   |-- sessions/             # Auth WhatsApp, diabaikan Git
|   `-- temp/                 # File sementara
|-- memory/
|-- tests/
|-- .env.example
`-- package.json
```

## Build dan Test

```bash
npm run build
npm test
```

Test yang tersedia mencakup isolasi memory, menu owner/grup, serta perlindungan SSRF dasar.

## Data Sensitif

Jangan commit file berikut:

- `.env` dan `.env.local`
- `data/sessions/` dan backup session
- `data/cookies/`
- `data/pap/`
- `personas/owner/IDENTITY.md`
- `personas/owner/USER.md`
- file memory owner, grup, dan archive

Aturan tersebut sudah tersedia di `.gitignore`. Jika sebuah credential pernah ter-commit, menghapus file saja tidak cukup; credential tetap harus dicabut atau dirotasi.

## Tech Stack

| Komponen | Teknologi |
|---|---|
| WhatsApp | `@itsliaaa/baileys` `0.3.18-final` |
| Runtime | Node.js + TypeScript ESM |
| AI | API OpenAI-compatible melalui 9router |
| Gambar | Cloudflare Workers AI / endpoint image OpenAI-compatible |
| Logging | Pino |
| Image processing | Sharp dan wa-sticker-formatter |

## Troubleshooting

- `401 loggedOut`: session ditolak atau sudah dicabut. Periksa Linked Devices dan session secara manual; bot tidak menghapus session otomatis.
- Stuck di `logging in`: pairing telah dimulai tetapi registrasi belum selesai. Hentikan bot, periksa Linked Devices, lalu scan satu QR baru dengan koneksi ponsel yang stabil.
- `Router returned null`: periksa `OWNER_NUMBER`, `OWNER_LID`, `GROUP_JID`, dan `BOT_LID`.
- Cookie gagal: export ulang cookie Netscape dan pastikan nama file sesuai daftar di atas.
- Tool gambar gagal: periksa `CF_ACCOUNT_ID`, `CF_API_KEY`, atau `CF_ACCOUNTS`.
- Bot tidak merespons grup: gunakan command, mention bot, atau reply pesan bot.

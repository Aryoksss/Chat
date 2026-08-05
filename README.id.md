# WhatsApp AI Bot

Bot WhatsApp berbasis TypeScript dengan persona owner dan grup, API AI OpenAI-compatible, pemanggilan tool, memory per chat, downloader media, sticker kontekstual, VN suara Hu Tao, dan reconnect otomatis.

## Fitur

- Persona owner dan grup berbasis file Markdown.
- Retry AI, model fallback, tool calling, dan memory per chat.
- SQLite untuk anggota grup, reply, job media, reminder, riwayat sticker, dan ledger keuangan khusus owner.
- Sticker pool yang dianalisis berdasarkan konteks dan tidak repetitif.
- VN Hu Tao dengan Edge-TTS dan RVC, termasuk balasan otomatis opsional.
- Menu WhatsApp interaktif dengan fallback command teks.
- Generate/edit gambar, downloader video, pencarian anime, cuaca, translate, QR, reminder, dan web search.
- Allowlist grup, perlindungan loop antarbot, rate limiter, deduplikasi, dan graceful shutdown.
- Perlindungan SSRF untuk tool pembaca URL.

## Persyaratan

- Node.js 22 direkomendasikan; minimal Node.js 20.
- Akun WhatsApp yang dapat ditautkan melalui Linked Devices.
- API key layanan AI OpenAI-compatible.
- Cloudflare AI opsional untuk generate/edit gambar.
- Cookie Instagram dan Twitter/X opsional untuk download yang memerlukan login.

## Instalasi

```bash
git clone git@github.com:Aryoksss/Chat.git
cd Chat
npm install
cp .env.example .env
```

Isi konfigurasi utama di `.env`:

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

Konfigurasi gambar opsional:

```env
CF_ACCOUNT_ID=your_cloudflare_account_id
CF_API_KEY=your_cloudflare_api_token
CF_IMAGE_MODEL=@cf/black-forest-labs/flux-2-klein-9b
```

Jika memakai banyak akun Cloudflare, gunakan JSON satu baris:

```env
CF_ACCOUNTS=[{"accountId":"...","apiKey":"..."},{"accountId":"...","apiKey":"..."}]
```

Konfigurasi VN Hu Tao opsional:

```env
HUTAO_VOICE_SCRIPT=
HUTAO_AUTO_VOICE_ENABLED=true
HUTAO_AUTO_VOICE_CHANCE=0.18
HUTAO_AUTO_VOICE_COOLDOWN_MS=600000
HUTAO_AUTO_VOICE_MAX_CHARS=240
```

`OWNER_LID` diperlukan jika WhatsApp melaporkan owner memakai Linked ID. `BOT_LID` membantu deteksi mention bot di grup. Isi `IGNORED_BOT_IDS` dengan nomor atau LID bot lain, pisahkan dengan koma, agar tidak terjadi loop balasan.

Saat bot ditambahkan ke grup, owner menerima notifikasi berisi nama, ID, dan status akses grup. Akses dapat diubah melalui tombol notifikasi atau command `Izinkan Nama Grup`, `Blokir Nama Grup`, dan `.groups`.

## Menjalankan bot

```bash
npm start
```

Mode development:

```bash
npm run dev
```

Jika session WhatsApp belum tersedia, scan QR melalui WhatsApp → Linked Devices. Session disimpan lokal dan biasanya hanya perlu pairing sekali.

## Command

Semua command menerima prefix `.`, `/`, dan `!`. Prefix pada `PREFIX` digunakan di menu.

| Command | Fungsi |
|---|---|
| `.menu` / `.help` / `.commands` | Menampilkan menu interaktif |
| `.helper` | Menampilkan contoh penggunaan AI |
| `.sticker` / `.st` | Membuat sticker dari gambar atau reply |
| `.smeme ATAS \| BAWAH` | Membuat sticker meme dari gambar atau video |
| `.sticker-pool <konteks>` / `.sp <konteks>` | Mengirim sticker sesuai konteks |
| `.anggota` / `.siapa <nama>` | Mencari anggota grup yang dikenal bot |
| `.panggil-aku <nama>` | Mengatur nama panggilan di grup |
| `.jobs` / `.cancel <id>` | Melihat atau membatalkan job media |
| `.reminder <permintaan>` | Membuat reminder sekali atau berulang |
| `.reminders` / `.cancel-reminder <id>` | Mengatur reminder |
| `.yt <url>` | Download media YouTube; tambahkan `--audio` untuk audio |
| `.ig <url>` / `.tt <url>` / `.tw <url>` / `.th <url>` | Download media Instagram, TikTok, Twitter/X, atau Threads |
| `.brainly <soal>` | Mencari jawaban soal pelajaran |
| `.qr <teks>` | Membuat QR code |
| `.gambar <prompt>` | Generate atau edit gambar |
| `.translate <bahasa> <teks>` | Menerjemahkan teks |
| `.shortlink <url>` / `.weather <kota>` | Memendekkan URL atau melihat cuaca |
| `.anime <judul>` | Mencari informasi anime |
| `.web-search <query>` | Mencari informasi di web |
| `.4khd-search <query>` | Mencari galeri 4KHD |
| `.4khd-latest` / `.4khd-detail <url>` | Menjelajah galeri 4KHD |

Sticker yang dikirim owner maupun grup otomatis diarsipkan, dianalisis, dan dimasukkan ke pool jika analisis berhasil. Riwayat pemakaian mencegah sticker yang sama dikirim terus-menerus.

### Command owner

| Command | Fungsi |
|---|---|
| `/status` | Menampilkan koneksi, uptime, model, dan jumlah tool |
| `/reload` | Memuat ulang persona tanpa restart |
| `/log` | Menampilkan level log aktif |
| `/memory` / `/clear` | Melihat atau menghapus memory chat saat ini |
| `.stickers` | Melihat sticker dan tag-nya |
| `.retag <nomor> tag \| deskripsi` | Memperbarui konteks sticker |
| `.hapus-sticker <nomor>` | Menghapus sticker dari pool |
| `.catat <transaksi>` | Mencatat manual, atau dipakai sebagai caption/reply foto untuk scan struk |
| `.keuangan` | Membuka menu keuangan pribadi |
| `.laporan [YYYY-MM]` / `.transaksi [YYYY-MM]` | Melihat laporan atau transaksi bulanan |
| `.pending` / `.export [YYYY-MM]` | Memeriksa transaksi pending atau export CSV |

## Keuangan owner dan Gmail

Scan struk dan ledger lokal tersedia hanya di DM owner. Polling Gmail dan laporan bulanan otomatis diaktifkan terpisah:

1. Aktifkan Gmail API pada project Google Cloud pribadi dan buat OAuth client jenis **Desktop app**.
2. Simpan file client sebagai `data/secrets/gmail-oauth-client.json`.
3. Buat label Gmail `FinanceBot` beserta filter yang hanya memberi label pada email transaksi BCA/blu asli.
4. Jalankan `npm run finance:gmail-auth`, buka URL yang tampil, lalu selesaikan login Google.
5. Isi `FINANCE_ENABLED=true` dan alamat pengirim notifikasi persis pada `FINANCE_GMAIL_ALLOWED_SENDERS`.

Auto-confirm email mati secara default. Pertahankan `FINANCE_EMAIL_AUTO_CONFIRM=false` sampai parser BCA/blu diverifikasi memakai contoh email yang sudah disensor. File OAuth di-ignore Git dan harus disalin terpisah ketika deploy ke VPS.

## Cookie

Cookie Netscape opsional dapat disimpan dengan nama berikut:

```text
data/cookies/instagram.txt
data/cookies/instagram-cookies.txt
data/cookies/twitter.txt
data/cookies/twitter-cookies.txt
```

## Persona dan memory

Persona berada di `personas/owner/` dan `personas/group/`. File utamanya adalah `AGENT.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, dan `USER.md`.

Memory jangka panjang dipisahkan berdasarkan chat dan disimpan di folder `memory/`.

## Build dan test

```bash
npm run build
npm test
```

## Troubleshooting

- `401 loggedOut`: periksa Linked Devices WhatsApp dan pairing ulang jika diperlukan.
- `Router returned null`: periksa `OWNER_NUMBER`, `OWNER_LID`, `GROUP_JID`, dan `BOT_LID`.
- Bot tidak merespons grup: mention bot, reply pesan bot, atau gunakan command.
- Tool gambar gagal: periksa `CF_ACCOUNT_ID`, `CF_API_KEY`, atau `CF_ACCOUNTS`.
- Cookie downloader gagal: export ulang cookie Netscape dan gunakan nama file di atas.

Untuk versi Inggris, lihat [README.md](README.md).

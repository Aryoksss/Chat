import { toolsRegistry } from './registry.js'
import { handleSticker } from './handlers/sticker.js'
import { handleStickerPool } from './handlers/sticker-pool.js'
import { handleSmeme } from './handlers/smeme.js'
import { handleYtDownload } from './handlers/yt-dl.js'
import { handleIgDownload } from './handlers/ig-dl.js'
import { handleTtDownload } from './handlers/tt-dl.js'
import { handleTwDownload } from './handlers/tw-dl.js'
import { handleBrainly } from './handlers/brainly.js'
import { handleQrGenerate } from './handlers/qr.js'
import { handleImageGen } from './handlers/image-gen.js'
import { handleTranslate } from './handlers/translate.js'
import { handleShortlink } from './handlers/shortlink.js'
import { handleWeather } from './handlers/weather.js'
import { handleAnimeSearch } from './handlers/anime.js'
import { handleWebSearch } from './handlers/web-search.js'
import { handleWebFetch } from './handlers/web-fetch.js'
import { handleFourkhdSearch, handleFourkhdLatest, handleFourkhdDetail } from './handlers/fourkhd.js'
import { handleAnimeDlSearch, handleAnimeLinks } from './handlers/anime-dl.js'
import { handlePap } from './handlers/pap.js'
import { handleReminder } from './handlers/reminder.js'

export function registerAllTools() {
  const tools = [
    { name: 'sticker', desc: 'Bikin sticker dari gambar', params: { imageType: { type: 'string' } }, handler: handleSticker },
    { name: 'smeme', desc: 'Bikin sticker meme dari gambar atau video dengan teks atas/bawah', params: { text: { type: 'string', description: 'Teks meme; gunakan tanda | untuk memisahkan teks atas dan bawah' } }, handler: handleSmeme },
    { name: 'sticker-pool', desc: 'Kirim sticker yang paling sesuai dengan konteks percakapan dari pool lokal. Selalu isi context dengan maksud/suasana pesan user.', params: { context: { type: 'string', description: 'Konteks atau suasana pesan, misalnya lucu, sedih, marah, setuju, kaget' } }, handler: handleStickerPool },
    { name: 'yt-dl', desc: 'Download YouTube', params: { url: { type: 'string' }, format: { type: 'string' } }, handler: handleYtDownload },
    { name: 'ig-dl', desc: 'Download Instagram', params: { url: { type: 'string' } }, handler: handleIgDownload },
    { name: 'tt-dl', desc: 'Download TikTok', params: { url: { type: 'string' } }, handler: handleTtDownload },
    { name: 'tw-dl', desc: 'Download Twitter/X', params: { url: { type: 'string' } }, handler: handleTwDownload },
    { name: 'brainly', desc: 'Cari jawaban soal pelajaran/PR dari Brainly (HANYA untuk soal sekolah)', params: { query: { type: 'string' } }, handler: handleBrainly },
    { name: 'qr', desc: 'Bikin QR code', params: { text: { type: 'string' } }, handler: handleQrGenerate },
    { name: 'img-gen', desc: 'Generate gambar baru dari prompt, atau EDIT gambar yang dikirim/di-reply (FLUX AI). Default realistic; anti-anime kecuali user minta anime.', params: { prompt: { type: 'string' } }, handler: handleImageGen },
    { name: 'translate', desc: 'Translate teks', params: { text: { type: 'string' }, to: { type: 'string' } }, handler: handleTranslate },
    { name: 'shortlink', desc: 'Pendekin URL', params: { url: { type: 'string' } }, handler: handleShortlink },
    { name: 'weather', desc: 'Cek cuaca', params: { city: { type: 'string' } }, handler: handleWeather },
    { name: 'reminder', desc: 'Buat pengingat sekali atau berulang. Pesan saat jatuh tempo akan disusun AI secara bervariasi.', params: { request: { type: 'string', description: 'Kalimat lengkap, contoh: ingatkan saya besok jam 8 bayar listrik' }, task: { type: 'string' }, when: { type: 'string' } }, handler: handleReminder },
    { name: 'anime', desc: 'Cari anime', params: { query: { type: 'string' } }, handler: handleAnimeSearch },
    { name: 'web-search', desc: 'Cari informasi di internet. Pakai UNTUK SEMUA pertanyaan yang butuh fakta, berita, info umum, atau hal yang tidak kamu yakin', params: { query: { type: 'string' }, maxResults: { type: 'number' } }, handler: handleWebSearch },
    { name: 'web-fetch', desc: 'Baca isi halaman web dari sebuah URL (ambil teks/JSON dari link). Gunakan untuk membaca detail dari link yang ditemukan web-search', params: { url: { type: 'string' }, maxChars: { type: 'number' } }, handler: handleWebFetch },
    { name: '4khd-search', desc: 'Cari galeri foto dari 4khd.com berdasarkan kata kunci. Balikin daftar post berisi judul, ukuran, jumlah foto, dan URL. Lanjut dibuka dengan 4khd-detail.', params: { query: { type: 'string' }, page: { type: 'number' } }, handler: handleFourkhdSearch },
    { name: '4khd-latest', desc: 'Ambil daftar galeri foto terbaru dari homepage 4khd.com. Lanjut dibuka dengan 4khd-detail.', params: { page: { type: 'number' } }, handler: handleFourkhdLatest },
    { name: '4khd-detail', desc: 'Buka detail post galeri foto 4khd.com. url opsional karena bisa pakai index = nomor post dari hasil 4khd-search terakhir. Tanpa download: tampilkan daftar URL foto. Dengan download=N (angka) kirim N foto sekaligus, download tanpa nilai = 1 foto. Pakai from (1-based) buat mulai dari foto tertentu.', params: { url: { type: 'string' }, index: { type: 'number' }, download: { type: 'integer' }, from: { type: 'number' } }, handler: handleFourkhdDetail },
    { name: 'anime-search', desc: 'Cari anime untuk DOWNLOAD (batch/episode) via Kusonime. Balikin daftar judul + URL. Lanjut buka link download dengan anime-links.', params: { query: { type: 'string' } }, handler: handleAnimeDlSearch },
    { name: 'anime-links', desc: 'Tampilkan link download anime per resolusi + host (Google Drive, Mega, Mediafire, Gofile, dll). url opsional karena bisa pakai index = nomor dari hasil anime-search terakhir. TIDAK mengunduh file ke chat, hanya menampilkan link.', params: { url: { type: 'string' }, index: { type: 'number' } }, handler: handleAnimeLinks },
    // Khusus owner: TIDAK di-getToolMenuMeta (sembunyi dari menu) & hanya owner bisa panggil.
    { name: 'pap', desc: 'KHUSUS OWNER. Kirim/generate foto pap buat owner. Pakai dataset data/pap/ kalau ada, kalau kosong generate via AI. Ditolak jika dipanggil dari grup.', params: { prompt: { type: 'string' } }, handler: handlePap },
  ]

  tools.forEach(tool => toolsRegistry.register(
    { name: tool.name, description: tool.desc, parameters: { type: 'object', properties: tool.params } },
    tool.handler as any
  ))
  console.log(`✅ ${tools.length} tools registered: ${tools.map(d => d.name).join(', ')}`)
}

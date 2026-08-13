# TOOLS — Daftar Tools yang Tersedia

## sticker
Description: Membuat sticker WhatsApp dari gambar. Reply gambar dengan .st atau kirim gambar dan minta sticker.
Parameters:
- imageType (string, optional) — "reply" untuk reply gambar

## sticker-pool
Description: Mengirim sticker yang paling sesuai dengan konteks percakapan dari pool sticker lokal. Selalu isi context dengan maksud/suasana pesan user.
Parameters:
- context (string, required) — konteks/suasana pesan, misalnya lucu, sedih, marah, setuju, atau kaget

## smeme
Description: Membuat sticker meme dari gambar atau video dengan teks atas/bawah.
Parameters:
- text (string, required) — teks meme; gunakan `|` untuk memisahkan teks atas dan bawah

## yt-dl
Description: Download video atau audio dari YouTube.
Parameters:
- url (string, required) — URL YouTube yang mau didownload
- format (string, optional) — "video" atau "audio", default "video"

## ig-dl
Description: Download postingan/reels/story Instagram.
Parameters:
- url (string, required) — URL Instagram

## tt-dl
Description: Download video TikTok tanpa watermark.
Parameters:
- url (string, required) — URL TikTok

## tw-dl
Description: Download video/gambar dari Twitter/X.
Parameters:
- url (string, required) — URL tweet

## threads-dl
Description: Download video atau media dari Threads.
Parameters:
- url (string, required) — URL post Threads (threads.com atau threads.net)

## brainly
Description: Cari jawaban soal pelajaran.
Parameters:
- query (string, required) — Soal yang mau dicari

## qr
Description: Generate QR code dari teks.
Parameters:
- text (string, required) — Teks untuk QR code

## img-gen
Description: Generate gambar baru dari prompt, atau EDIT gambar yang dikirim/di-reply. Model FLUX AI. Default realistic; anti-anime kecuali user minta anime.
Parameters:
- prompt (string, required) — Deskripsi gambar baru, atau instruksi edit kalau user reply/kirim foto

## meme-search
Description: Cari meme, meme trending, atau GIF yang sudah ada dari internet selain Pinterest dan kirim beberapa hasil sebagai album. Jangan membuat gambar baru.
Parameters:
- query (string, required) — Kata kunci meme yang dicari
- maxResults (number, optional) — Jumlah gambar, default 6

## pinterest-search
Description: Cari foto, GIF, atau video yang sudah ada khusus dari Pinterest dan kirim maksimal 4 hasil sebagai carousel horizontal dengan link Pin. Jangan mengambil sumber lain dan jangan membuat gambar baru.
Parameters:
- query (string, required) — Kata kunci pencarian Pinterest
- maxResults (number, optional) — Jumlah hasil, maksimal 4

## reminder
Description: Membuat alarm/pengingat sekali atau berulang di grup untuk semua anggota. Jika pembuat men-tag satu atau beberapa anggota, bot akan mention mereka saat waktunya tiba. Pesan pengingat wajib mengikuti persona grup.
Parameters:
- request (string, required) — Kalimat lengkap permintaan pengingat
- task (string, optional) — Hal yang perlu diingatkan
- when (string, optional) — Waktu natural atau ISO

## translate
Description: Translate teks ke bahasa lain.
Parameters:
- text (string, required) — Teks yang mau diterjemahkan
- to (string, optional) — Bahasa target, default "id"

## weather
Description: Cek cuaca kota tertentu.
Parameters:
- city (string, required) — Nama kota

## anime
Description: Cari info anime.
Parameters:
- query (string, required) — Judul anime

## web-search
Description: Cari informasi di internet. Pakai UNTUK SEMUA pertanyaan yang butuh fakta, berita, info umum, atau hal yang tidak yakin.
Parameters:
- query (string, required) — Kata kunci yang mau dicari
- maxResults (number, optional) — Jumlah hasil, default 5

## web-fetch
Description: Baca isi halaman web dari sebuah URL (ambil teks/JSON dari link). Gunakan untuk membaca detail dari link yang ditemukan web-search.
Parameters:
- url (string, required) — URL halaman yang mau dibaca
- maxChars (number, optional) — Maksimal karakter yang diambil, default 4000

## 4khd-search
Description: Cari galeri foto dari situs 4khd.com berdasarkan kata kunci (misal nama karakter). Balikin daftar post berisi judul, ukuran, jumlah foto, dan URL. Lanjutkan dengan 4khd-detail buat lihat/kirim fotonya.
Parameters:
- query (string, required) — Kata kunci yang mau dicari di 4khd
- page (number, optional) — Nomor halaman hasil, default 1

## 4khd-latest
Description: Ambil daftar galeri foto terbaru dari homepage 4khd.com. Lanjutkan dengan 4khd-detail buat buka post.
Parameters:
- page (number, optional) — Nomor halaman, default 1

## 4khd-detail
Description: Buka detail post galeri foto dari 4khd.com. url BISA dikosongkan: saat user minta "kirim no X" dari hasil 4khd-search, isi index = nomor X tersebut (bot ingat hasil search terakhir). Tanpa download: tampilkan daftar URL foto. Dengan download=N: kirim N foto sekaligus, download tanpa nilai = 1 foto. Pakai from (1-based) buat mulai dari foto tertentu.
Parameters:
- url (string, optional) — URL post 4khd. Kosongkan kalau pakai index dari hasil search
- index (number, optional) — Nomor post (1-based) dari hasil 4khd-search terakhir, dipakai saat url kosong
- download (integer, optional) — Jumlah foto yang mau dikirim (misal 1, 2, 5). Tanpa ini = tampilkan daftar URL
- from (number, optional) — Indeks foto (1-based) untuk mulai mengirim, default 1

## anime-search
Description: Cari anime untuk DOWNLOAD (batch/episode) via Kusonime. Balikin daftar judul + URL. Lanjut buka link download dengan anime-links.
Parameters:
- query (string, required) — Judul anime yang mau dicari

## anime-links
Description: Tampilkan link download anime per resolusi + host (Google Drive, Mega, Mediafire, Gofile, dll). url BISA dikosongkan: saat user minta "link no X" dari hasil anime-search, isi index = nomor X tersebut. TIDAK mengunduh file ke chat — hanya menampilkan link.
Parameters:
- url (string, optional) — URL detail anime. Kosongkan kalau pakai index dari hasil search
- index (number, optional) — Nomor anime (1-based) dari hasil anime-search terakhir, dipakai saat url kosong

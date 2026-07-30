# TOOLS — Daftar Tools yang Tersedia

## sticker
Description: Membuat sticker WhatsApp dari gambar. Reply gambar dengan .st atau kirim gambar dan minta sticker.
Parameters:
- imageType (string, optional) — "reply" untuk reply gambar, "caption" untuk kirim langsung
- author (string, optional) — author sticker, default "yoks"
- packname (string, optional) — nama pack sticker

## yt-dl
Description: Download video atau audio dari YouTube. Kasih link YouTube-nya aja.
Parameters:
- url (string, required) — URL YouTube yang mau didownload
- format (string, optional) — "video" atau "audio", default "video"

## ig-dl
Description: Download postingan, reels, atau story Instagram. Kasih link IG-nya.
Parameters:
- url (string, required) — URL Instagram yang mau didownload

## tt-dl
Description: Download video TikTok tanpa watermark. Kasih link TikTok-nya.
Parameters:
- url (string, required) — URL TikTok yang mau didownload

## tw-dl
Description: Download video atau gambar dari Twitter/X. Kasih link tweet-nya.
Parameters:
- url (string, required) — URL tweet yang mau didownload

## brainly
Description: Cari jawaban soal pelajaran dari Brainly.
Parameters:
- query (string, required) — Soal atau pertanyaan yang mau dicari jawabannya

## qr
Description: Generate QR code dari teks atau link.
Parameters:
- text (string, required) — Teks atau link yang mau diubah jadi QR code

## translate
Description: Translate teks ke bahasa lain.
Parameters:
- text (string, required) — Teks yang mau diterjemahkan
- to (string, optional) — Bahasa target, default "id" (Indonesia)

## shortlink
Description: Bikin link pendek dari URL panjang.
Parameters:
- url (string, required) — URL yang mau dipendekin

## weather
Description: Cek cuaca di suatu kota.
Parameters:
- city (string, required) — Nama kota yang mau dicek cuacanya

## anime
Description: Cari info anime dari MyAnimeList.
Parameters:
- query (string, required) — Judul anime yang mau dicari

## to-pdf
Description: Convert dokumen (docx/pptx) ke PDF.
Parameters:
- url (string, required) — URL file yang mau di-convert

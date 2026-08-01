#!/usr/bin/env bash
# ============================================================
# Cek-kesehatan TTS Hu Tao (Edge-TTS + RVC) untuk bot WhatsApp.
# Jalankan di VPS (bukan di mesin lokal) karena butuh model RVC.
#
#   bash scripts/check-hutao-tts.sh
#
# Cek:
#   1. Script hutao-voice-note ada di lokasi yang dicari manager.ts
#   2. Prasyarat di dalam script (python rvc, edge-tts, model, index, ffmpeg)
#   3. Tes generate 1 suara singkat → cek file .ogg jadi
# ============================================================
set -euo pipefail

# --- 1. Cari script hutao-voice-note yang dipakai bot ---
SCRIPT=""
for c in \
  "${HUTAO_VOICE_SCRIPT:-}" \
  "$HOME/.openclaw/tools/hutao-voice-note" \
  "$HOME/.openclaw/tools/hutao-rvc/hutao-voice-note"
do
  if [[ -n "$c" && -f "$c" ]]; then SCRIPT="$c"; break; fi
done

if [[ -z "$SCRIPT" ]]; then
  echo "❌ Script hutao-voice-note TIDAK ditemukan."
  echo "   Set HUTAO_VOICE_SCRIPT di .env, atau letakkan script di:"
  echo "   - ~/.openclaw/tools/hutao-voice-note"
  echo "   - ~/.openclaw/tools/hutao-rvc/hutao-voice-note"
  exit 1
fi
echo "✅ Script ditemukan: $SCRIPT"

# --- 2. Cek prasyarat internal script (ROOT dari script ini) ---
ROOT_HINT=""
# Bukti: teks script menyebut lokasi ROOT (mudah-mudahan hutao-rvc)
if grep -q 'hutao-rvc' "$SCRIPT"; then
  ROOT_HINT="$HOME/.openclaw/tools/hutao-rvc"
elif grep -q 'ROOT=' "$SCRIPT"; then
  ROOT_HINT="$(grep -oP 'ROOT="\K[^"]+' "$SCRIPT" | head -1 || true)"
fi

if [[ -n "$ROOT_HINT" ]]; then
  echo ""
  echo "INFO: ROOT dari script tampaknya: $ROOT_HINT"
  check_file() {
    local desc="$1"; local path="$2"
    if [[ -f "$path" || -d "$path" ]] || command -v "${path##*/}" >/dev/null 2>&1; then
      echo "   ✅ $desc"
    else
      echo "   ❌ $desc: $path"
    fi
  }
  check_file "python rvc" "$ROOT_HINT/.venv/bin/python"
  check_file "edge-tts" "$ROOT_HINT/.venv/bin/edge-tts"
  check_file "model hutao" "$ROOT_HINT/models/extracted/hutao-jp/hutao-jp.pth"
  check_file "index hutao" "$ROOT_HINT/models/extracted/hutao-jp/added_IVF1662_Flat_nprobe_1.index"
fi

echo ""
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "❌ ffmpeg belum terpasang (dibutuhkan script untuk konversi audio)."
else
  echo "✅ ffmpeg tersedia"
fi

# --- 3. Tes generate 1 suara singkat ---
echo ""
echo "🧪 Mencoba generate suara Hu Tao (teks singkat)..."
OUT="/tmp/hutao_test_$$.ogg"
if bash "$SCRIPT" --text "Tes suara Hu Tao" --output "$OUT" >/tmp/hutao_test_$$.log 2>&1; then
  if [[ -s "$OUT" ]]; then
    SIZE=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT" 2>/dev/null || echo '?')
    echo "✅ Berhasil! File: $OUT ($SIZE bytes)"
    echo "   Dengarkan: $OUT"
  else
    echo "⚠️  Script sukses tapi file output kosong."
  fi
else
  echo "❌ Tes gagal. Log terakhir:"
  tail -n 15 /tmp/hutao_test_$$.log
fi

echo ""
echo "Done."

// ============================================================
// Tool: QR Code Generator
// ============================================================

import QRCode from 'qrcode'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { logger } from '../../system/logger.js'

interface QrArgs {
  text: string
}

export async function handleQrGenerate(args: QrArgs): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image' | 'video' | 'sticker' | 'audio' | 'document'; error?: string }> {
  const { text } = args

  if (!text || text.trim().length === 0) {
    return { success: false, text: 'Kasih teks atau link yang mau diubah jadi QR code kak!' }
  }

  try {
    const outPath = join(tmpdir(), `qr_${Date.now()}.png`)
    // margin 4 = quiet zone sesuai standar QR (min. 4 modul); EC 'H' bikin tahan
    // artefak kompresi WhatsApp; width besar biar modul tetap kebaca setelah kompresi.
    await QRCode.toFile(outPath, text, {
      width: 600,
      margin: 4,
      errorCorrectionLevel: 'H',
      color: { dark: '#000000', light: '#ffffff' },
    })

    logger.info({ textLength: text.length }, 'QR code generated')

    return {
      success: true,
      text: `✅ QR code berhasil dibuat!`,
      filePath: outPath,
      fileType: 'image',
    }
  } catch (err: any) {
    logger.error({ err }, 'QR generation failed')
    return { success: false, error: `Gagal bikin QR code: ${err.message}` }
  }
}

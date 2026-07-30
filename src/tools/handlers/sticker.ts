// ============================================================
// Tool: Sticker Maker — convert image → WA sticker
// ============================================================

import sharp from 'sharp'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, unlink } from 'fs/promises'
import { logger } from '../../system/logger.js'

interface StickerArgs {
  imageType?: string
  author?: string
  packname?: string
  imageBuffer?: Buffer
  imagePath?: string
}

const AUTHOR = 'yoks'
const PACK = '🕷'

export async function handleSticker(args: StickerArgs, context: any): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: string; error?: string }> {
  try {
    let buffer: Buffer | null = null

    // If imageBuffer provided directly (from media download)
    if (args.imageBuffer) {
      buffer = args.imageBuffer
    }
    // If imagePath provided
    else if (args.imagePath) {
      const { readFile } = await import('fs/promises')
      buffer = await readFile(args.imagePath)
    }

    if (!buffer) {
      return { success: false, text: 'Tidak ada gambar yang ditemukan. Reply atau kirim gambarnya dulu ya!' }
    }

    // Process with sharp — resize to 512x512 (WA sticker standard)
    const processed = await sharp(buffer)
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 80 })
      .toBuffer()

    // Save temp file
    const outPath = join(tmpdir(), `sticker_${Date.now()}.webp`)
    await writeFile(outPath, processed)

    logger.info({ size: processed.length }, 'Sticker created')

    return {
      success: true,
      text: `Sticker berhasil dibuat! Author: ${AUTHOR}`,
      filePath: outPath,
      fileType: 'sticker',
    }
  } catch (err: any) {
    logger.error({ err }, 'Sticker creation failed')
    return { success: false, error: `Gagal bikin sticker: ${err.message}` }
  }
}

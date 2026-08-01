// ============================================================
// Tool: Sticker Maker — convert image / GIF / MP4 → WA sticker
// ============================================================

import { Sticker } from 'wa-sticker-formatter'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, readFile, unlink } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../../system/logger.js'

const execFileP = promisify(execFile)

interface StickerArgs {
  imageType?: string
  author?: string
  packname?: string
  imageBuffer?: Buffer
  imagePath?: string
}

const AUTHOR = 'yoks'
const PACK = '🕷'
const MAX_DURATION_SEC = 6    // animated stickers longer than this get cut (shorter = smaller)
const MAX_FPS = 15            // lower fps = much smaller file
const MAX_SIZE = 512          // WA sticker size
const TARGET_MAX_BYTES = 400 * 1024 // ~400KB; WhatsApp limit is ~500KB

/** Detect media type from magic bytes */
function detectKind(buf: Buffer): 'image' | 'gif' | 'video' {
  if (!buf || buf.length < 12) return 'image'
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  // WebP (may be animated): "RIFF" + "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'gif'
  // MP4/MOV: bytes 4-7 = ftyp
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video'
  return 'image'
}

/**
 * Compress an animated input (GIF/MP4/WebP) to a small animated WebP via the
 * ffmpeg binary. Starts aggressive, then keeps tightening (fewer fps / lower
 * quality / shorter) until the result is under TARGET_MAX_BYTES.
 */
async function compressAnimated(buf: Buffer, kind: 'gif' | 'video'): Promise<Buffer | null> {
  const inPath = join(tmpdir(), `sticker_in_${Date.now()}.${kind === 'video' ? 'mp4' : 'gif'}`)
  const outPath = join(tmpdir(), `sticker_comp_${Date.now()}.webp`)

  // Passes: [duration, fps, quality]
  const passes: Array<[number, number, number]> = [
    [6, 15, 50],
    [5, 12, 40],
    [4, 10, 30],
  ]

  try {
    await writeFile(inPath, buf)
    for (const [dur, fps, q] of passes) {
      try {
        await execFileP('ffmpeg', [
          '-y', '-i', inPath,
          '-t', String(dur),
          '-vf', `fps=${fps},scale=${MAX_SIZE}:${MAX_SIZE}:force_original_aspect_ratio=decrease,pad=${MAX_SIZE}:${MAX_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
          '-loop', '0',
          '-lossless', '0',
          '-q:v', String(q),
          '-preset', 'default',
          outPath,
        ], { maxBuffer: 10 * 1024 * 1024 })
        const result = await readFile(outPath)
        if (result.length <= TARGET_MAX_BYTES) return result
      } catch {
        // try next pass
      }
    }
    // Last attempt returned too big — return whatever we got from the last pass.
    try {
      return await readFile(outPath)
    } catch {
      return null
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'ffmpeg animated compress failed')
    return null
  } finally {
    unlink(inPath).catch(() => {})
    unlink(outPath).catch(() => {})
  }
}

export async function handleSticker(args: StickerArgs, context: any): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'sticker' | 'document' | 'video' | 'audio' | 'image'; caption?: string; error?: string }> {
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
    // Fallback: pull the image from the raw WA message when the user replied to an
    // image or sent one, so ".st" / ".sticker" works without extra args.
    else if (context?.rawMessage && typeof context?.downloadMedia === 'function') {
      const raw = context.rawMessage
      const quotedInfo = raw?.message?.extendedTextMessage?.contextInfo
      const quotedMsg = quotedInfo?.quotedMessage

      // Direct image/video attached to the command message itself.
      const directMedia = raw?.message?.imageMessage || raw?.message?.videoMessage
      // Image/video inside the quoted (replied-to) message.
      const quotedMedia = quotedMsg?.imageMessage || quotedMsg?.videoMessage

      if (directMedia) {
        buffer = await context.downloadMedia(raw)
      } else if (quotedMedia) {
        // Rebuild a WAMessage pointing AT the quoted media so downloadMediaMessage
        // can locate its url/directPath (the raw command message has no media of its own).
        const quotedMediaMsg = {
          key: {
            remoteJid: raw?.key?.remoteJid,
            fromMe: false,
            id: quotedInfo?.stanzaId || undefined,
          },
          message: quotedMsg,
          messageTimestamp: raw?.messageTimestamp,
        }
        buffer = await context.downloadMedia(quotedMediaMsg)
      }
    }

    if (!buffer) {
      return { success: false, text: 'Tidak ada gambar yang ditemukan. Reply atau kirim gambarnya dulu ya!' }
    }

    const author = args.author || AUTHOR
    const pack = args.packname || PACK

    // For GIF/MP4, compress through ffmpeg first (smaller animated webp), then let
    // wa-sticker-formatter embed the EXIF pack/author metadata.
    let processed: Buffer
    const kind = detectKind(buffer)
    if (kind === 'gif' || kind === 'video') {
      const compressed = await compressAnimated(buffer, kind)
      if (compressed) {
        const sticker = new Sticker(compressed, { pack, author, quality: 80 })
        processed = await sticker.build()
      } else {
        // ffmpeg failed — fall back to wa-sticker-formatter's built-in conversion.
        const sticker = new Sticker(buffer, { pack, author, quality: 80 })
        processed = await sticker.build()
      }
    } else {
      const sticker = new Sticker(buffer, { pack, author, quality: 80 })
      processed = await sticker.build()
    }

    // Save temp file
    const outPath = join(tmpdir(), `sticker_${Date.now()}.webp`)
    await writeFile(outPath, processed)

    logger.info({ size: processed.length, kind }, 'Sticker created')

    return {
      success: true,
      text: `Sticker berhasil dibuat!`,
      filePath: outPath,
      fileType: 'sticker',
      caption: `${author}|${pack}`, // carried through to executor (metadata already in file)
    }
  } catch (err: any) {
    logger.error({ err }, 'Sticker creation failed')
    return { success: false, error: `Gagal bikin sticker: ${err.message}` }
  }
}

// ============================================================
// Tool: Sticker Maker — convert image / GIF / MP4 → WA sticker
// ============================================================

import { Sticker } from 'wa-sticker-formatter'
import { normalizeMessageContent } from '@itsliaaa/baileys'
import sharp from 'sharp'
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

type StickerMediaKind = 'imageMessage' | 'videoMessage'

interface StickerMediaSource {
  kind: StickerMediaKind
  media: any
  fromCarousel: boolean
}

/** Find direct media, including media nested inside a Baileys carousel card. */
function findStickerMedia(content: any): StickerMediaSource | null {
  const normalized = normalizeMessageContent(content) || content
  if (normalized?.imageMessage) return { kind: 'imageMessage', media: normalized.imageMessage, fromCarousel: false }
  if (normalized?.videoMessage) return { kind: 'videoMessage', media: normalized.videoMessage, fromCarousel: false }

  const carousel = normalized?.interactiveMessage?.carouselMessage || normalized?.carouselMessage
  for (const card of carousel?.cards || []) {
    const header = card?.header || {}
    if (header.imageMessage) return { kind: 'imageMessage', media: header.imageMessage, fromCarousel: true }
    if (header.videoMessage) return { kind: 'videoMessage', media: header.videoMessage, fromCarousel: true }
  }
  return null
}

/** Build a downloadable WAMessage for a direct or quoted media source. */
export function extractStickerMediaMessage(raw: any): any | null {
  const direct = findStickerMedia(raw?.message)
  if (direct && !direct.fromCarousel) return raw

  const contextInfo = raw?.message?.extendedTextMessage?.contextInfo
  const quoted = contextInfo?.quotedMessage
  const source = findStickerMedia(quoted)
  if (!source) return null

  return {
    key: {
      remoteJid: raw?.key?.remoteJid,
      fromMe: source.fromCarousel,
      id: contextInfo?.stanzaId || undefined,
    },
    message: { [source.kind]: source.media },
    messageTimestamp: raw?.messageTimestamp,
  }
}

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
  // WebM/MKV: EBML header. Some carousel providers return WebM even when the
  // card metadata says video/mp4, so do not send it to the image converter.
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video'
  return 'image'
}

function mediaMagic(buf: Buffer): string {
  return buf.subarray(0, 16).toString('hex')
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
    [6, 6, 90],
    [6, 6, 85],
    [5, 8, 80],
  ]

  try {
    await writeFile(inPath, buf)
    for (const [dur, fps, q] of passes) {
      try {
        await execFileP('ffmpeg', [
          '-y', '-i', inPath,
          '-t', String(dur),
          '-vf', `fps=${fps},scale=${MAX_SIZE}:${MAX_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${MAX_SIZE}:${MAX_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=yuva420p`,
          '-c:v', 'libwebp_anim',
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

/** Extract a valid PNG frame when an animated input cannot be encoded as WebP. */
async function extractFirstFrame(buf: Buffer, kind: 'gif' | 'video'): Promise<Buffer> {
  const token = `${Date.now()}_${process.pid}`
  const inPath = join(tmpdir(), `sticker_frame_in_${token}.${kind === 'gif' ? 'gif' : 'media'}`)
  const outPath = join(tmpdir(), `sticker_frame_out_${token}.png`)

  try {
    await writeFile(inPath, buf)
    await execFileP('ffmpeg', [
      '-y', '-i', inPath,
      '-vf', `scale=${MAX_SIZE}:${MAX_SIZE}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${MAX_SIZE}:${MAX_SIZE}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      '-frames:v', '1',
      outPath,
    ], { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 })
    return await readFile(outPath)
  } finally {
    await Promise.all([
      unlink(inPath).catch(() => {}),
      unlink(outPath).catch(() => {}),
    ])
  }
}

/**
 * Build a sticker from a normalized still image. sharp also fixes image files
 * whose MIME/container is unusual but whose pixels are otherwise readable.
 */
async function buildSticker(input: Buffer, pack: string, author: string): Promise<Buffer> {
  try {
    return await new Sticker(input, { pack, author, quality: 80 }).build()
  } catch (firstError) {
    try {
      const normalized = await sharp(input).png().toBuffer()
      return await new Sticker(normalized, { pack, author, quality: 80 }).build()
    } catch {
      throw firstError
    }
  }
}

export async function handleSticker(args: StickerArgs, context: any): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'sticker' | 'document' | 'video' | 'audio' | 'image'; isAnimated?: boolean; caption?: string; error?: string }> {
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
      let mediaMessage = extractStickerMediaMessage(raw)
      // Replies to native carousel cards may contain only the quoted stanza ID;
      // recover the original carousel from Baileys' in-memory message store.
      if (!mediaMessage && typeof context.getMessage === 'function') {
        const quotedInfo = raw?.message?.extendedTextMessage?.contextInfo
        if (quotedInfo?.stanzaId) {
          const stored = await context.getMessage({
            remoteJid: raw?.key?.remoteJid,
            remoteJidAlt: raw?.key?.remoteJidAlt,
            id: quotedInfo.stanzaId,
          })
          const storedContent = stored?.message || stored
          if (storedContent) {
            mediaMessage = extractStickerMediaMessage({
              ...raw,
              message: {
                extendedTextMessage: {
                  contextInfo: { stanzaId: quotedInfo.stanzaId, quotedMessage: storedContent },
                },
              },
            })
            if (mediaMessage) logger.info('Sticker media recovered from quoted message store')
          }
        }
      }
      if (mediaMessage) buffer = await context.downloadMedia(mediaMessage)
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
    logger.info({ byteLength: buffer.length, magic: mediaMagic(buffer), kind }, 'Sticker source buffer detected')
    if (kind === 'gif' || kind === 'video') {
      const compressed = await compressAnimated(buffer, kind)
      if (compressed) {
        try {
          processed = await buildSticker(compressed, pack, author)
        } catch (err: any) {
          logger.warn({ error: err.message, kind }, 'Animated WebP sticker build failed; using first frame')
          processed = await buildSticker(await extractFirstFrame(buffer, kind), pack, author)
        }
      } else {
        // Never pass raw video/WebM to wa-sticker-formatter: its MIME detector
        // rejects several valid video containers. A static first frame is a
        // reliable fallback and is preferable to returning Invalid file type.
        processed = await buildSticker(await extractFirstFrame(buffer, kind), pack, author)
      }
    } else {
      processed = await buildSticker(buffer, pack, author)
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
      isAnimated: kind !== 'image',
      caption: `${author}|${pack}`, // carried through to executor (metadata already in file)
    }
  } catch (err: any) {
    logger.error({ err }, 'Sticker creation failed')
    return { success: false, error: `Gagal bikin sticker: ${err.message}` }
  }
}

// ============================================================
// Tool: Sticker Meme — add meme text to an image/video, then convert to sticker
// ============================================================

import sharp from 'sharp'
import { Sticker } from 'wa-sticker-formatter'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../../system/logger.js'

const execFileP = promisify(execFile)
const MAX_DURATION_SEC = 6
const TARGET_MAX_BYTES = 400 * 1024
const MAX_INPUT_BYTES = 30 * 1024 * 1024

interface SmemeArgs {
  text?: string
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!)
}

function wrapText(value: string, maxChars = 22): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (line && next.length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 4)
}

function textBlock(text: string, y: number, anchor: 'start' | 'middle'): string {
  const lines = wrapText(text)
  const lineHeight = 48
  const startY = anchor === 'start' ? y : y - (lines.length - 1) * lineHeight
  return lines.map((line, index) =>
    `<text x="256" y="${startY + index * lineHeight}" text-anchor="${anchor}" ` +
    `font-family="Impact, Arial Black, sans-serif" font-size="42" font-weight="900" ` +
    `fill="white" stroke="black" stroke-width="9" paint-order="stroke" ` +
    `stroke-linejoin="round">${escapeXml(line.toUpperCase())}</text>`
  ).join('')
}

async function getInputMedia(context: any): Promise<{ buffer: Buffer; kind: 'image' | 'video' } | null> {
  const raw = context?.rawMessage
  if (!raw || typeof context?.downloadMedia !== 'function') return null
  const quotedInfo = raw?.message?.extendedTextMessage?.contextInfo
  const quotedMsg = quotedInfo?.quotedMessage
  const directImage = raw?.message?.imageMessage
  const directVideo = raw?.message?.videoMessage
  const quotedImage = quotedMsg?.imageMessage
  const quotedVideo = quotedMsg?.videoMessage
  if (directImage || directVideo) {
    const buffer = await context.downloadMedia(raw)
    return buffer ? { buffer, kind: directVideo ? 'video' : 'image' } : null
  }
  if (quotedImage || quotedVideo) {
    const buffer = await context.downloadMedia({
      key: { remoteJid: raw?.key?.remoteJid, fromMe: false, id: quotedInfo?.stanzaId },
      message: quotedMsg,
      messageTimestamp: raw?.messageTimestamp,
    })
    return buffer ? { buffer, kind: quotedVideo ? 'video' : 'image' } : null
  }
  return null
}

async function createAnimatedMeme(video: Buffer, overlay: Buffer): Promise<Buffer> {
  const token = `${Date.now()}_${process.pid}`
  const inputPath = join(tmpdir(), `smeme_video_${token}.mp4`)
  const overlayPath = join(tmpdir(), `smeme_overlay_${token}.png`)
  const encodedPath = join(tmpdir(), `smeme_animated_${token}.webp`)
  const passes: Array<[duration: number, fps: number, quality: number]> = [
    [6, 6, 90],
    [6, 6, 85],
    [5, 8, 80],
  ]

  try {
    await Promise.all([writeFile(inputPath, video), writeFile(overlayPath, overlay)])
    let latest: Buffer | null = null
    for (const [duration, fps, quality] of passes) {
      const filter =
        `[0:v]fps=${fps},scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000[base];` +
        `[base][1:v]overlay=0:0:format=auto,format=yuva420p[out]`
      try {
        await execFileP('ffmpeg', [
          '-y',
          '-i', inputPath,
          '-i', overlayPath,
          '-filter_complex', filter,
          '-map', '[out]',
          '-an',
          '-t', String(Math.min(duration, MAX_DURATION_SEC)),
          '-c:v', 'libwebp_anim',
          '-loop', '0',
          '-lossless', '0',
          '-q:v', String(quality),
          '-preset', 'default',
          encodedPath,
        ], { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 })
        latest = await readFile(encodedPath)
        if (latest.length <= TARGET_MAX_BYTES) break
      } catch (err: any) {
        logger.warn({ error: err.message, duration, fps, quality }, 'Animated smeme compression pass failed')
      }
    }
    if (!latest) throw new Error('FFmpeg gagal mengubah video menjadi animated WebP')
    return latest
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => {}),
      unlink(overlayPath).catch(() => {}),
      unlink(encodedPath).catch(() => {}),
    ])
  }
}

export async function handleSmeme(args: SmemeArgs = {}, context: any): Promise<{
  success: boolean
  text?: string
  filePath?: string
  fileType?: 'sticker'
  isAnimated?: boolean
  error?: string
}> {
  let intermediate: string | null = null
  let stickerPath: string | null = null
  let completed = false
  try {
    const text = (args.text || '').trim()
    if (!text) return { success: false, text: 'Tulis teks meme-nya. Contoh: .smeme atas | bawah' }

    const media = await getInputMedia(context)
    if (!media) return { success: false, text: 'Reply atau kirim gambar/video dulu, lalu pakai .smeme teksnya.' }
    if (media.buffer.length > MAX_INPUT_BYTES) {
      return { success: false, text: 'Video terlalu besar. Maksimal 30 MB untuk .smeme.' }
    }

    const [top, bottom] = text.split(/\s*[|;]\s*/, 2)
    const topText = bottom ? top : ''
    const bottomText = bottom || top
    const overlay = Buffer.from(`<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
      ${topText ? textBlock(topText, 54, 'start') : ''}
      ${textBlock(bottomText, 478, 'middle')}
    </svg>`)

    stickerPath = join(tmpdir(), `smeme_${Date.now()}.webp`)
    let stickerInput: Buffer
    if (media.kind === 'video') {
      // Render the SVG to a transparent PNG before overlaying it on every
      // video frame with FFmpeg.
      const overlayPng = await sharp(overlay).png().toBuffer()
      stickerInput = await createAnimatedMeme(media.buffer, overlayPng)
    } else {
      intermediate = join(tmpdir(), `smeme_img_${Date.now()}.png`)
      await sharp(media.buffer)
        .resize(512, 512, { fit: 'cover', position: 'centre' })
        .composite([{ input: overlay }])
        .png()
        .toFile(intermediate)
      stickerInput = await readFile(intermediate)
    }

    const sticker = new Sticker(stickerInput, { pack: '🕷', author: 'yoks', quality: 80 })
    await writeFile(stickerPath, await sticker.build())
    completed = true
    logger.info({ kind: media.kind, filePath: stickerPath }, 'Sticker meme created')
    return { success: true, filePath: stickerPath, fileType: 'sticker', isAnimated: media.kind === 'video', text: 'Sticker meme dibuat!' }
  } catch (err: any) {
    return { success: false, error: `Gagal bikin sticker meme: ${err.message}` }
  } finally {
    if (intermediate) await unlink(intermediate).catch(() => {})
    if (!completed && stickerPath) await unlink(stickerPath).catch(() => {})
  }
}

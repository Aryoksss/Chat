// ============================================================
// Tool: YouTube Downloader
// ============================================================

import { logger } from '../../system/logger.js'
import { tmpdir } from 'os'
import { join } from 'path'

interface YtArgs {
  url: string
  format?: string
}

export async function handleYtDownload(args: YtArgs): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image' | 'video' | 'sticker' | 'audio' | 'document'; error?: string }> {
  const { url, format = 'video' } = args

  if (!url || !url.includes('youtube.com') && !url.includes('youtu.be')) {
    return { success: false, text: 'Kasih link YouTube yang valid dulu kak!' }
  }

  try {
    // Dynamic import — ytdl-core might have ESM issues
    let ytdl: any
    try {
      ytdl = await import('ytdl-core')
    } catch {
      // Fallback: provide instructions if ytdl-core not installed
      return {
        success: false,
        text: '⚠️ Fitur YouTube download belum aktif. Install dulu: npm install ytdl-core',
      }
    }

    // Validate URL
    if (!ytdl.validateURL(url)) {
      return { success: false, text: 'Link YouTube-nya gak valid kak.' }
    }

    // Get info
    const info = await ytdl.getInfo(url)
    const title = info.videoDetails.title.replace(/[^\w\s]/g, '')

    if (format === 'audio') {
      // Audio only — download as MP3
      const stream = ytdl(url, { quality: 'highestaudio', filter: 'audioonly' })
      const outPath = join(tmpdir(), `${title}_${Date.now()}.mp3`)
      const { createWriteStream } = await import('fs')
      const { pipeline } = await import('stream/promises')

      await pipeline(stream, createWriteStream(outPath))

      return {
        success: true,
        text: `🎵 ${title} — siap dikirim!`,
        filePath: outPath,
        fileType: 'audio',
      }
    } else {
      // Video
      const stream = ytdl(url, { quality: 'highestvideo' })
      const outPath = join(tmpdir(), `${title}_${Date.now()}.mp4`)
      const { createWriteStream } = await import('fs')
      const { pipeline } = await import('stream/promises')

      await pipeline(stream, createWriteStream(outPath))

      return {
        success: true,
        text: `🎬 ${title} — siap dikirim!`,
        filePath: outPath,
        fileType: 'video',
      }
    }
  } catch (err: any) {
    logger.error({ err }, 'yt-dl failed')
    return { success: false, error: `Gagal download YouTube: ${err.message}` }
  }
}

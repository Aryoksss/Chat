// ============================================================
// Tool: TikTok Downloader (no watermark)
// ============================================================

import { logger } from '../../system/logger.js'
import { tmpdir } from 'os'
import { join } from 'path'

interface TtArgs {
  url: string
}

export async function handleTtDownload(args: TtArgs): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image' | 'video' | 'sticker' | 'audio' | 'document'; caption?: string; error?: string }> {
  const { url } = args

  if (!url || !url.includes('tiktok.com')) {
    return { success: false, text: 'Kasih link TikTok yang valid kak!' }
  }

  try {
    // Using tikwm.com API (free, no auth needed)
    const response = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`)
    const json = await response.json() as any

    if (json?.code === 0 && json?.data) {
      const videoUrl = json.data.play
      const author = json.data.author?.nickname || 'TikTok Creator'
      const title = json.data.title || 'TikTok Video'

      if (!videoUrl) {
        return { success: false, text: 'Gagal dapetin link video. Mungkin video-nya private.' }
      }

      // Download the video
      const mediaResp = await fetch(videoUrl)
      const buffer = Buffer.from(await mediaResp.arrayBuffer())
      const outPath = join(tmpdir(), `tiktok_${Date.now()}.mp4`)
      const { writeFile } = await import('fs/promises')
      await writeFile(outPath, buffer)

      return {
        success: true,
        text: `🎥 TikTok by ${author} — siap dikirim!`,
        filePath: outPath,
        fileType: 'video',
        caption: `By ${author} | Downloaded via Bot 🤖`,
      }
    }

    return { success: false, text: 'Gagal download TikTok. Link-nya bener?' }
  } catch (err: any) {
    logger.error({ err }, 'tt-dl failed')
    return { success: false, error: `Gagal download TikTok: ${err.message}` }
  }
}

// ============================================================
// Tool: Twitter/X Downloader (with cookies support)
// ============================================================

import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { logger } from '../../system/logger.js'
import { config } from '../../system/config.js'
import { tmpdir } from 'os'
import { join } from 'path'

interface TwArgs {
  url: string
}

/** Load cookies from file for authenticated requests */
async function loadCookies(): Promise<string | null> {
  const cookieFile = join(config.COOKIES_DIR || 'data/cookies', 'twitter-cookies.txt')
  if (!existsSync(cookieFile)) return null
  try {
    const text = await readFile(cookieFile, 'utf-8')
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('//'))
    const cookieStr = lines.map(l => {
      const parts = l.trim().split('\t')
      if (parts.length >= 7) return `${parts[5]}=${parts[6]}`
      return null
    }).filter(Boolean).join('; ')
    return cookieStr || null
  } catch {
    return null
  }
}

export async function handleTwDownload(args: TwArgs): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image' | 'video' | 'sticker' | 'audio' | 'document'; error?: string }> {
  const { url } = args

  if (!url || !url.includes('twitter.com') && !url.includes('x.com')) {
    return { success: false, text: 'Kasih link Twitter/X yang valid kak!' }
  }

  try {
    // Build headers with cookies if available
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    }
    const cookies = await loadCookies()
    if (cookies) {
      headers['Cookie'] = cookies
      logger.info('Using Twitter cookies from file')
    } else {
      logger.warn('No Twitter cookies found — public API only')
    }

    // Try public Twitter/X downloader API
    const apiUrl = `https://api.egojs.com/api/download/twitter?url=${encodeURIComponent(url)}`
    const response = await fetch(apiUrl, { headers })
    const data = await response.json() as any

    if (data?.result?.media?.[0]) {
      const media = data.result.media[0]
      const mediaUrl = media.url || media.download_url

      if (mediaUrl) {
        const mediaResp = await fetch(mediaUrl, { headers })
        const buffer = Buffer.from(await mediaResp.arrayBuffer())
        const ext = mediaUrl.includes('.mp4') ? 'mp4' : 'jpg'
        const outPath = join(tmpdir(), `twitter_${Date.now()}.${ext}`)
        const { writeFile } = await import('fs/promises')
        await writeFile(outPath, buffer)

        return {
          success: true,
          text: '🐦 Twitter media berhasil didownload!',
          filePath: outPath,
          fileType: ext === 'mp4' ? 'video' : 'image',
        }
      }
    }

    // Fallback: try direct API with cookies for authenticated access
    if (cookies) {
      try {
        const tweetId = extractTweetId(url)
        if (tweetId) {
          const twResp = await fetch(`https://api.twitter.com/2/tweets/${tweetId}?expansions=attachments.media_keys&media.fields=url,preview_image_url,variants,type`, {
            headers: {
              ...headers,
              'Authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
              'X-Guest-Token': cookies.match(/guest_token[=;]\s*([^;]+)/)?.[1] || '',
            }
          })
          const twData = await twResp.json() as any
          const media = twData?.includes?.media?.[0]
          if (media) {
            const mediaUrl = media.url || media.preview_image_url
            if (mediaUrl) {
              const mediaResp = await fetch(mediaUrl, { headers })
              const buffer = Buffer.from(await mediaResp.arrayBuffer())
              const ext = media.type === 'video' ? 'mp4' : 'jpg'
              const outPath = join(tmpdir(), `twitter_${Date.now()}.${ext}`)
              const { writeFile } = await import('fs/promises')
              await writeFile(outPath, buffer)
              return {
                success: true,
                text: '🐦 Twitter media berhasil didownload!',
                filePath: outPath,
                fileType: ext === 'mp4' ? 'video' : 'image',
              }
            }
          }
        }
      } catch (scrapeErr) {
        logger.warn({ scrapeErr }, 'Direct Twitter API scrape failed')
      }
    }

    return { success: false, text: 'Gak bisa dapetin media dari tweet itu. Mungkin tweet-nya berisi teks doang, private, atau cookies-nya expired.' }
  } catch (err: any) {
    logger.error({ err }, 'tw-dl failed')
    return { success: false, error: `Gagal download Twitter: ${err.message}` }
  }
}

/** Extract tweet ID from Twitter/X URL */
function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/)
  return match?.[1] || null
}

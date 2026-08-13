// ============================================================
// Tool: Twitter/X Downloader (with cookies support)
// ============================================================

import { readFile, readdir, stat, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { logger } from '../../system/logger.js'
import { config } from '../../system/config.js'
import { tmpdir } from 'os'
import { join } from 'path'

interface TwArgs {
  url: string
}

const execFileP = promisify(execFile)
const MAX_MEDIA_BYTES = 50 * 1024 * 1024

/** Load cookies from file for authenticated requests */
async function loadCookies(): Promise<string | null> {
  const cookieFiles = ['twitter.txt', 'twitter-cookies.txt']
  for (const fileName of cookieFiles) {
    const cookieFile = join(config.COOKIES_DIR || 'data/cookies', fileName)
    if (!existsSync(cookieFile)) continue
    try {
      const text = await readFile(cookieFile, 'utf-8')
      const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('//'))
      const cookieStr = lines.map(l => {
        const parts = l.trim().split('\t')
        if (parts.length >= 7) return `${parts[5]}=${parts[6]}`
        return null
      }).filter(Boolean).join('; ')
      if (cookieStr) return cookieStr
    } catch {
      continue
    }
  }
  return null
}

function findCookieFile(): string | null {
  for (const fileName of ['twitter.txt', 'twitter-cookies.txt']) {
    const cookieFile = join(config.COOKIES_DIR || 'data/cookies', fileName)
    if (existsSync(cookieFile)) return cookieFile
  }
  return null
}

async function downloadWithYtDlp(url: string, cookieFile: string | null): Promise<{
  filePath: string
  fileType: 'video' | 'image'
} | null> {
  const outputPrefix = join(tmpdir(), `twitter_${Date.now()}_${process.pid}`)
  const outputTemplate = `${outputPrefix}.%(ext)s`
  const args = [
    '--no-playlist', '--no-warnings', '--no-progress', '--restrict-filenames',
    '--max-filesize', `${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)}M`,
    '--format', 'best[ext=mp4]/best', '--output', outputTemplate,
  ]
  if (cookieFile) args.push('--cookies', cookieFile)
  args.push(url)

  try {
    await execFileP('yt-dlp', args, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
    const prefix = outputPrefix.split('/').pop() || ''
    const files = (await readdir(tmpdir()))
      .filter(name => name.startsWith(`${prefix}.`) && !name.endsWith('.part'))
      .map(name => join(tmpdir(), name))
    const filePath = files[0]
    if (!filePath) return null
    const fileInfo = await stat(filePath)
    if (fileInfo.size > MAX_MEDIA_BYTES) {
      await unlink(filePath).catch(() => {})
      throw new Error('Media Twitter terlalu besar (maksimal 50 MB)')
    }
    return { filePath, fileType: /\.(?:mp4|webm|mkv|mov)$/i.test(filePath) ? 'video' : 'image' }
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'yt-dlp Twitter download failed')
    return null
  }
}

export async function handleTwDownload(args: TwArgs): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image' | 'video' | 'sticker' | 'audio' | 'document'; error?: string }> {
  const { url } = args

  if (!url || !url.includes('twitter.com') && !url.includes('x.com')) {
    return { success: false, text: 'Kasih link Twitter/X yang valid kak!' }
  }

  try {
    // Public downloader API must never receive the user's X/Twitter session cookie.
    const publicHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    }
    const cookies = await loadCookies()
    const xHeaders: Record<string, string> = { ...publicHeaders }
    if (cookies) {
      xHeaders['Cookie'] = cookies
      logger.info('Using Twitter cookies from file')
    } else {
      logger.warn('No Twitter cookies found — public API only')
    }

    // Prefer the local extractor so a third-party resolver outage does not break downloads.
    const ytResult = await downloadWithYtDlp(url, findCookieFile())
    if (ytResult) {
      return { success: true, text: '🐦 Twitter media berhasil didownload!', ...ytResult }
    }

    // Try public Twitter/X downloader API as a fallback.
    try {
      const apiUrl = `https://api.egojs.com/api/download/twitter?url=${encodeURIComponent(url)}`
      const response = await fetch(apiUrl, { headers: publicHeaders, signal: AbortSignal.timeout(20_000) })
      if (!response.ok) throw new Error(`Twitter resolver HTTP ${response.status}`)
      const data = await response.json() as any

      if (data?.result?.media?.[0]) {
        const media = data.result.media[0]
        const mediaUrl = media.url || media.download_url

        if (mediaUrl) {
          const mediaResp = await fetch(mediaUrl, { headers: publicHeaders, signal: AbortSignal.timeout(30_000) })
          if (!mediaResp.ok) throw new Error(`Twitter media HTTP ${mediaResp.status}`)
          const buffer = Buffer.from(await mediaResp.arrayBuffer())
          if (buffer.length > MAX_MEDIA_BYTES) throw new Error('Media Twitter terlalu besar (maksimal 50 MB)')
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
    } catch (resolverErr) {
      logger.warn({ error: resolverErr instanceof Error ? resolverErr.message : String(resolverErr) },
        'Twitter public resolver unavailable; trying page metadata')
    }

    // Fallback: try direct page metadata fetch when cookies are available
    if (cookies) {
      try {
        const tweetId = extractTweetId(url)
        if (tweetId) {
          const twResp = await fetch(`https://x.com/i/status/${tweetId}`, {
            headers: {
              ...xHeaders,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Referer': 'https://x.com/',
            }
          })
          const html = await twResp.text()
          const mediaUrl = extractMediaUrl(html)
          if (mediaUrl) {
            const mediaResp = await fetch(mediaUrl, { headers: publicHeaders })
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
      } catch (scrapeErr) {
        logger.warn({ scrapeErr }, 'Direct Twitter page scrape failed')
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

function extractMediaUrl(html: string): string | null {
  const metaMatch = html.match(/<meta[^>]+property=["']og:video:url["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
  return metaMatch?.[1] || null
}

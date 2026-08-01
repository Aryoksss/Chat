// ============================================================
// Tool: Instagram Downloader (with cookies support)
// ============================================================

import { readFile } from 'fs/promises'
import { logger } from '../../system/logger.js'
import { config } from '../../system/config.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'

interface IgArgs {
  url: string
}

/** Load cookies from file for authenticated requests */
async function loadCookies(): Promise<string | null> {
  const cookieFiles = ['instagram.txt', 'instagram-cookies.txt']
  for (const fileName of cookieFiles) {
    const cookieFile = join(config.COOKIES_DIR || 'data/cookies', fileName)
    if (!existsSync(cookieFile)) continue
    try {
      const text = await readFile(cookieFile, 'utf-8')
      // Strip comments and blank lines, keep only valid cookie lines
      const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('//'))
      // Parse Netscape format: domain TRUE path secure expiry name value
      const cookieStr = lines.map(l => {
        const parts = l.trim().split('\t')
        if (parts.length >= 7) {
          return `${parts[5]}=${parts[6]}`
        }
        return null
      }).filter(Boolean).join('; ')
      if (cookieStr) return cookieStr
    } catch {
      continue
    }
  }
  return null
}

export async function handleIgDownload(args: IgArgs): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image' | 'video' | 'sticker' | 'audio' | 'document'; caption?: string; error?: string }> {
  const { url } = args

  if (!url || !url.includes('instagram.com')) {
    return { success: false, text: 'Kasih link Instagram yang valid kak!' }
  }

  try {
    // Public downloader API must never receive the user's Instagram session cookie.
    const publicHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    }
    const cookies = await loadCookies()
    const instagramHeaders: Record<string, string> = { ...publicHeaders }
    if (cookies) {
      instagramHeaders['Cookie'] = cookies
      logger.info('Using Instagram cookies from file')
    } else {
      logger.warn('No Instagram cookies found — public API only')
    }

    // Try the public downloader first, but keep scraping available when the
    // provider is unavailable (for example, DNS failure or rate limiting).
    let data: any = null
    try {
      const apiUrl = `https://api.egojs.com/api/download/instagram?url=${encodeURIComponent(url)}`
      const response = await fetch(apiUrl, {
        headers: publicHeaders,
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`public API HTTP ${response.status}`)
      data = await response.json() as any
    } catch (publicErr) {
      logger.warn({ err: publicErr }, 'Public Instagram downloader unavailable — trying direct scrape')
    }

    if (data?.result?.media?.[0]) {
      const media = data.result.media[0]
      const mediaUrl = media.url || media.download_url

      if (mediaUrl) {
        if (!isAllowedInstagramMediaUrl(mediaUrl)) {
          throw new Error('Media URL Instagram tidak dipercaya')
        }
        const mediaResp = await fetch(mediaUrl, {
          headers: publicHeaders,
          signal: AbortSignal.timeout(30000),
        })
        if (!mediaResp.ok) throw new Error(`Instagram media HTTP ${mediaResp.status}`)
        const buffer = Buffer.from(await mediaResp.arrayBuffer())
        const ext = mediaUrl.includes('.mp4') ? 'mp4' : 'jpg'
        const outPath = join(tmpdir(), `ig_${Date.now()}.${ext}`)
        const { writeFile } = await import('fs/promises')
        await writeFile(outPath, buffer)

        return {
          success: true,
          text: '📸 Instagram media berhasil didownload!',
          filePath: outPath,
          fileType: ext === 'mp4' ? 'video' : 'image',
          caption: data.result.caption?.slice(0, 200) || '',
        }
      }
    }

    // Fallback: try direct scraping with cookies
    if (cookies) {
      try {
        const igResp = await fetch(`https://www.instagram.com/p/${extractCode(url)}/?__a=1&__d=1`, {
          headers: {
            ...instagramHeaders,
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          },
          signal: AbortSignal.timeout(15000),
        })
        if (!igResp.ok) throw new Error(`Instagram page HTTP ${igResp.status}`)
        const body = await igResp.text()
        let mediaUrl: string | null = null
        let isVideo = false

        try {
          const igData = JSON.parse(body) as any
          const items = igData?.items?.[0] || igData?.graphql?.shortcode_media
          mediaUrl = items?.video_versions?.[0]?.url || items?.display_url || null
          isVideo = Boolean(items?.video_versions?.length)
        } catch {
          // Instagram frequently returns the normal HTML page instead of JSON.
          mediaUrl = extractInstagramMeta(body, ['og:video', 'og:video:url', 'twitter:player:stream'])
          isVideo = Boolean(mediaUrl)
          if (!mediaUrl) mediaUrl = extractInstagramMeta(body, ['og:image', 'twitter:image'])
        }

        if (mediaUrl) {
          if (!isAllowedInstagramMediaUrl(mediaUrl)) {
            throw new Error('Media URL Instagram tidak dipercaya')
          }
          const mediaResp = await fetch(mediaUrl, {
            headers: publicHeaders,
            signal: AbortSignal.timeout(30000),
          })
          if (!mediaResp.ok) throw new Error(`Instagram media HTTP ${mediaResp.status}`)
          const buffer = Buffer.from(await mediaResp.arrayBuffer())
          const ext = isVideo ? 'mp4' : 'jpg'
          const outPath = join(tmpdir(), `ig_${Date.now()}.${ext}`)
          const { writeFile } = await import('fs/promises')
          await writeFile(outPath, buffer)
          return {
            success: true,
            text: '📸 Instagram media berhasil didownload!',
            filePath: outPath,
            fileType: ext === 'mp4' ? 'video' : 'image',
          }
        }
      } catch (scrapeErr) {
        logger.warn({ error: scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr) }, 'Direct IG scrape failed')
      }
    }

    return { success: false, text: 'Gagal dapetin media dari link itu. Mungkin link-nya private, udah dihapus, atau cookies-nya expired.' }
  } catch (err: any) {
    logger.error({ err }, 'ig-dl failed')
    return { success: false, error: `Gagal download Instagram: ${err.message}` }
  }
}

/** Extract shortcode from Instagram URL */
function extractCode(url: string): string {
  const match = url.match(/(?:p|reel|tv)\/([^/?]+)/)
  return match?.[1] || ''
}

function extractInstagramMeta(html: string, names: string[]): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const raw = tag[0]
    const key = raw.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase()
    if (!key || !names.includes(key)) continue
    const content = raw.match(/content=["']([^"']+)["']/i)?.[1]
    if (!content) continue
    return content
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/gi, '/')
      .replace(/&#39;/g, "'")
  }
  return null
}

function isAllowedInstagramMediaUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'instagram.com' ||
      hostname.endsWith('.instagram.com') ||
      hostname === 'cdninstagram.com' ||
      hostname.endsWith('.cdninstagram.com') ||
      hostname === 'fbcdn.net' ||
      hostname.endsWith('.fbcdn.net')
  } catch {
    return false
  }
}

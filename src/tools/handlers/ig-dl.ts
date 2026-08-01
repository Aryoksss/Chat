// ============================================================
// Tool: Instagram Downloader (with cookies support)
// ============================================================

import { readFile, readdir, stat, unlink } from 'fs/promises'
import { logger } from '../../system/logger.js'
import { config } from '../../system/config.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'

interface IgArgs {
  url: string
}

const execFileP = promisify(execFile)
const MAX_GALLERY_ITEMS = 10
const MAX_MEDIA_BYTES = 50 * 1024 * 1024

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

function findCookieFile(): string | null {
  for (const fileName of ['instagram.txt', 'instagram-cookies.txt']) {
    const cookieFile = join(config.COOKIES_DIR || 'data/cookies', fileName)
    if (existsSync(cookieFile)) return cookieFile
  }
  return null
}

async function downloadWithGalleryDl(url: string, cookieFile: string): Promise<{
  filePath?: string
  filePaths?: string[]
  fileType: 'image' | 'video'
} | null> {
  const downloaded: string[] = []
  try {
    const { stdout } = await execFileP('gallery-dl', [
      '--get-urls', '--cookies', cookieFile, '--quiet', '--no-mtime', url,
    ], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 })

    const mediaUrls = stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^https?:\/\//i.test(line) && isAllowedInstagramMediaUrl(line))
      .slice(0, MAX_GALLERY_ITEMS)
    if (mediaUrls.length === 0) return null

    let hasVideo = false
    for (const [index, mediaUrl] of mediaUrls.entries()) {
      const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`gallery media HTTP ${response.status}`)
      const contentLength = Number(response.headers.get('content-length') || 0)
      if (contentLength > MAX_MEDIA_BYTES) throw new Error('Media Instagram terlalu besar')
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > MAX_MEDIA_BYTES) throw new Error('Media Instagram terlalu besar')

      const contentType = response.headers.get('content-type') || ''
      const isVideo = contentType.includes('video') || /\.(?:mp4|mov)(?:[?#]|$)/i.test(mediaUrl)
      hasVideo ||= isVideo
      const extension = isVideo ? 'mp4' : 'jpg'
      const outPath = join(tmpdir(), `ig_gallery_${Date.now()}_${index}.${extension}`)
      const { writeFile } = await import('fs/promises')
      await writeFile(outPath, buffer)
      downloaded.push(outPath)
    }

    return downloaded.length === 1
      ? { filePath: downloaded[0], fileType: hasVideo ? 'video' : 'image' }
      : { filePaths: downloaded, fileType: hasVideo ? 'video' : 'image' }
  } catch (err) {
    const { unlink } = await import('fs/promises')
    await Promise.all(downloaded.map(filePath => unlink(filePath).catch(() => {})))
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'gallery-dl Instagram fallback failed')
    return null
  }
}

/** Download Instagram Reels through the official yt-dlp Instagram extractor. */
async function downloadReelWithYtDlp(url: string, cookieFile: string | null): Promise<{
  filePath: string
  fileType: 'video'
} | null> {
  const outputPrefix = join(tmpdir(), `ig_reel_${Date.now()}_${process.pid}`)
  const outputTemplate = `${outputPrefix}.%(ext)s`
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--restrict-filenames',
    '--max-filesize', `${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)}M`,
    '--format', 'best[ext=mp4]/best',
    '--output', outputTemplate,
  ]
  if (cookieFile) args.push('--cookies', cookieFile)
  args.push(url)

  try {
    const result = await execFileP('yt-dlp', args, {
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const prefix = outputPrefix.split('/').pop() || ''
    const files = (await readdir(tmpdir()))
      .filter(name => name.startsWith(`${prefix}.`) && !name.endsWith('.part'))
      .map(name => join(tmpdir(), name))

    const filePath = files.find(file => file.toLowerCase().endsWith('.mp4')) || files[0]
    if (!filePath) {
      throw new Error(`yt-dlp tidak menghasilkan file${result.stderr ? `: ${result.stderr.trim()}` : ''}`)
    }

    const fileInfo = await stat(filePath)
    if (fileInfo.size > MAX_MEDIA_BYTES) {
      throw new Error('Media Reel terlalu besar')
    }

    logger.info({ filePath, bytes: fileInfo.size }, 'Instagram Reel downloaded with yt-dlp')
    return { filePath, fileType: 'video' }
  } catch (err) {
    const prefix = outputPrefix.split('/').pop() || ''
    const files = await readdir(tmpdir())
      .then(names => names.filter(name => name.startsWith(`${prefix}.`)).map(name => join(tmpdir(), name)))
      .catch(() => [])
    await Promise.all(files.map(file => unlink(file).catch(() => {})))
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'yt-dlp Instagram Reel download failed')
    return null
  }
}

export async function handleIgDownload(args: IgArgs): Promise<{ success: boolean; text?: string; filePath?: string; filePaths?: string[]; fileType?: 'image' | 'video' | 'sticker' | 'audio' | 'document'; caption?: string; error?: string }> {
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
    const cookieFile = findCookieFile()
    const instagramHeaders: Record<string, string> = { ...publicHeaders }
    if (cookies) {
      instagramHeaders['Cookie'] = cookies
      logger.info('Using Instagram cookies from file')
    } else {
      logger.warn('No Instagram cookies found — public API only')
    }

    // Reels are handled by yt-dlp, whose Instagram extractor explicitly
    // supports /reel/ and /reels/ URLs. Keep the older Instagram fallbacks
    // below available if yt-dlp is unavailable or the post cannot be read.
    if (isInstagramReelUrl(url)) {
      const reel = await downloadReelWithYtDlp(url, cookieFile)
      if (reel) {
        return {
          success: true,
          text: '📸 Instagram Reel berhasil didownload!',
          ...reel,
        }
      }
    }

    // gallery-dl handles Instagram's current authenticated API flow more
    // reliably than the public downloader and legacy HTML endpoint.
    if (cookieFile) {
      const gallery = await downloadWithGalleryDl(url, cookieFile)
      if (gallery) {
        return {
          success: true,
          text: '📸 Instagram media berhasil didownload!',
          ...gallery,
        }
      }
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

function isInstagramReelUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    if (hostname !== 'instagram.com' && !hostname.endsWith('.instagram.com')) return false
    return /\/reels?(?!\/audio\/)\/[^/?#]+/i.test(parsed.pathname)
  } catch {
    return false
  }
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

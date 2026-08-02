// ============================================================
// Tool: Threads Downloader
// ============================================================

import { readdir, stat, unlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../../system/logger.js'

interface ThreadsArgs {
  url: string
}

const execFileP = promisify(execFile)
const MAX_MEDIA_BYTES = 50 * 1024 * 1024
const PUBLIC_THREADS_RESOLVER = 'https://threadsdownloads.com/api/info'

const PUBLIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
}

/** Accept only public Threads post URLs, never arbitrary yt-dlp URLs. */
export function isThreadsUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    const hostname = parsed.hostname.toLowerCase()
    return parsed.protocol === 'https:' && (
      hostname === 'threads.com' || hostname.endsWith('.threads.com') ||
      hostname === 'threads.net' || hostname.endsWith('.threads.net')
    )
  } catch {
    return false
  }
}

export function extractThreadsMeta(html: string, property: string): string | null {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`<meta[^>]*?(?:property|name)=["']${escaped}["'][^>]*?content=["']([^"']+)["']`, 'i'))
    || html.match(new RegExp(`<meta[^>]*?content=["']([^"']+)["'][^>]*?(?:property|name)=["']${escaped}["']`, 'i'))
  return match?.[1]?.replace(/&amp;/g, '&').replace(/&#x27;/gi, "'").replace(/&quot;/g, '"') || null
}

function isAllowedMediaUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'cdninstagram.com' || hostname.endsWith('.cdninstagram.com') ||
      hostname === 'fbcdn.net' || hostname.endsWith('.fbcdn.net') ||
      hostname === 'threads.com' || hostname.endsWith('.threads.com')
  } catch {
    return false
  }
}

async function downloadMediaUrl(mediaUrl: string, preferredType?: 'video' | 'image'): Promise<{
  filePath: string
  fileType: 'video' | 'image'
}> {
  if (!isAllowedMediaUrl(mediaUrl)) throw new Error('URL media Threads tidak diizinkan')

  const mediaResponse = await fetch(mediaUrl, { headers: PUBLIC_HEADERS, signal: AbortSignal.timeout(30_000) })
  if (!mediaResponse.ok) throw new Error(`Threads media HTTP ${mediaResponse.status}`)
  const contentType = mediaResponse.headers.get('content-type') || ''
  const isVideo = preferredType === 'video' || contentType.includes('video') ||
    /.(?:mp4|webm|mov)(?:[?#]|$)/i.test(mediaUrl)
  const buffer = Buffer.from(await mediaResponse.arrayBuffer())
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error('Media Threads terlalu besar (maksimal 50 MB)')

  const extension = isVideo ? 'mp4' : 'jpg'
  const filePath = join(tmpdir(), `threads_${Date.now()}.${extension}`)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(filePath, buffer)
  return { filePath, fileType: isVideo ? 'video' : 'image' }
}

/**
 * The public Threads HTML sometimes exposes only the video cover as og:image.
 * Resolve the post first so a video is downloaded from its MP4 URL instead of
 * accidentally sending that cover image.
 */
async function downloadFromPublicResolver(url: string): Promise<{
  filePath: string
  fileType: 'video' | 'image'
} | null> {
  const response = await fetch(PUBLIC_THREADS_RESOLVER, {
    method: 'POST',
    headers: { ...PUBLIC_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Threads resolver HTTP ${response.status}`)

  const payload = await response.json() as {
    success?: boolean
    type?: string
    media?: Array<{ type?: string; url?: string }>
  }
  if (payload.success === false || !Array.isArray(payload.media)) return null

  const media = payload.media.find(item => typeof item.url === 'string' &&
    (item.type === 'video' || payload.type === 'video')) ||
    payload.media.find(item => typeof item.url === 'string')
  if (!media?.url) return null

  return downloadMediaUrl(media.url, media.type === 'video' || payload.type === 'video' ? 'video' : 'image')
}

async function downloadFromPageMetadata(url: string): Promise<{
  filePath: string
  fileType: 'video' | 'image'
} | null> {
  const response = await fetch(url, { headers: PUBLIC_HEADERS, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Threads page HTTP ${response.status}`)
  let html = await response.text()
  let mediaUrl = extractThreadsMeta(html, 'og:video') || extractThreadsMeta(html, 'og:video:url') ||
    extractThreadsMeta(html, 'twitter:player:stream') || extractThreadsMeta(html, 'og:image') || extractThreadsMeta(html, 'twitter:image')
  // Some Threads edge responses return only the shell to Node's fetch. curl
  // receives the server-rendered public card, which contains the media meta.
  if (!mediaUrl) {
    try {
      const curl = await execFileP('curl', [
        '-L', '--fail', '--silent', '--show-error',
        // Threads serves a client shell to Chrome-like UAs; a generic bot UA
        // returns the server-rendered public card with og:image/og:video.
        '-A', 'Mozilla/5.0',
        url,
      ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
      html = curl.stdout
      mediaUrl = extractThreadsMeta(html, 'og:video') || extractThreadsMeta(html, 'og:video:url') ||
        extractThreadsMeta(html, 'twitter:player:stream') || extractThreadsMeta(html, 'og:image') || extractThreadsMeta(html, 'twitter:image')
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Threads curl metadata fallback failed')
    }
  }
  if (!mediaUrl || !isAllowedMediaUrl(mediaUrl)) return null

  return downloadMediaUrl(mediaUrl)
}

export async function handleThreadsDownload(args: ThreadsArgs): Promise<{
  success: boolean
  text?: string
  filePath?: string
  fileType?: 'video' | 'image' | 'document'
  caption?: string
  error?: string
}> {
  const { url } = args
  if (!url || !isThreadsUrl(url)) {
    return { success: false, text: 'Kasih link Threads yang valid kak!' }
  }

  const outputPrefix = join(tmpdir(), `threads_${Date.now()}_${process.pid}`)
  const outputTemplate = `${outputPrefix}.%(ext)s`
  const ytDlpArgs = [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '--restrict-filenames',
    '--max-filesize', `${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)}M`,
    '--format', 'best[ext=mp4]/best',
    '--output', outputTemplate,
    url,
  ]

  try {
    let result: { filePath: string; fileType: 'video' | 'image' } | null = null
    try {
      await execFileP('yt-dlp', ytDlpArgs, { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
      const prefix = outputPrefix.split('/').pop() || ''
      const files = (await readdir(tmpdir()))
        .filter(name => name.startsWith(`${prefix}.`) && !name.endsWith('.part'))
        .map(name => join(tmpdir(), name))
      const filePath = files[0]
      if (filePath) {
        const fileInfo = await stat(filePath)
        if (fileInfo.size > MAX_MEDIA_BYTES) throw new Error('Media Threads terlalu besar (maksimal 50 MB)')
        result = { filePath, fileType: /\.(?:mp4|webm|mkv|mov)$/i.test(filePath) ? 'video' : 'image' }
      }
    } catch (ytErr) {
      logger.warn({ error: ytErr instanceof Error ? ytErr.message : String(ytErr) }, 'yt-dlp Threads extractor unavailable; trying page metadata')
    }

    try {
      result ||= await downloadFromPublicResolver(url)
    } catch (resolverErr) {
      logger.warn({ error: resolverErr instanceof Error ? resolverErr.message : String(resolverErr) },
        'Public Threads resolver unavailable; trying page metadata')
    }
    result ||= await downloadFromPageMetadata(url)
    if (!result) throw new Error('Media tidak ditemukan. Post mungkin private atau formatnya belum didukung')

    const { filePath, fileType } = result
    logger.info({ filePath }, 'Threads media downloaded')
    return {
      success: true,
      filePath,
      fileType,
    }
  } catch (err: any) {
    const prefix = outputPrefix.split('/').pop() || ''
    const files = await readdir(tmpdir())
      .then(names => names.filter(name => name.startsWith(`${prefix}.`)).map(name => join(tmpdir(), name)))
      .catch(() => [])
    await Promise.all(files.map(file => unlink(file).catch(() => {})))
    logger.error({ err, url }, 'threads-dl failed')
    const detail = err?.message ? `: ${err.message}` : ''
    return { success: false, error: `Gagal download Threads${detail}` }
  }
}

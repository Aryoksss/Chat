// ============================================================
// Tool: Pinterest Search — Pinterest-only media search
// ============================================================

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logger } from '../../system/logger.js'

interface PinterestSearchArgs {
  query: string
  maxResults?: number
}

interface PinterestResult {
  id?: string
  title?: string
  description?: string
  images?: Record<string, { url?: string }>
  videos?: Record<string, { url?: string }>
}

interface PinterestMediaHit {
  mediaUrl: string
  pageUrl: string
  title: string
  mediaType?: 'image' | 'video'
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_VIDEO_BYTES = 30 * 1024 * 1024

export function isPinterestMediaUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return hostname === 'pinimg.com' || hostname.endsWith('.pinimg.com')
  } catch {
    return false
  }
}

export function pinterestSearchUrl(query: string, pageSize = 10): string {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`
  const data = encodeURIComponent(JSON.stringify({
    options: { query, scope: 'pins', bookmarks: [], page_size: pageSize },
    context: {},
  }))
  return `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(sourceUrl)}&data=${data}`
}

function firstMediaUrl(result: PinterestResult): { url: string; mediaType: 'image' | 'video' } | null {
  const videoUrls = Object.values(result.videos || {}).map(item => item?.url).filter((url): url is string => Boolean(url))
  const videoUrl = videoUrls.find(isPinterestMediaUrl)
  if (videoUrl) return { url: videoUrl, mediaType: 'video' }

  const imageCandidates = ['orig', '736x', '474x', '236x']
    .map(key => result.images?.[key]?.url)
    .filter((url): url is string => Boolean(url))
  const imageUrl = imageCandidates.find(isPinterestMediaUrl)
  return imageUrl ? { url: imageUrl, mediaType: 'image' } : null
}

export function extractPinterestMedia(results: PinterestResult[]): PinterestMediaHit[] {
  const hits: PinterestMediaHit[] = []
  for (const result of results) {
    const media = firstMediaUrl(result)
    if (!media || !result.id || hits.some(hit => hit.mediaUrl === media.url)) continue
    hits.push({
      mediaUrl: media.url,
      mediaType: media.mediaType,
      pageUrl: `https://www.pinterest.com/pin/${result.id}/`,
      title: (result.title || result.description || 'Pinterest Pin').replace(/\s+/g, ' ').trim(),
    })
  }
  return hits
}

async function searchPinterest(query: string, pageSize: number): Promise<PinterestMediaHit[]> {
  const response = await fetch(pinterestSearchUrl(query, pageSize), {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      'X-Pinterest-PWS-Handler': 'www/search/[scope]/',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Pinterest search HTTP ${response.status}`)
  const payload = await response.json() as { resource_response?: { data?: { results?: PinterestResult[] } } }
  return extractPinterestMedia(payload.resource_response?.data?.results || [])
}

async function downloadPinterestMedia(hit: PinterestMediaHit, index: number): Promise<{ filePath: string; fileType: 'image' | 'video' } | null> {
  try {
    if (!isPinterestMediaUrl(hit.mediaUrl)) return null
    const response = await fetch(hit.mediaUrl, {
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://www.pinterest.com/' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return null
    const contentType = (response.headers.get('content-type') || '').split(';')[0].toLowerCase()
    const isVideo = contentType.startsWith('video/') || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(hit.mediaUrl)
    if (!isVideo && !contentType.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES
    if (!buffer.length || buffer.length > maxBytes) return null
    const extension = isVideo ? 'mp4' : contentType.includes('gif') ? 'gif' : contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg'
    const filePath = join(tmpdir(), `pinterest_${Date.now()}_${index}.${extension}`)
    await writeFile(filePath, buffer)
    return { filePath, fileType: isVideo ? 'video' : 'image' }
  } catch (err) {
    logger.debug({ error: err instanceof Error ? err.message : String(err), url: hit.mediaUrl }, 'Pinterest media download skipped')
    return null
  }
}

export async function handlePinterestSearch(args: PinterestSearchArgs): Promise<{
  success: boolean
  text?: string
  filePaths?: string[]
  fileType?: 'image' | 'video'
  fileTypes?: Array<'image' | 'video'>
  sendAsCarousel?: boolean
  albumCaptions?: string[]
  error?: string
}> {
  const query = args.query?.trim()
  if (!query) return { success: false, text: 'Mau cari foto Pinterest apa? Kasih kata kuncinya dulu ya!' }
  const maxResults = Math.min(Math.max(args.maxResults || 4, 1), 4)

  try {
    const hits = await searchPinterest(query, Math.max(maxResults * 3, 8))
    const filePaths: string[] = []
    const fileTypes: Array<'image' | 'video'> = []
    const captions: string[] = []
    for (const [index, hit] of hits.entries()) {
      const media = await downloadPinterestMedia(hit, index)
      if (!media) continue
      filePaths.push(media.filePath)
      fileTypes.push(media.fileType)
      captions.push(`${hit.title.slice(0, 100)}\n${hit.pageUrl}`)
      if (filePaths.length >= maxResults) break
    }

    if (filePaths.length === 0) {
      return { success: false, text: `Belum menemukan foto Pinterest untuk "${query}". Coba kata kunci lain ya.` }
    }
    return {
      success: true,
      text: `📌 Ini hasil Pinterest untuk "${query}".`,
      filePaths,
      fileType: fileTypes[0],
      fileTypes,
      sendAsCarousel: filePaths.length >= 2,
      albumCaptions: captions,
    }
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Pinterest search failed')
    return { success: false, text: `Pencarian Pinterest sedang gagal untuk "${query}". Coba lagi sebentar ya.` }
  }
}

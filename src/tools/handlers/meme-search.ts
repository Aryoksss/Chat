// ============================================================
// Tool: Meme/Image Search — fetch real images and send as a Baileys album
// ============================================================

import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../../system/logger.js'

interface MemeSearchArgs { query: string; maxResults?: number }
interface ImageHit { title: string; imageUrl: string; pageUrl: string; description: string }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36'
const MAX_BYTES = 8 * 1024 * 1024
const execFileP = promisify(execFile)

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
}

function cleanTenorUrl(value: string): string {
  return decodeHtml(value)
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .split(/\s+/)[0]
}

function extractHits(html: string): ImageHit[] {
  const hits: ImageHit[] = []
  const pattern = /class=["']iusc["'][^>]*\bm=["']([^"']+)["']/gi
  for (const match of html.matchAll(pattern)) {
    try {
      const meta = JSON.parse(decodeHtml(match[1])) as { murl?: string; purl?: string; t?: string; desc?: string }
      if (!meta.murl || !/^https?:\/\//i.test(meta.murl)) continue
      if (!hits.some(hit => hit.imageUrl === meta.murl)) {
        hits.push({ title: meta.t || 'Meme', imageUrl: meta.murl, pageUrl: meta.purl || meta.murl, description: meta.desc || '' })
      }
    } catch { /* skip malformed Bing image metadata */ }
    if (hits.length >= 16) break
  }
  return hits
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsTerm(text: string, term: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:$|[^a-z0-9])`, 'i').test(text)
}

function relevantHits(hits: ImageHit[], query: string): ImageHit[] {
  const translations: Record<string, string[]> = {
    anak: ['anak', 'child', 'kid'], kecil: ['kecil', 'little', 'small'],
    kucing: ['kucing', 'cat'], anjing: ['anjing', 'dog'], lucu: ['lucu', 'funny', 'cute'],
  }
  const stopWords = new Set(['cari', 'cariin', 'carikan', 'meme', 'gambar', 'foto', 'teks', 'dengan', 'tentang', 'untuk', 'yang', 'lagi', 'sedang', 'trend', 'trending'])
  const rawWords: string[] = query.toLowerCase().match(/[a-z0-9À-ÿ]+/gi) || []
  const words = rawWords.filter(token => token.length >= 3 && !stopWords.has(token))
  const groups = words.map(word => [...new Set([word, ...(translations[word] || [])])])
  const textIndex = rawWords.indexOf('teks')
  const requiredWords = textIndex >= 0
    ? rawWords.slice(textIndex + 1).filter(token => token.length >= 3 && !stopWords.has(token))
    : []
  const requiredGroups = groups.filter(group => requiredWords.some(word => group.includes(word)))
  const memeSource = /giphy|tenor|imgur|reddit|9gag|memedroid|knowyourmeme|meme/i
  return hits
    .map(hit => {
      const haystack = `${hit.title} ${hit.description} ${hit.pageUrl}`.toLowerCase()
      const matchedGroups = groups.filter(group => group.some(term => containsTerm(haystack, term))).length
      const requiredMatched = requiredGroups.every(group => group.some(term => containsTerm(haystack, term)))
      const sourceScore = memeSource.test(haystack) ? 2 : 0
      return { hit, score: matchedGroups * 10 + sourceScore, matchedGroups, requiredMatched, sourceScore }
    })
    .filter(item => {
      const minimumGroups = requiredGroups.length > 0 ? 1 : groups.length >= 2 ? 2 : 1
      return !/pinterest\.com|pinimg\.com/i.test(item.hit.pageUrl)
        && item.requiredMatched
        && item.matchedGroups >= minimumGroups
        && (item.sourceScore > 0 || /meme|gif|reaction|template/i.test(`${item.hit.title} ${item.hit.description} ${item.hit.pageUrl}`))
    })
    .sort((a, b) => b.score - a.score)
    .map(item => item.hit)
}

async function searchImages(query: string): Promise<ImageHit[]> {
  const searchQuery = `${query} meme template reaction image GIF`
  const response = await fetch(`https://www.bing.com/images/search?q=${encodeURIComponent(searchQuery)}&form=HDRSC2&first=1`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Image search HTTP ${response.status}`)
  return extractHits(await response.text())
}

async function searchTenor(query: string): Promise<ImageHit[]> {
  const slug = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!slug) return []
  const pageUrl = `https://tenor.com/search/${slug}-gifs`
  const response = await fetch(pageUrl, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) return []
  const html = await response.text()
  const hits: ImageHit[] = []
  const figurePattern = /<figure class=["'][^"']*UniversalGifListItem[^"']*["'][\s\S]*?<\/figure>/gi
  for (const match of html.matchAll(figurePattern)) {
    const figure = match[0]
    const viewPath = figure.match(/<a href=["'](\/view\/[^"']+)["']/i)?.[1]
    const videoUrl = figure.match(/<source[^>]+type=["']video\/mp4["'][^>]+srcset=["']([^"']+)/i)?.[1]
      || figure.match(/<source[^>]+srcset=["']([^"']+)["'][^>]+type=["']video\/mp4["']/i)?.[1]
    const imageUrl = figure.match(/<img[^>]+src=["'](https?:\/\/(?:media1|media)\.tenor\.com\/[^"']+)["']/i)?.[1]
    const mediaUrl = cleanTenorUrl(videoUrl || imageUrl || '')
    if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) continue

    const alt = figure.match(/<img[^>]+alt=["']([^"']*)["']/i)?.[1]
    const tags = [...figure.matchAll(/<figcaption[\s\S]*?<a[^>]*>([^<]+)<\/a>/gi)]
      .map(tag => decodeHtml(tag[1]).trim())
      .filter(Boolean)
    const title = decodeHtml(alt || tags.join(' ') || `Tenor GIF: ${query}`).trim()
    const resolvedPageUrl = viewPath ? `https://tenor.com${cleanTenorUrl(viewPath)}` : pageUrl
    hits.push({
      title,
      imageUrl: mediaUrl,
      pageUrl: resolvedPageUrl,
      description: `${title} ${tags.join(' ')}`,
    })
    if (hits.length >= 24) break
  }
  return hits
}

function queryVariants(query: string): string[] {
  const translations: Record<string, string> = {
    anak: 'child kid', kecil: 'little kid', teks: 'text', lucu: 'funny',
    kucing: 'cat', anjing: 'dog', bapak: 'dad', ayah: 'father', ibu: 'mom mother',
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const intentWords = new Set(['cari', 'cariin', 'carikan', 'gambar', 'foto', 'meme', 'gif', 'reaction', 'dengan', 'teks', 'tentang', 'untuk', 'yang', 'lagi', 'sedang'])
  const keywords = words.filter(word => word.length >= 3 && !intentWords.has(word))
  const translated = keywords.map(word => translations[word] || word).join(' ')
  const core = keywords.join(' ')
  const variants = [query, `${core} meme`, `${translated} meme`]
  if (keywords.length > 0) variants.push(`${keywords.at(-1)} meme`)
  return [...new Set(variants)].slice(0, 4)
}

async function convertGifToVideo(gifPath: string, index: number): Promise<string | null> {
  const videoPath = join(tmpdir(), `meme_${Date.now()}_${index}.mp4`)
  try {
    await execFileP('ffmpeg', [
      '-y', '-i', gifPath,
      '-t', '8',
      '-vf', 'scale=720:-2:flags=lanczos',
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-preset', 'veryfast', '-crf', '28',
      videoPath,
    ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })
    return videoPath
  } catch (err) {
    logger.debug({ error: err instanceof Error ? err.message : String(err), gifPath }, 'Meme GIF conversion skipped')
    await unlink(videoPath).catch(() => {})
    return null
  } finally {
    await unlink(gifPath).catch(() => {})
  }
}

async function downloadHit(hit: ImageHit, index: number): Promise<{ filePath: string; fileType: 'image' | 'video'; isAnimated?: boolean } | null> {
  try {
    const response = await fetch(hit.imageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return null
    const contentType = response.headers.get('content-type') || ''
    const isVideo = contentType.startsWith('video/') || /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(hit.imageUrl)
    if (!isVideo && !contentType.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length || buffer.length > MAX_BYTES) return null
    const ext = isVideo ? 'mp4' : contentType.includes('gif') ? 'gif' : contentType.includes('webp') ? 'webp' : contentType.includes('png') ? 'png' : 'jpg'
    const filePath = join(tmpdir(), `meme_${Date.now()}_${index}.${ext}`)
    await writeFile(filePath, buffer)
    if (isVideo) return { filePath, fileType: 'video', isAnimated: true }
    if (ext === 'gif') {
      const convertedPath = await convertGifToVideo(filePath, index)
      return convertedPath ? { filePath: convertedPath, fileType: 'video', isAnimated: true } : null
    }
    return { filePath, fileType: 'image' }
  } catch (err) {
    logger.debug({ error: err instanceof Error ? err.message : String(err), url: hit.imageUrl }, 'Meme image download skipped')
    return null
  }
}

export async function handleMemeSearch(args: MemeSearchArgs): Promise<{
  success: boolean
  text?: string
  filePaths?: string[]
  fileType?: 'image' | 'video'
  fileTypes?: Array<'image' | 'video'>
  fileAnimations?: boolean[]
  sendAsAlbum?: boolean
  sendAsCarousel?: boolean
  albumCaptions?: string[]
  error?: string
}> {
  const query = args.query?.trim()
  if (!query) return { success: false, text: 'Mau cari meme apa? Kasih kata kuncinya dulu ya!' }
  const maxResults = Math.min(Math.max(args.maxResults || 6, 2), 8)
  try {
    const rawHits: ImageHit[] = []
    for (const variant of queryVariants(query)) {
      rawHits.push(...await searchTenor(variant))
      rawHits.push(...await searchImages(variant))
      if (rawHits.length >= 64) break
    }
    const uniqueHits = rawHits.filter((hit, index, all) => all.findIndex(item => item.imageUrl === hit.imageUrl) === index)
    const hits = relevantHits(uniqueHits, query)
    const files: string[] = []
    const fileTypes: Array<'image' | 'video'> = []
    const fileAnimations: boolean[] = []
    const captions: string[] = []
    for (const [index, hit] of hits.entries()) {
      const media = await downloadHit(hit, index)
      if (!media) continue
      files.push(media.filePath)
      fileTypes.push(media.fileType)
      fileAnimations.push(media.isAnimated === true)
      captions.push(`${hit.title.slice(0, 80)}\n${hit.pageUrl}`)
      if (files.length >= maxResults) break
    }
    if (files.length < 2) return { success: false, text: `Belum nemu gambar meme yang bisa dikirim untuk "${query}". Coba kata kunci lain ya.` }
    return {
      success: true,
      text: `😂 Ini beberapa meme yang ketemu untuk "${query}".`,
      filePaths: files,
      fileType: fileTypes[0],
      fileTypes,
      fileAnimations,
      sendAsCarousel: true,
      albumCaptions: captions,
    }
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Meme image search failed')
    return { success: false, text: `Pencarian meme sedang gagal untuk "${query}". Coba lagi sebentar ya.` }
  }
}

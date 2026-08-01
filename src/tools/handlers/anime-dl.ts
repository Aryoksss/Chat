// ============================================================
// Tool: Anime Download — cari anime & tampilkan link download
// ============================================================
// Ported dari CosTeleBot/scrapers/kusonime.js ke bot WhatsApp.
// Scope (sesuai kebutuhan): CARI + KASIH LINK RESOLUSI DOWNLOAD per host.
// TIDAK mengunduh file besar ke chat — cukup menampilkan link host eksternal
// (Google Drive, Mediafire, Mega, Gofile, dll) + klasifikasi host.
//
// Pakai native fetch + regex parsing (tanpa cheerio/axios), konsisten dgn tool
// lain di bot ini. Domain bisa di-set via env KUSONIME_DOMAIN.

import { logger } from '../../system/logger.js'
import { config } from '../../system/config.js'

const BASE_URL = () => config.KUSONIME_DOMAIN || process.env.KUSONIME_DOMAIN || 'https://kusonime.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 20000

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.text()
  } catch (err: any) {
    logger.warn({ err: err.message, url }, 'anime fetch failed')
    return null
  }
}

/** Bersihkan teks dari entity HTML & spasi berlebih. */
function clean(s: string): string {
  return s
    .replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#?[a-z0-9]+;/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

type AnimeSearchResult = { title: string; url: string; poster: string; genres: string[]; source: string }
const searchByJid = new Map<string, { results: AnimeSearchResult[]; updatedAt: number }>()
const SEARCH_CONTEXT_TTL_MS = 15 * 60 * 1000
const DEFAULT_CONTEXT_KEY = '__default__'

function contextKey(context?: { jid?: string }): string {
  return context?.jid || DEFAULT_CONTEXT_KEY
}

function getResults(jid?: string): AnimeSearchResult[] {
  const key = jid || DEFAULT_CONTEXT_KEY
  const entry = searchByJid.get(key)
  if (!entry || Date.now() - entry.updatedAt > SEARCH_CONTEXT_TTL_MS) {
    searchByJid.delete(key)
    return []
  }
  return entry.results
}

export function getAnimeContext(jid?: string): string {
  const results = getResults(jid)
  if (!results.length) return ''
  const lines = results.slice(0, 10).map((p, i) => `${i + 1}. ${p.title}${p.source ? ` [${p.source}]` : ''} • ${p.url}`).join('\n')
  return `Berikut hasil pencarian ANIME terakhir yang sudah ditampilkan ke user:\n${lines}\n\nKalau user minta link download salah satu, panggil tool anime-links dengan index = nomor di daftar ini (tanpa isi url).`
}

export function clearAnimeResults(jid?: string): void {
  if (jid) searchByJid.delete(jid)
  else searchByJid.clear()
}

/** Cari anime di Kusonime. */
async function search(query: string): Promise<Array<{ title: string; url: string; poster: string; genres: string[]; source: string }>> {
  if (!query || !query.trim()) return []
  const html = await getText(`${BASE_URL()}/?s=${encodeURIComponent(query)}`)
  if (!html) return []

  const results: Array<{ title: string; url: string; poster: string; genres: string[]; source: string }> = []
  const seen = new Set<string>()
  const domain = BASE_URL().replace(/^https?:\/\//, '')

  // Kusonime search: <h2><a href="https://kusonime.com/<slug>/">Title</a></h2>
  const re = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/gi
  let m
  while ((m = re.exec(html))) {
    const href = m[1]
    const title = clean(m[2])
    if (!href || !title || title.length < 3) continue
    if (href.includes(`${domain}/`) === false && !href.includes('kusonime.com/')) continue
    if (href.match(/\/(genres|seasons|tag|page|credits|faq|dmca|wp-)/)) continue
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '')
    if (slug.includes('/')) continue

    const key = slug.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    results.push({ title, url: href, poster: '', genres: [], source: 'kusonime' })
    if (results.length >= 15) break
  }
  return results
}

/** Klasifikasi host download. */
function classifyHost(url: string, hostLabel = ''): string {
  const combined = `${url} ${hostLabel}`.toLowerCase()
  if (url.includes('drive.google.com')) return 'Google Drive'
  if (url.includes('gofile.io')) return 'Gofile'
  if (url.includes('terabox.com') || url.includes('1024terabox.com')) return 'Terabox'
  if (url.includes('acefile.co')) return 'Acefile'
  if (url.includes('krakenfiles.com')) return 'KrakenFiles'
  if (url.includes('akirabox.com')) return 'Akirabox'
  if (url.includes('hxfile.co')) return 'HxFile'
  if (url.includes('buzzheavier.com')) return 'Buzzheavier'
  if (url.includes('mega.nz') || url.includes('mega.co.nz')) return 'Mega'
  if (url.includes('mediafire.com')) return 'Mediafire'
  if (url.includes('zippyshare.com')) return 'Zippyshare'
  return combined.includes('kraken') ? 'KrakenFiles' : hostLabel || 'Other'
}

/** Detail anime + link download per resolusi. */
async function getDetail(pageUrl: string): Promise<{
  title: string
  description: string
  genres: string[]
  qualityLinks: Array<{ quality: string; links: Array<{ host: string; url: string }> }>
} | null> {
  const html = await getText(pageUrl)
  if (!html) return null

  const title = clean((html.match(/<h1[^>]*class="[^"]*jdlz[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '')
    || clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '')

  const descMatch = html.match(/<p[^>]*class="[^"]*lexot[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
  const description = clean(descMatch ? descMatch[1] : '')

  const genres: string[] = []
  const genreRe = /<a[^>]*href="[^"]*\/genres\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  let g
  while ((g = genreRe.exec(html))) {
    const t = clean(g[1])
    if (t && !genres.includes(t)) genres.push(t)
  }

  // Download links: <div class="smokeurlrh"><strong>QUALITY</strong> <a>host1</a> | <a>host2</a></div>
  const qualityLinks: Array<{ quality: string; links: Array<{ host: string; url: string }> }> = []
  const divRe = /<div[^>]*class="[^"]*smokeurlrh[^"]*"[^>]*>([\s\S]*?)<\/div>/gi
  let d
  while ((d = divRe.exec(html))) {
    const block = d[1]
    const quality = clean((block.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i) || [])[1] || 'Unknown')
    const links: Array<{ host: string; url: string }> = []
    const aRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let a
    while ((a = aRe.exec(block))) {
      const href = a[1]
      const host = clean(a[2])
      if (href && host && !href.startsWith('#')) links.push({ host, url: href })
    }
    if (links.length) qualityLinks.push({ quality, links })
  }

  return { title, description, genres, qualityLinks }
}

interface SearchArgs {
  query: string
}

/** Cari anime → daftar judul + link. */
export async function handleAnimeDlSearch(args: SearchArgs, context?: { jid?: string }): Promise<{ success: boolean; text?: string; error?: string }> {
  const query = args.query?.trim()
  if (!query) {
    return { success: false, text: 'Mau cari anime apa? Kasih judulnya kak!' }
  }

  const results = await search(query)
  if (!results.length) {
    return { success: false, text: `Gak nemu anime "${query}". Coba judul lain atau spelling yang bener kak!` }
  }

  searchByJid.set(contextKey(context), { results, updatedAt: Date.now() })

  const lines = results.map((r, i) => `${i + 1}. *${r.title}*\n   ${r.url}`).join('\n\n')
  return {
    success: true,
    text: `🎌 *Hasil Cari Anime: "${query}"*\n\n${lines}\n\nBalas dengan nomor (mis. "no 3") buat lihat link download-nya.`,
  }
}

interface LinksArgs {
  url?: string
  index?: number // nomor dari hasil anime-search terakhir (dipakai saat url kosong)
}

/** Buka detail anime → tampilkan link download per resolusi + host. */
export async function handleAnimeLinks(args: LinksArgs, context?: { jid?: string }): Promise<{ success: boolean; text?: string; error?: string }> {
  let url = args.url?.trim() || ''

  if (!url) {
    const idx = Math.max(1, args.index || 1)
    const chosen = getResults(context?.jid)[idx - 1]
    if (!chosen) {
      return { success: false, text: 'Belum ada hasil pencarian anime. Cari dulu dengan anime-search, atau kasih URL-nya langsung.' }
    }
    url = chosen.url
  }
  if (!/^https?:\/\//i.test(url)) url = `${BASE_URL()}${url.startsWith('/') ? url : '/' + url}`

  const detail = await getDetail(url)
  if (!detail || !detail.title) {
    return { success: false, text: 'Gagal ambil detail anime dari halaman itu. URL-nya bener? Coba lagi nanti kak!' }
  }

  const header = `🎌 *${detail.title}*`
  const meta = detail.genres.length ? `\n🏷 Genre: ${detail.genres.slice(0, 10).join(', ')}` : ''
  const desc = detail.description ? `\n📖 ${detail.description.slice(0, 200)}` : ''

  if (!detail.qualityLinks.length) {
    return {
      success: true,
      text: `${header}${meta}${desc}\n\n⚠️ Gak nemu link download di halaman ini. Mungkin judul berubah atau halaman khusus.`,
    }
  }

  const qualityText = detail.qualityLinks
    .map(q => {
      const hosts = q.links.map(l => `• *${classifyHost(l.url, l.host)}*: ${l.url}`).join('\n')
      return `📦 *${q.quality}*\n${hosts}`
    })
    .join('\n\n')

  return {
    success: true,
    text: `${header}${meta}${desc}\n\n${qualityText}\n\n🔗 Sumber link di atas. Mau download, buka link host-nya via browser kak!`,
  }
}

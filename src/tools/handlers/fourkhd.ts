// ============================================================
// Tool: 4KHD — cari & download galeri foto dari 4khd.com
// ============================================================
// Ported dari CosTeleBot/scrapers/fourkhd.js ke bot WhatsApp.
//   - 4khd.com = situs galeri foto (WordPress). Tidak ada link download
//     eksternal — foto disajikan langsung sebagai galeri.
//   - Listing/search : HTML page (?s=query, homepage) → parse <li.wp-block-post>.
//   - Detail (semua foto): halaman HTML awal cuma load ~20 foto (lazy-load JS).
//     Ambil postId dari referensi `wp-json/wp/v2/posts/<id>` di HTML, lalu fetch
//     single-post REST (200 OK) → content.rendered berisi SEMUA URL foto.
//     Fallback: parse <img> dari HTML kalau REST gagal.
//
// Pakai native fetch + regex parsing (konsisten dgn tool lain di bot ini),
// tanpa dependensi tambahan (cheerio/axios).

import { logger } from '../../system/logger.js'
import { botDatabase } from '../../storage/database.js'
import { tmpdir } from 'os'
import { join } from 'path'

type FourkhdPost = { url: string; title: string; size: string | null; photoCount: number | null }
const searchByJid = new Map<string, { posts: FourkhdPost[]; updatedAt: number }>()
type FourkhdDetailContext = {
  url: string
  title: string
  total: number
  nextFrom: number
  updatedAt: number
}
const detailByJid = new Map<string, FourkhdDetailContext>()
const SEARCH_CONTEXT_TTL_MS = 15 * 60 * 1000
const DEFAULT_CONTEXT_KEY = '__default__'
const SEARCH_CONTEXT_NAME = '4khd-search'
const DETAIL_CONTEXT_NAME = '4khd-detail'

function contextKey(context?: { jid?: string }): string {
  return context?.jid || DEFAULT_CONTEXT_KEY
}

function getPosts(jid?: string): FourkhdPost[] {
  const key = jid || DEFAULT_CONTEXT_KEY
  let entry = searchByJid.get(key)
  if (!entry) {
    const stored = botDatabase.getToolContext<{ posts: FourkhdPost[] }>(key, SEARCH_CONTEXT_NAME, SEARCH_CONTEXT_TTL_MS)
    if (stored?.posts?.length) {
      entry = { posts: stored.posts, updatedAt: Date.now() }
      searchByJid.set(key, entry)
    }
  }
  if (!entry || Date.now() - entry.updatedAt > SEARCH_CONTEXT_TTL_MS) {
    searchByJid.delete(key)
    return []
  }
  return entry.posts
}

const BASE = 'https://www.4khd.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 25000

// Header default yang dipakai semua request 4khd
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `${BASE}/`,
    ...extra,
  }
}

/** GET helper → string body (atau null kalau bukan 200). */
async function getText(url: string, extra: Record<string, string> = {}): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: headers(extra),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.text()
  } catch (err: any) {
    logger.warn({ err: err.message, url }, '4khd fetch failed')
    return null
  }
}

/** GET helper → parsed JSON (atau null). */
async function getJson(url: string, extra: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, {
      headers: headers(extra),
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.json()
  } catch (err: any) {
    logger.warn({ err: err.message, url }, '4khd json fetch failed')
    return null
  }
}

/** Ekstrak semua link post dari HTML listing → { url, title, size, photoCount }. */
function parseListing(html: string): Array<{ url: string; title: string; size: string | null; photoCount: number | null }> {
  const posts: Array<{ url: string; title: string; size: string | null; photoCount: number | null }> = []
  const seen = new Set<string>()

  // Ambil setiap elemen <li> (atau block post) lalu cari heading + link di dalamnya.
  const lis = html.match(/<li[^>]*class="[^"]*wp-block-post[^"]*"[^>]*>[\s\S]*?<\/li>/gi) || []
  const anchors: string[] = []
  for (const li of lis) {
    const href = (li.match(/<h[23][^>]*>\s*<a[^>]*href="([^"]+)"/i) || [])[1]
      || (li.match(/<a[^>]*href="([^"]+)"[^>]*>\s*<[^>]+>[\s\S]*?<\/[^>]+>[\s\S]*?<[^>]+/i) || [])[1]
    if (href) anchors.push(href)
  }
  // Fallback kalau pola <li> di atas tidak match: ambil semua <a> ke /content/.
  if (!anchors.length) {
    const re = /<h[23][^>]*>[\s\S]*?<a[^>]*href="([^"]*\/content\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let m
    while ((m = re.exec(html))) {
      const raw = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim()
      const href = m[1].replace(/&amp;/g, '&')
      posts.push({ url: href, title: raw, size: null, photoCount: null })
    }
    return dedupe(posts)
  }

  for (const href of anchors) {
    if (seen.has(href) || !/\/content\//.test(href)) continue
    seen.add(href)
    // Cari blok <li> yang berisi href ini untuk dapetin thumbnail & meta
    const li = lis.find(l => l.includes(href)) || ''
    const rawTitle = (li.match(/<h[23][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1]
      ?.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim() || ''
    const img = (li.match(/<img[^>]*src="([^"]+)"/i) || [])[1]
      || (li.match(/<img[^>]*data-src="([^"]+)"/i) || [])[1]
      || (li.match(/<img[^>]*data-lazy-src="([^"]+)"/i) || [])[1]
    // "[38MB-43photos]" / "[2.14GB-81photos]"
    const meta = rawTitle.match(/\[([\d.]+\s*[KMGT]?B)[-\s]*(\d+)\s*photos?\]/i)
    posts.push({
      url: href,
      title: rawTitle.replace(/\[[^\]]*\]\s*$/, '').trim() || rawTitle,
      size: meta ? meta[1] : null,
      photoCount: meta ? parseInt(meta[2], 10) : null,
    })
  }
  return dedupe(posts)
}

function dedupe(posts: Array<{ url: string; title: string; size: string | null; photoCount: number | null }>) {
  const out: typeof posts = []
  const seen = new Set<string>()
  for (const p of posts) {
    if (seen.has(p.url)) continue
    seen.add(p.url)
    out.push(p)
  }
  return out
}

/**
 * Cari post via kata kunci. Ada 2 mekanisme pagination:
 *   - Search  : path-based → /search/<query>/page/<N>
 *   - Latest  : query-param → /?query-3-page=<N>
 */
async function scrapeSearch(query: string, page = 1): Promise<Array<{ url: string; title: string; size: string | null; photoCount: number | null }>> {
  if (!query || !query.trim()) return []
  const url = page > 1
    ? `${BASE}/search/${encodeURIComponent(query)}/page/${page}`
    : `${BASE}/?s=${encodeURIComponent(query)}`
  const html = await getText(url)
  if (!html) return []
  return parseListing(html)
}

/** Post terbaru (homepage / paginated via ?query-3-page=N). */
async function scrapeLatest(page = 1): Promise<Array<{ url: string; title: string; size: string | null; photoCount: number | null }>> {
  const url = page > 1 ? `${BASE}/?query-3-page=${page}` : `${BASE}/`
  const html = await getText(url)
  if (!html) return []
  return parseListing(html)
}

/** Gacha: ambil post acak dari homepage (pool 1-500 halaman). */
async function scrapeGacha(): Promise<Array<{ url: string; title: string; size: string | null; photoCount: number | null }>> {
  const page = Math.floor(Math.random() * 500) + 1
  return scrapeLatest(page)
}

/** Ekstrak semua URL foto dari content.rendered / HTML (dedup + urut nomor). */
function extractPhotos(content: string): string[] {
  const raw = (content.match(/https?:\/\/[^\s"'<>\\]*pic\.4khd\.com[^\s"'<>\\)]*/gi) || [])
    .map(u => u.replace(/\\\//g, '/'))
  const byNum = new Map<string, string>()
  const noNum: string[] = []
  for (const u of raw) {
    if (!/\.(webp|jpg|jpeg|png)/i.test(u)) continue
    const clean = u.split('?')[0]
    const n = (u.match(/-(\d{2,4})\.(webp|jpg|jpeg|png)/i) || [])[1]
    if (n) { if (!byNum.has(n)) byNum.set(n, clean) }
    else if (!noNum.includes(clean)) noNum.push(clean)
  }
  const numbered = [...byNum.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(e => e[1])
  return numbered.length ? numbered : noNum
}

/** Detail post → { title, postId, images }. */
async function scrapePostDetail(postUrl: string): Promise<{ title: string; postId: string | null; images: string[] } | null> {
  const html = await getText(postUrl)
  if (!html) return null

  const title = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || ''
    .replace(/\s*-\s*4KHD.*$/i, '')
    .replace(/\[[^\]]*\]\s*$/, '')
    .trim()
  const postId = (html.match(/wp-json\/wp\/v2\/posts\/(\d+)/) || [])[1] || null

  let images: string[] = []
  if (postId) {
    const rest = await getJson(`${BASE}/wp-json/wp/v2/posts/${postId}`, { 'Accept': 'application/json' })
    if (rest && rest.content && rest.content.rendered) {
      images = extractPhotos(rest.content.rendered)
    }
  }

  // Fallback: parse <img> dari HTML (biasanya cuma ~20 foto pertama).
  if (!images.length) {
    const s = new Set<string>()
    const imgRe = /<img[^>]*?src="([^"]*pic\.4khd\.com[^"]*?-\d{2,4}\.(?:webp|jpg|jpeg|png)[^"]*)"/gi
    let m
    while ((m = imgRe.exec(html))) s.add(m[1].split('?')[0])
    images = [...s]
  }

  return { title: title || 'Untitled', postId, images }
}

/** Download sebuah foto ke file temp, return path. */
async function downloadImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: headers(),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    const ext = (url.match(/\.(webp|jpg|jpeg|png)/i) || [])[1]?.toLowerCase() || 'jpg'
    // WhatsApp biasanya tampilkan jpg/png lebih baik; webp dikonversi via nama .jpg biar aman
    const safeExt = ext === 'webp' ? 'webp' : ext
    const outPath = join(tmpdir(), `4khd_${Date.now()}_${Math.floor(Math.random() * 1e4)}.${safeExt}`)
    const { writeFile } = await import('fs/promises')
    await writeFile(outPath, buf)
    return outPath
  } catch (err: any) {
    logger.warn({ err: err.message, url }, '4khd image download failed')
    return null
  }
}

// ------------------------- Handlers -------------------------

/** Format satu post jadi satu baris teks. */
function formatPost(p: { url: string; title: string; size: string | null; photoCount: number | null }, i: number): string {
  const meta = [p.size, p.photoCount ? `${p.photoCount} foto` : null].filter(Boolean).join(' | ')
  return `${i}. *${p.title}*\n   ${meta ? `📦 ${meta} • ` : ''}${p.url}`
}

/**
 * Ringkasan hasil pencarian 4khd terakhir, disuntikkan ke system prompt supaya AI
 * ingat hasilnya di pesan berikutnya (misal user: "kirim no 2"). Kosong kalau
 * belum ada hasil. Bisa dikosongkan dengan clear4khdResults().
 */
export function get4khdContext(jid?: string): string {
  const posts = getPosts(jid)
  if (!posts.length) return ''
  const lines = posts.slice(0, 10).map((p, i) => `${i + 1}. ${p.title} — ${p.size || '?'} • ${p.photoCount ?? '?'} foto • ${p.url}`).join('\n')
  return `Berikut hasil pencarian 4KHD terakhir yang sudah ditampilkan ke user:\n${lines}\n\nKalau user minta buka/kirim salah satu, panggil tool 4khd-detail dengan index = nomor di daftar ini (tanpa isi url), dan download = jumlah foto yang diminta.`
}

/**
 * Active detail context for follow-ups such as "lebih banyak 5 lagi".
 * This is kept separately from the search list because the next photo offset
 * belongs to the selected post, not to the result list itself.
 */
export function get4khdContinuation(jid?: string): {
  url: string
  title: string
  total: number
  nextFrom: number
} | null {
  const key = jid || DEFAULT_CONTEXT_KEY
  let entry = detailByJid.get(key)
  if (!entry) {
    const stored = botDatabase.getToolContext<Omit<FourkhdDetailContext, 'updatedAt'>>(
      key, DETAIL_CONTEXT_NAME, SEARCH_CONTEXT_TTL_MS,
    )
    if (stored?.url) {
      entry = { ...stored, updatedAt: Date.now() }
      detailByJid.set(key, entry)
    }
  }
  if (!entry || Date.now() - entry.updatedAt > SEARCH_CONTEXT_TTL_MS || entry.nextFrom > entry.total) {
    if (entry) detailByJid.delete(key)
    return null
  }
  return { url: entry.url, title: entry.title, total: entry.total, nextFrom: entry.nextFrom }
}

/** Hapus hasil pencarian 4khd yang tersimpan (dipanggil saat ada tool 4khd lain). */
export function clear4khdResults(jid?: string): void {
  if (jid) {
    searchByJid.delete(jid)
    detailByJid.delete(jid)
    botDatabase.clearToolContext(SEARCH_CONTEXT_NAME, jid)
    botDatabase.clearToolContext(DETAIL_CONTEXT_NAME, jid)
  } else {
    searchByJid.clear()
    detailByJid.clear()
    botDatabase.clearToolContext(SEARCH_CONTEXT_NAME)
    botDatabase.clearToolContext(DETAIL_CONTEXT_NAME)
  }
}

export type FourkhdSearchIntent =
  | { toolName: '4khd-search'; args: { query: string } }
  | { toolName: '4khd-latest'; args: Record<string, never> }

/** Parse natural chat such as "cariin Machi di 4khd" without involving the AI. */
export function parseFourkhdSearchIntent(text: string): FourkhdSearchIntent | null {
  const value = (text || '').replace(/@\d+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/\b4khd(?:\.com)?\b/i.test(value)) return null
  if (!/\b(cari(?:in|kan)?|nyari|search|cek|lihat|latest|terbaru)\b/i.test(value)) return null

  if (/\b(latest|terbaru|postingan\s+baru)\b/i.test(value)) {
    return { toolName: '4khd-latest', args: {} }
  }

  const query = value
    .replace(/\b4khd(?:\.com)?\b/gi, ' ')
    .replace(/\b(?:tolong|dong|coba|minta|carikan|cariin|cari|nyari|search|cek|lihat|di|dari|untuk)\b/gi, ' ')
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!query || query.length > 100) return null
  return { toolName: '4khd-search', args: { query } }
}

interface SearchArgs {
  query: string
  page?: number
}

/** Cari galeri foto 4khd berdasarkan kata kunci. */
export async function handleFourkhdSearch(args: SearchArgs, context?: { jid?: string }): Promise<{ success: boolean; text?: string; error?: string }> {
  const { query } = args
  const page = Math.max(1, args.page || 1)

  if (!query || !query.trim()) {
    return { success: false, text: 'Mau cari apa di 4KHD? Kasih kata kunci kak!' }
  }

  let posts = await scrapeSearch(query, page)
  // The old integration displayed around 20 choices. Load the next result page
  // for the first search so natural follow-ups such as "kirim no 20" continue
  // to work when the site has enough matching posts.
  if (page === 1) {
    const nextPage = await scrapeSearch(query, 2)
    posts = dedupe([...posts, ...nextPage])
  }
  if (!posts.length) {
    return { success: false, text: `Gak nemu hasil di 4KHD untuk "${query}". Coba kata kunci lain kak!` }
  }

  // Simpan hasil biar 4khd-detail bisa dipanggil dengan `index` tanpa URL.
  const key = contextKey(context)
  searchByJid.set(key, { posts, updatedAt: Date.now() })
  detailByJid.delete(key)
  botDatabase.setToolContext(key, SEARCH_CONTEXT_NAME, { posts })
  botDatabase.clearToolContext(DETAIL_CONTEXT_NAME, key)

  const shown = posts.slice(0, 20)
  const lines = shown.map((p, i) => formatPost(p, i + 1))
  const total = posts.length
  return {
    success: true,
    text: `🔍 *4KHD — Hasil untuk "${query}"* (${shown.length} dari ${total} post)\n\n${lines.join('\n\n')}\n\n` +
          `Balas dengan nomor (mis. "kirim no 2") buat buka post itu, atau sebut judulnya.`,
  }
}

interface LatestArgs {
  page?: number
}

/** Ambil galeri foto terbaru dari homepage 4khd. */
export async function handleFourkhdLatest(args: LatestArgs, context?: { jid?: string }): Promise<{ success: boolean; text?: string; error?: string }> {
  const page = Math.max(1, args.page || 1)
  const posts = await scrapeLatest(page)
  if (!posts.length) {
    return { success: false, text: 'Gagal ambil daftar terbaru dari 4KHD. Coba lagi nanti kak!' }
  }

  // Simpan hasil biar 4khd-detail bisa dipanggil dengan nomor pilihan.
  const key = contextKey(context)
  searchByJid.set(key, { posts, updatedAt: Date.now() })
  detailByJid.delete(key)
  botDatabase.setToolContext(key, SEARCH_CONTEXT_NAME, { posts })
  botDatabase.clearToolContext(DETAIL_CONTEXT_NAME, key)

  const lines = posts.slice(0, 10).map((p, i) => formatPost(p, i + 1))
  return {
    success: true,
    text: `🆕 *4KHD — Galeri Terbaru* (hal ${page})\n\n${lines.join('\n\n')}\n\nBalas dengan nomor (mis. "kirim no 3") buat buka post itu.`,
  }
}

interface DetailArgs {
  url?: string
  download?: boolean | number | string // true/number "true"/"2" = jumlah foto
  index?: number | string              // saat `url` kosong: nomor post (1-based) dari hasil 4khd-search terakhir
  from?: number | string               // indeks foto (1-based) untuk mulai mengirim, default 1
}

/** Konversi nilai {boolean|number|string} ke angka foto yang mau dikirim. 0 = jangan download (mode list). */
function normalizeDownload(v: unknown): number {
  if (v === true || v === 'true' || v === '1') return 1
  if (v === false || v === 'false' || v == null || v === '' || v === 0) return 0
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Konversi nilai {number|string} ke angka (1-based) yang aman. */
function toPositiveInt(v: unknown, fallback = 1): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Buka detail post 4KHD. Kalau `download` true/angka, download foto (default 1),
 * dan bot akan kirim gambar. Bisa dipanggil berulang buat foto berikutnya.
 * `index` (1-based) saat URL kosong = nomor post dari hasil 4khd-search terakhir.
 */
export async function handleFourkhdDetail(args: DetailArgs, context?: { jid?: string }): Promise<{
  success: boolean
  text?: string
  filePath?: string
  filePaths?: string[]
  fileType?: 'image'
  caption?: string
  error?: string
}> {
  let url = args.url?.trim() || ''

  // Kalau tanpa URL, coba pakai `index` (nomor pilihan) dari hasil search terakhir.
  const selectPost = toPositiveInt(args.index, 1)
  const posts = getPosts(context?.jid)
  let chosen: FourkhdPost | undefined
  if (url) {
    if (!/^https?:\/\//i.test(url)) url = `${BASE}${url.startsWith('/') ? url : '/' + url}`
    if (!/4khd\.com/i.test(url)) {
      return { success: false, text: 'Kasih URL post 4KHD yang valid kak! (contoh: https://www.4khd.com/content/...)' }
    }
  } else {
    chosen = posts[selectPost - 1]
    if (!chosen) {
      if (posts.length > 0) {
        return { success: false, text: `Nomor ${selectPost} tidak ada di hasil terakhir. Pilih nomor 1 sampai ${posts.length}.` }
      }
      return { success: false, text: 'Belum ada hasil pencarian 4KHD. Cari dulu dengan 4khd-search, atau kasih URL post-nya langsung.' }
    }
    url = chosen.url
  }

  const detail = await scrapePostDetail(url)
  if (!detail) {
    return { success: false, text: 'Gagal ambil detail post dari 4KHD. URL-nya bener? Coba lagi nanti kak!' }
  }

  const images = detail.images
  if (!images.length) {
    return { success: false, text: `Post "${detail.title}" gak nemu foto. Mungkin post-nya berbayar/dihapus.` }
  }

  const wantDownload = normalizeDownload(args.download)
  const fromIndex = toPositiveInt(args.from, 1) - 1
  const detailTitle = processTitle(detail.title, chosen)

  // Remember the selected post and the next photo offset for follow-up
  // requests, e.g. "kirim lebih banyak 5 lagi".
  detailByJid.set(contextKey(context), {
    url,
    title: detailTitle,
    total: images.length,
    nextFrom: Math.max(1, fromIndex + 1),
    updatedAt: Date.now(),
  })
  botDatabase.setToolContext(contextKey(context), DETAIL_CONTEXT_NAME, {
    url,
    title: detailTitle,
    total: images.length,
    nextFrom: Math.max(1, fromIndex + 1),
  })

  // Mode download: kirim 1..N foto (mulai dari foto `from`).
  if (wantDownload > 0) {
    const total = images.length
    const slice = images.slice(fromIndex, fromIndex + wantDownload)
    const filePaths: string[] = []
    for (const u of slice) {
      const fp = await downloadImage(u)
      if (fp) filePaths.push(fp)
      if (filePaths.length >= wantDownload) break
    }
    if (!filePaths.length) {
      return { success: false, text: 'Gagal download foto dari post itu. Coba lagi nanti kak!' }
    }
    const firstNum = fromIndex + 1
    const lastNum = fromIndex + filePaths.length
    detailByJid.set(contextKey(context), {
      url,
      title: detailTitle,
      total,
      nextFrom: lastNum + 1,
      updatedAt: Date.now(),
    })
    botDatabase.setToolContext(contextKey(context), DETAIL_CONTEXT_NAME, {
      url,
      title: detailTitle,
      total,
      nextFrom: lastNum + 1,
    })
    const nextHint = `${detailTitle} — kirim foto ${lastNum + 1}..${Math.min(lastNum + wantDownload, total)} kalau mau lanjut.`
    return {
      success: true,
      text: `🖼️ *${detailTitle}* — ${filePaths.length} foto terkirim (${firstNum}-${lastNum} dari ${total}). ${nextHint}`,
      filePaths,
      fileType: 'image',
      caption: `${firstNum}-${lastNum}/${total} • ${detailTitle}`,
    }
  }

  // Mode list: tampilkan semua URL foto (dipotong) sebagai teks.
  const shown = images.slice(0, 40)
  const urlLines = shown.map((u, i) => `${i + 1}. ${u}`).join('\n')
  const more = images.length > shown.length ? `\n…dan ${images.length - shown.length} foto lagi` : ''
  return {
    success: true,
    text:
      `🖼️ *${detailTitle}*\n` +
      `Total: ${images.length} foto${detail.postId ? ` • ID: ${detail.postId}` : ''}\n\n` +
      `${urlLines}${more}\n\n` +
      `Mau kirim fotonya? Pakai *4khd-detail* dengan download=N (misal download=5) buat kirim N foto.`,
  }
}

/** Judul hasil search (kalau ada) lebih relevan daripada <title> browser. */
function processTitle(detailTitle: string, chosen?: { title: string } | null): string {
  return (chosen && chosen.title) || detailTitle
}

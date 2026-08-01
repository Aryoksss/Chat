// ============================================================
// Tool: Web Search — cari info di internet (DuckDuckGo + Bing fallback)
// ============================================================
// No API key needed. Scrapes DuckDuckGo HTML, falls back to Bing HTML.

import { logger } from '../../system/logger.js'

interface WebSearchArgs {
  query: string
  maxResults?: number
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 20000

interface SearchResult {
  title: string
  url: string
  snippet: string
}

export async function handleWebSearch(args: WebSearchArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const query = args.query?.trim()
  const maxResults = Math.min(Math.max(args.maxResults || 5, 1), 10)

  if (!query) {
    return { success: false, text: 'Mau cari apa? Kasih kata kuncinya dulu kak!' }
  }

  let results: SearchResult[] = []

  // 1) DuckDuckGo (HTML)
  try {
    results = await searchDuckDuckGo(query)
  } catch (err: any) {
    logger.warn({ err: err.message }, 'DuckDuckGo search failed')
  }

  // 2) Fallback: Bing
  if (results.length === 0) {
    try {
      results = await searchBing(query)
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Bing search failed')
    }
  }

  if (results.length === 0) {
    return { success: false, text: `Gak nemu hasil web untuk "${query}". Coba kata kunci lain atau periksa koneksi internet.` }
  }

  const lines = results.slice(0, maxResults).map((r, i) =>
    `${i + 1}. *${r.title}*\n   ${r.url}\n   ${r.snippet || '(tanpa deskripsi)'}`
  )
  return { success: true, text: `🌐 *Hasil pencarian "${query}":*\n\n${lines.join('\n\n')}` }
}

// ---------------------------------------------------------------------------
// DuckDuckGo HTML
// ---------------------------------------------------------------------------
async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`)

  const html = await res.text()
  const results: SearchResult[] = []

  // Each result lives in an outer <div class="result ..."> block. Split ONLY on
  // the outer container (class starts with "result " + space) — NOT on nested
  // divs like "result__body" which also contain the word "result".
  const blocks = html.split(/<div[^>]*class="result [^"]*"[^>]*>/gi)
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/si)
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>(.*?)<\/a>/si)
    if (!titleMatch) continue

    const url = cleanDdgUrl(titleMatch[1])
    // Skip sponsored/ad links (DDG wraps ads in duckduckgo.com/y.js?ad_...)
    if (isAdUrl(url)) continue

    results.push({
      title: stripHtml(titleMatch[2]),
      url,
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
    })
    if (results.length >= 10) break
  }
  return results
}

/** Skip DuckDuckGo sponsored/ads and weird tracking-only links */
function isAdUrl(url: string): boolean {
  return /y\.js\?|ad_domain|ad_provider|ad_type|ad_click|aclick|utm_/i.test(url)
}

/** DDG wraps external links in //duckduckgo.com/l/?uddg=<encoded>&rut=... */
function cleanDdgUrl(href: string): string {
  const m = href.match(/uddg=([^&]+)/)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  return href.startsWith('//') ? `https:${href}` : href
}

// ---------------------------------------------------------------------------
// Bing HTML fallback
// ---------------------------------------------------------------------------
async function searchBing(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=id`, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`)

  const html = await res.text()
  const results: SearchResult[] = []

  const blocks = html.split(/<li class="b_algo"/gi)
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a><\/h2>/si)
    const snippetMatch = block.match(/<p[^>]*>(.*?)<\/p>/si)
    if (!titleMatch) continue

    results.push({
      title: stripHtml(titleMatch[2]),
      url: titleMatch[1],
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
    })
    if (results.length >= 10) break
  }
  return results
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------
function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

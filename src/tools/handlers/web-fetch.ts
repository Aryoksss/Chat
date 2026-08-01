// ============================================================
// Tool: Web Fetch — baca isi halaman web dari URL (HTML/JSON → teks)
// ============================================================
// Lets the AI "crawl" a page: fetch a URL and return readable text content.

import { logger } from '../../system/logger.js'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

interface WebFetchArgs {
  url: string
  maxChars?: number
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 25000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5

export async function handleWebFetch(args: WebFetchArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const url = args.url?.trim()
  const maxChars = Math.min(Math.max(args.maxChars || 4000, 500), 12000)

  if (!url) {
    return { success: false, text: 'Kasih URL-nya dulu kak!' }
  }
  if (!/^https?:\/\//i.test(url)) {
    return { success: false, text: 'URL harus diawali http:// atau https://' }
  }

  try {
    let currentUrl = url
    let res!: Response
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      await assertPublicUrl(currentUrl)
      res = await fetch(currentUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })

      if (![301, 302, 303, 307, 308].includes(res.status)) break
      const location = res.headers.get('location')
      if (!location || redirect === MAX_REDIRECTS) {
        return { success: false, text: `Redirect URL terlalu banyak atau tidak valid: ${currentUrl}` }
      }
      currentUrl = new URL(location, currentUrl).toString()
    }

    if (!res.ok) {
      return { success: false, text: `Gagal buka ${currentUrl}: HTTP ${res.status}` }
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    const declaredLength = Number(res.headers.get('content-length') || 0)
    if (declaredLength > MAX_RESPONSE_BYTES) {
      return { success: false, text: `Halaman terlalu besar untuk dibaca (maksimal ${MAX_RESPONSE_BYTES / 1024 / 1024} MB).` }
    }
    const body = await readLimitedText(res, MAX_RESPONSE_BYTES)

    let text: string
    if (contentType.includes('json')) {
      // Pretty-print JSON for readability
      try {
        text = JSON.stringify(JSON.parse(body), null, 2)
      } catch {
        text = body
      }
    } else {
      text = htmlToText(body)
    }

    text = text.trim()
    if (!text) {
      return { success: false, text: `Halaman ${currentUrl} kosong atau tidak ada konten teks.` }
    }

    const truncated = text.length > maxChars ? `${text.slice(0, maxChars)}\n…[dipotong, total ${text.length} karakter]` : text
    return { success: true, text: `📄 *Isi ${currentUrl}:*\n\n${truncated}` }
  } catch (err: any) {
    logger.warn({ err: err.message, url }, 'web-fetch failed')
    return { success: false, error: `Gagal fetch ${url}: ${err.message}` }
  }
}

async function assertPublicUrl(rawUrl: string): Promise<void> {
  const parsed = new URL(rawUrl)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Hanya HTTP/HTTPS yang diizinkan')
  if (parsed.username || parsed.password) throw new Error('URL dengan kredensial tidak diizinkan')

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Alamat internal tidak diizinkan')
  }

  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map(entry => entry.address)
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('Alamat internal/private tidak diizinkan')
  }
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) || a >= 224
  }

  const normalized = address.toLowerCase()
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return Boolean(mapped && isPrivateAddress(mapped[1]))
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`Respons terlalu besar (maksimal ${maxBytes} bytes)`)
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

/** Crude but effective HTML → readable text extraction */
function htmlToText(html: string): string {
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n') // block-ish tags → newline
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
  return t
}

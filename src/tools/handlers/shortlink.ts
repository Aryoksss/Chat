// ============================================================
// Tool: Shortlink — bikin link pendek
// ============================================================

import { logger } from '../../system/logger.js'

interface ShortlinkArgs {
  url: string
}

export async function handleShortlink(args: ShortlinkArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const { url } = args

  if (!url || url.trim().length === 0) {
    return { success: false, text: 'Kasih URL yang mau dipendekin kak!' }
  }

  // Basic URL validation
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { success: false, text: 'URL harus dimulai dengan http:// atau https:// kak!' }
  }

  try {
    // Try TinyURL API (free, no key needed). AbortSignal.timeout mencegah fetch
    // menggantung selamanya kalau API lambat/tidak merespons (ini yg bikin bot stuck).
    const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`TinyURL HTTP ${response.status}`)
    const shortUrl = (await response.text()).trim()

    if (shortUrl && shortUrl.startsWith('http')) {
      return {
        success: true,
        text: `🔗 *Link Pendek:*\n${shortUrl}`,
      }
    }

    // Fallback: is.gd
    const fallbackResp = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!fallbackResp.ok) throw new Error(`is.gd HTTP ${fallbackResp.status}`)
    const fallbackUrl = (await fallbackResp.text()).trim()

    if (fallbackUrl && fallbackUrl.startsWith('http')) {
      return {
        success: true,
        text: `🔗 *Link Pendek:*\n${fallbackUrl}`,
      }
    }

    return { success: false, text: 'Gagal bikin shortlink. Coba lagi nanti.' }
  } catch (err: any) {
    logger.error({ err }, 'shortlink failed')
    return { success: false, error: `Gagal bikin shortlink: ${err.message} (link: ${url.slice(0, 60)})` }
  }
}

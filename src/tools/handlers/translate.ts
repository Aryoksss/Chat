// ============================================================
// Tool: Translate — terjemahkan teks
// ============================================================

import { logger } from '../../system/logger.js'

interface TranslateArgs {
  text: string
  to?: string
}

export async function handleTranslate(args: TranslateArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const { text, to = 'id' } = args

  if (!text || text.trim().length === 0) {
    return { success: false, text: 'Kasih teks yang mau diterjemahin dulu kak!' }
  }

  try {
    // Use a free translation API with auto-detect source language (no hardcoded EN)
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|${to}`,
      { signal: AbortSignal.timeout(10000) }
    )
    const data = await response.json() as any

    if (data?.responseStatus === 200 && data?.responseData?.translatedText) {
      // MyMemory prefixes auto-detected lang like "[en] text" — strip it
      let translated = data.responseData.translatedText
      const detectedMatch = translated.match(/^\s*\[([a-z]{2})\]\s*/i)
      if (detectedMatch) translated = translated.slice(detectedMatch[0].length)
      return {
        success: true,
        text: `🌐 *Terjemahan:*\n\n${translated}`,
      }
    }

    // Fallback: use another API
    const fallbackResp = await fetch(
      `https://lingva.ml/api/v1/auto/${to}/${encodeURIComponent(text)}`,
      { signal: AbortSignal.timeout(10000) }
    )
    const fallbackData = await fallbackResp.json() as any

    if (fallbackData?.translation) {
      return {
        success: true,
        text: `🌐 *Terjemahan:*\n\n${fallbackData.translation}`,
      }
    }

    return { success: false, text: 'Gagal nerjemahin teks. Coba lagi nanti.' }
  } catch (err: any) {
    logger.error({ err }, 'translate failed')
    return { success: false, error: `Gagal translate: ${err.message}` }
  }
}

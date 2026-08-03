// ============================================================
// Voice Translator — translate text before Japanese Hu Tao TTS
// ============================================================

import { logger } from '../system/logger.js'

function cleanTranslation(value: unknown): string {
  return String(value || '')
    .replace(/^\s*\[[a-z-]+\]\s*/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Translate a short voice reply to Japanese without changing the chat reply. */
export async function translateVoiceTextToJapanese(input: string): Promise<string | null> {
  const text = input.trim()
  if (!text) return null

  try {
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=autodetect|ja`,
      { signal: AbortSignal.timeout(10_000) },
    )
    const data = await response.json() as any
    if (Number(data?.responseStatus) === 200) {
      const translated = cleanTranslation(data?.responseData?.translatedText)
      if (translated) return translated
    }
  } catch (err: any) {
    logger.warn({ error: err?.message || String(err) }, 'Primary Japanese voice translation failed')
  }

  try {
    const response = await fetch(
      `https://lingva.ml/api/v1/auto/ja/${encodeURIComponent(text)}`,
      { signal: AbortSignal.timeout(10_000) },
    )
    const data = await response.json() as any
    const translated = cleanTranslation(data?.translation)
    if (translated) return translated
  } catch (err: any) {
    logger.warn({ error: err?.message || String(err) }, 'Fallback Japanese voice translation failed')
  }

  return null
}

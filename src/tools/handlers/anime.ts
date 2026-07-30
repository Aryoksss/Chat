// ============================================================
// Tool: Anime Search — cari info anime dari MyAnimeList
// ============================================================

import { logger } from '../../system/logger.js'

interface AnimeArgs {
  query: string
}

export async function handleAnimeSearch(args: AnimeArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const { query } = args

  if (!query || query.trim().length === 0) {
    return { success: false, text: 'Mau cari anime apa? Kasih judulnya kak!' }
  }

  try {
    // Jikan API (unofficial MyAnimeList API, free)
    const response = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(query)}&limit=3`)
    const data = await response.json() as any

    if (data?.data?.length > 0) {
      const results = data.data.map((anime: any) => {
        const title = anime.title || anime.title_english || '?'
        const type = anime.type || '?'
        const episodes = anime.episodes ?? '?'
        const score = anime.score ?? '?'
        const status = anime.status || '?'
        const synopsis = anime.synopsis
          ? (anime.synopsis.length > 200 ? anime.synopsis.slice(0, 200) + '...' : anime.synopsis)
          : 'Tidak ada sinopsis.'
        const url = anime.url || ''

        return `━━━━━━━━━━━━━━━━\n📺 *${title}*\n📋 Tipe: ${type} | Episode: ${episodes}\n⭐ Skor: ${score} | Status: ${status}\n📖 ${synopsis}\n🔗 ${url}`
      }).join('\n')

      return {
        success: true,
        text: `🎌 *Hasil Pencarian Anime: ${query}*\n${results}`,
      }
    }

    return { success: false, text: `Gak nemu anime "${query}". Coba pake judul lain kak!` }
  } catch (err: any) {
    logger.error({ err }, 'anime search failed')
    return { success: false, error: `Gagal cari anime: ${err.message}` }
  }
}

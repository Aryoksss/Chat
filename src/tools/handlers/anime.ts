// ============================================================
// Tool: Anime Search — cari info anime dari AniList
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

  // AniList GraphQL (reliable, free, no key).
  try {
    const anilistResp = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'whatsapp-bot/1.0' },
      body: JSON.stringify({
        query: `
          query ($search: String) {
            Media(search: $search, type: ANIME) {
              title { romaji english }
              format episodes averageScore status
              description(asHtml: false)
              siteUrl
            }
          }`,
        variables: { search: query },
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (anilistResp.ok) {
      const ani = (await anilistResp.json() as any)?.data?.Media
      if (ani) {
        const title = ani.title?.romaji || ani.title?.english || '?'
        const type = ani.format || '?'
        const episodes = ani.episodes ?? '?'
        const score = ani.averageScore ? `${ani.averageScore / 10}/10` : '?'
        const status = ani.status || '?'
        const synopsis = ani.description
          ? (ani.description.replace(/<[^>]+>/g, '').slice(0, 200) + '...')
          : 'Tidak ada sinopsis.'
        return {
          success: true,
          text: `🎌 *Hasil Pencarian Anime: ${query}*\n━━━━━━━━━━━━━━━━\n📺 *${title}*\n📋 Tipe: ${type} | Episode: ${episodes}\n⭐ Skor: ${score} | Status: ${status}\n📖 ${synopsis}\n🔗 ${ani.siteUrl || ''}`,
        }
      }
    }
  } catch (err: any) {
    logger.error({ err }, 'AniList search failed')
  }

  return { success: false, text: `Gak nemu anime "${query}". Coba pake judul lain kak!` }
}

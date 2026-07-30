// ============================================================
// Tool: Brainly Scraper — cari jawaban soal
// ============================================================

import { logger } from '../../system/logger.js'

interface BrainlyArgs {
  query: string
}

export async function handleBrainly(args: BrainlyArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const { query } = args

  if (!query || query.trim().length === 0) {
    return { success: false, text: 'Mau cari soal apa? Kasih pertanyaannya dulu kak!' }
  }

  try {
    // Use Brainly API (public endpoint)
    const response = await fetch(`https://api.egojs.com/api/search/brainly?q=${encodeURIComponent(query)}`)
    const data = await response.json() as any

    if (data?.result?.data?.brainly?.questionEdge?.[0]) {
      const questionData = data.result.data.brainly.questionEdge[0].node
      const question = questionData.content
      const answers = questionData.answers?.edges?.slice(0, 3) || []

      let resultText = `📚 *Pertanyaan:* ${question}\n\n*Jawaban:*\n`

      if (answers.length === 0) {
        resultText += '_(Belum ada jawaban)_'
      } else {
        answers.forEach((a: any, i: number) => {
          const answerText = a.node.content
          const author = a.node?.author?.username || 'Anonymous'
          resultText += `\n${i + 1}. ${answerText}\n   — ${author}\n`
        })
      }

      return { success: true, text: resultText }
    }

    // Fallback: try another API
    const altResponse = await fetch(`https://api.nyxs.pro/api/brainly?q=${encodeURIComponent(query)}`)
    const altData = await altResponse.json() as any

    if (altData?.data?.length > 0) {
      const result = altData.data.slice(0, 3).map((item: any) =>
        `• ${item.pertanyaan}\n  Jawaban: ${item.jawaban}`
      ).join('\n\n')

      return { success: true, text: `📚 *Hasil Brainly:*\n\n${result}` }
    }

    return { success: false, text: 'Gak nemu jawaban buat soal itu kak. Coba tanya ulang pake kata kunci lain.' }
  } catch (err: any) {
    logger.error({ err }, 'brainly failed')
    return { success: false, error: `Gagal cari soal: ${err.message}` }
  }
}

// ============================================================
// Tool: Brainly Scraper — cari jawaban soal pelajaran
// ============================================================

import { logger } from '../../system/logger.js'

interface BrainlyArgs {
  query: string
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const PER_REQUEST_TIMEOUT_MS = 10000

/** Public Brainly endpoints — tried in order until one works. */
const ENDPOINTS = [
  (q: string) => `https://api.egojs.com/api/search/brainly?q=${encodeURIComponent(q)}`,
  (q: string) => `https://api.nyxs.pro/api/brainly?q=${encodeURIComponent(q)}`,
  (q: string) => `https://api.agatz.xyz/api/brainly?message=${encodeURIComponent(q)}`,
]

export async function handleBrainly(args: BrainlyArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const { query } = args

  if (!query || query.trim().length === 0) {
    return { success: false, text: 'Mau cari soal apa? Kasih pertanyaannya dulu kak!' }
  }

  // Try each endpoint in order; return the first that yields answers.
  for (const buildUrl of ENDPOINTS) {
    try {
      const url = buildUrl(query)
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'brainly endpoint non-OK')
        continue
      }
      const data = await response.json() as any

      // Format 1: api.egojs.com
      const q1 = data?.result?.data?.brainly?.questionEdge?.[0]?.node
      if (q1) {
        const question = q1.content
        const answers = q1.answers?.edges?.slice(0, 3) || []
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

      // Format 2: api.nyxs.pro — { data: [{ pertanyaan, jawaban, author }] }
      if (Array.isArray(data?.data) && data.data.length > 0) {
        const result = data.data.slice(0, 3).map((item: any) =>
          `• ${item.pertanyaan}\n  Jawaban: ${item.jawaban}`
        ).join('\n\n')
        return { success: true, text: `📚 *Hasil Brainly:*\n\n${result}` }
      }

      // Format 3: api.agatz.xyz — { data: { question, answer }[] | question, answers }
      const ag = data?.data
      if (ag) {
        const items = Array.isArray(ag) ? ag : (ag.questions || ag.data || [])
        if (Array.isArray(items) && items.length > 0) {
          const result = items.slice(0, 3).map((item: any) => {
            const question = item.question || item.pertanyaan || item.content || query
            const answer = item.answer || item.jawaban || item.answers || ''
            return `• ${question}\n  Jawaban: ${answer}`
          }).join('\n\n')
          return { success: true, text: `📚 *Hasil Brainly:*\n\n${result}` }
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'brainly endpoint error, trying next')
    }
  }

  return { success: false, text: 'Gak nemu jawaban buat soal itu kak. Coba tanya ulang pake kata kunci lain, atau minta bot cari di web (web-search).' }
}

import { unlink } from 'node:fs/promises'
import type { WhatsAppClient } from '../core/client.js'
import { financeService, normalizeFinancePeriod } from './service.js'
import { renderFinanceReportImage } from './report-image.js'
import type { FinanceMonthSummary } from './types.js'

export interface FinanceReportDelivery {
  period: string
  summary: FinanceMonthSummary
  imageSent: boolean
  textSent: boolean
}

export async function deliverFinanceReport(
  client: WhatsAppClient,
  jid: string,
  period?: string,
  quoted?: any,
  existingSummary?: FinanceMonthSummary,
): Promise<FinanceReportDelivery> {
  const normalized = normalizeFinancePeriod(period)
  const summary = existingSummary || financeService.summary(normalized)
  const image = await renderFinanceReportImage(summary)
  try {
    const imageSent = await client.sendFile(jid, image.filePath, 'image', undefined, quoted, image.fileName)
    const textSent = await client.sendText(jid, financeService.formatSummary(summary.period), quoted)
    return { period: summary.period, summary, imageSent, textSent }
  } finally {
    await unlink(image.filePath).catch(() => {})
  }
}


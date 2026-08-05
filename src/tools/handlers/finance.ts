import { config } from '../../system/config.js'
import { financeManager } from '../../finance/manager.js'
import { financeService, formatFinanceTransaction, normalizeFinancePeriod } from '../../finance/service.js'
import { renderFinanceReportImage } from '../../finance/report-image.js'
import type { ToolContext, ToolResult } from '../../core/types.js'

interface FinanceToolArgs {
  action?: string
  request?: string
  period?: string
  transactionId?: string
}

function isOwnerContext(context: ToolContext): boolean {
  if (context.jid.endsWith('@g.us')) return false
  const id = context.jid.replace(/[^0-9]/g, '')
  return [config.OWNER_NUMBER, config.OWNER_LID]
    .filter(Boolean)
    .map(value => value.replace(/[^0-9]/g, ''))
    .includes(id)
}

export async function handleFinance(args: FinanceToolArgs, context: ToolContext): Promise<ToolResult> {
  if (!isOwnerContext(context)) {
    return { success: false, error: 'Fitur keuangan hanya tersedia di chat pribadi owner.' }
  }
  const action = (args.action || 'summary').toLowerCase()

  if (action === 'summary' || action === 'report') {
    const period = normalizeFinancePeriod(args.period)
    const summary = financeService.summary(period)
    const image = await renderFinanceReportImage(summary)
    return {
      success: true,
      text: financeService.formatSummary(period),
      filePath: image.filePath,
      fileType: 'image',
      preserveTextResponse: true,
    }
  }
  if (action === 'list') {
    const transactions = financeService.transactions(args.period, false, 20)
    return {
      success: true,
      text: transactions.length
        ? transactions.map(formatFinanceTransaction).join('\n\n')
        : 'Belum ada transaksi terkonfirmasi untuk periode itu.',
    }
  }
  if (action === 'pending') {
    const pending = financeService.pending(20)
    return {
      success: true,
      text: pending.length
        ? `${pending.length} transaksi pending:\n\n${pending.map(formatFinanceTransaction).join('\n\n')}`
        : 'Tidak ada transaksi pending.',
    }
  }
  if (action === 'record') {
    if (!args.request?.trim()) return { success: false, error: 'Isi transaksi belum diberikan.' }
    const result = await financeService.recordManual(args.request)
    if (!result.transaction) return { success: false, error: result.reason || 'Transaksi gagal dibaca.' }
    return {
      success: true,
      text: `${formatFinanceTransaction(result.transaction)}\n\nKonfirmasi: ${config.PREFIX}keuangan konfirmasi ${result.transaction.id}`,
    }
  }
  if (action === 'update') {
    if (!args.transactionId || !args.request) return { success: false, error: 'ID dan perubahan transaksi wajib diisi.' }
    const result = financeService.edit(args.transactionId, args.request)
    return result.transaction
      ? { success: true, text: `Transaksi diperbarui:\n${formatFinanceTransaction(result.transaction)}` }
      : { success: false, error: result.error }
  }
  if (action === 'export') {
    const exported = await financeService.exportCsv(args.period)
    return {
      success: true,
      filePath: exported.filePath,
      fileType: 'document',
    }
  }
  if (action === 'sync') {
    const result = await financeManager.syncNow(args.request || undefined, false)
    return { success: true, text: result.message }
  }
  if (action === 'sheets' || action === 'sheets_sync') {
    const result = await financeManager.syncSheetsNow()
    return { success: true, text: result.message }
  }

  return { success: false, error: 'Action finance tidak dikenal.' }
}

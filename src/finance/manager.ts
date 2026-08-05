import { unlink } from 'node:fs/promises'
import type { WhatsAppClient } from '../core/client.js'
import { botDatabase } from '../storage/database.js'
import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { GmailReadOnlyClient } from './gmail.js'
import { deliverFinanceReport } from './report.js'
import { financePeriodRange, financeService, previousFinancePeriod } from './service.js'
import { FinanceSheetsClient } from './sheets.js'
import type { FinanceIngestResult, FinanceTransactionRecord } from './types.js'
import { sendFinanceReview } from './ui.js'

const REPORT_CHECK_MS = 60_000
const SYNC_OVERLAP_MS = 24 * 60 * 60 * 1000
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000

export interface FinanceSyncResult {
  fetched: number
  created: number
  confirmed: number
  pending: number
  ignored: number
  failed: number
  message: string
}

type FinanceSyncMode = 'background' | 'manual'

function startOfCurrentMonth(): number {
  return financePeriodRange().startAt
}

function parseSyncStart(value?: string): number | null {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = Date.parse(`${value}T00:00:00+07:00`)
  return Number.isFinite(parsed) ? parsed : null
}

function ownerJid(): string {
  return `${config.OWNER_NUMBER.replace(/[^0-9]/g, '')}@s.whatsapp.net`
}

function financeGmailQuery(): string {
  const senders = config.FINANCE_GMAIL_ALLOWED_SENDERS.map(sender => `from:${sender}`).join(' ')
  const subjects = [
    '"Internet Transaction Journal"', 'transaksi', 'transaction', 'payment',
    'pembayaran', 'transfer', 'debit', 'purchase',
  ].map(value => `subject:${value}`).join(' ')
  return `in:anywhere {${senders}} {${subjects}}`
}

export class FinanceManager {
  private client: WhatsAppClient | null = null
  private gmail = new GmailReadOnlyClient()
  private sheets = new FinanceSheetsClient()
  private emailTimer: ReturnType<typeof setInterval> | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private sheetsTimer: ReturnType<typeof setInterval> | null = null
  private syncing = false
  private syncingSheets = false
  private lastAlertAt = 0

  start(client: WhatsAppClient): void {
    this.client = client
    if (!config.FINANCE_ENABLED) {
      logger.info('Finance Gmail polling and monthly reports disabled (FINANCE_ENABLED=false)')
      return
    }
    if (this.emailTimer || this.reportTimer) return
    this.emailTimer = setInterval(() => {
      this.syncNow(undefined, true, 'background').catch(err => this.handleBackgroundError(err, 'Finance Gmail poll failed'))
    }, config.FINANCE_EMAIL_POLL_MS)
    this.reportTimer = setInterval(() => {
      this.deliverMonthlyReport().catch(err => this.handleBackgroundError(err, 'Finance report check failed'))
    }, REPORT_CHECK_MS)
    this.syncNow(undefined, true, 'background').catch(err => this.handleBackgroundError(err, 'Initial Finance Gmail poll failed'))
    this.deliverMonthlyReport().catch(err => this.handleBackgroundError(err, 'Initial Finance report check failed'))
    if (config.FINANCE_SHEETS_ENABLED && config.FINANCE_GOOGLE_SPREADSHEET_ID.trim()) {
      this.sheetsTimer = setInterval(() => {
        this.syncSheetsNow().catch(err => this.handleBackgroundError(err, 'Finance Sheets sync failed'))
      }, config.FINANCE_SHEETS_SYNC_MS)
      this.syncSheetsNow().catch(err => this.handleBackgroundError(err, 'Initial Finance Sheets sync failed'))
    } else if (config.FINANCE_SHEETS_ENABLED) {
      logger.warn('Finance Sheets enabled but FINANCE_GOOGLE_SPREADSHEET_ID is empty')
    }
    logger.info({ pollMs: config.FINANCE_EMAIL_POLL_MS }, 'Finance manager started')
  }

  stop(): void {
    if (this.emailTimer) clearInterval(this.emailTimer)
    if (this.reportTimer) clearInterval(this.reportTimer)
    if (this.sheetsTimer) clearInterval(this.sheetsTimer)
    this.emailTimer = null
    this.reportTimer = null
    this.sheetsTimer = null
    this.client = null
  }

  async syncNow(
    sinceDate?: string,
    notify = false,
    mode: FinanceSyncMode = 'manual',
  ): Promise<FinanceSyncResult> {
    if (!config.FINANCE_ENABLED) {
      return this.emptyResult('Sinkronisasi Gmail belum aktif. Set FINANCE_ENABLED=true setelah OAuth selesai.')
    }
    if (config.FINANCE_GMAIL_ALLOWED_SENDERS.length === 0) {
      return this.emptyResult('FINANCE_GMAIL_ALLOWED_SENDERS masih kosong; inbox tidak dipindai demi keamanan.')
    }
    if (sinceDate && parseSyncStart(sinceDate) === null) {
      return this.emptyResult('Tanggal tidak valid. Gunakan format YYYY-MM-DD.')
    }
    if (this.syncing) return this.emptyResult('Sinkronisasi Gmail sedang berjalan.')

    this.syncing = true
    const pollStartedAt = Date.now()
    const explicitStart = parseSyncStart(sinceDate)
    const stored = Number(botDatabase.getFinanceSyncState('gmail_last_poll_ms') || 0)
    const configured = parseSyncStart(config.FINANCE_EMAIL_START_DATE)
    const sinceMs = explicitStart ?? (stored > 0 ? Math.max(0, stored - SYNC_OVERLAP_MS) : configured ?? startOfCurrentMonth())
    const results: FinanceIngestResult[] = []

    try {
      // Scan Gmail by the configured bank senders and transaction-like
      // subjects. This removes the need for a manually maintained label while
      // keeping promotional mail from the same sender out of the importer.
      const fullSenderScan = mode === 'manual' && !sinceDate?.trim()
      const ids = await this.gmail.listMessageIdsByQuery(financeGmailQuery(), sinceMs, fullSenderScan)
      for (const id of ids) {
        const existing = botDatabase.getFinanceImport('gmail', id)
        if (existing && !(explicitStart && existing.status === 'failed')) continue
        const email = await this.gmail.getMessage(id)
        if (!config.FINANCE_GMAIL_ALLOWED_SENDERS.includes(email.sender.toLowerCase())) {
          if (botDatabase.claimFinanceImport('gmail', id, '', email.receivedAt)) {
            botDatabase.completeFinanceImport('gmail', id, 'ignored', undefined, 'sender_not_allowed')
            results.push({ kind: 'ignored', reason: 'Pengirim tidak diizinkan' })
          }
          continue
        }
        results.push(await financeService.ingestEmail(
          email,
          Boolean(explicitStart),
          mode === 'manual' && config.FINANCE_EMAIL_SYNC_AUTO_CONFIRM,
        ))
      }
      botDatabase.setFinanceSyncState('gmail_last_poll_ms', String(pollStartedAt))
      const promoted = mode === 'manual' && config.FINANCE_EMAIL_SYNC_AUTO_CONFIRM
        ? financeService.confirmSyncedEmailTransactions()
        : []
      if (config.FINANCE_SHEETS_ENABLED && config.FINANCE_GOOGLE_SPREADSHEET_ID.trim()) {
        await this.syncSheetsNow().catch(err => logger.warn({ err: err.message }, 'Finance Sheets sync after Gmail import failed'))
      }
      const summary = this.summarize(ids.length, results, promoted)
      if (notify && summary.created > 0) await this.notifyBatch(summary, results)
      return summary
    } finally {
      this.syncing = false
    }
  }

  private summarize(fetched: number, results: FinanceIngestResult[], promotedIds: string[] = []): FinanceSyncResult {
    const transactions = results.flatMap(result => [
      ...(result.transaction ? [result.transaction] : []),
      ...(result.relatedTransactions || []),
    ])
    const created = transactions.length
    const promoted = new Set(promotedIds)
    const confirmed = transactions.filter(transaction => transaction.status === 'confirmed').length + promotedIds.length
    const pending = transactions.filter(transaction =>
      ['pending', 'pending_duplicate'].includes(transaction.status) && !promoted.has(transaction.id),
    ).length
    const ignored = results.filter(result => result.kind === 'ignored').length
    const failed = results.filter(result => result.kind === 'failed').length
    return {
      fetched,
      created,
      confirmed,
      pending,
      ignored,
      failed,
      message: created === 0 && promotedIds.length === 0 && failed === 0
        ? `Sinkronisasi selesai. ${fetched} email diperiksa, tidak ada transaksi baru.`
        : `Sinkronisasi selesai: ${created} transaksi baru, ${promotedIds.length} transaksi tersimpan otomatis (${confirmed} otomatis, ${pending} pending), ${failed} gagal diproses.`,
    }
  }

  private emptyResult(message: string): FinanceSyncResult {
    return { fetched: 0, created: 0, confirmed: 0, pending: 0, ignored: 0, failed: 0, message }
  }

  async syncSheetsNow(): Promise<{ rowCount: number; sheetUrl: string; message: string }> {
    if (!config.FINANCE_SHEETS_ENABLED) {
      return { rowCount: 0, sheetUrl: '', message: 'Sinkronisasi Google Sheets belum diaktifkan.' }
    }
    if (!config.FINANCE_GOOGLE_SPREADSHEET_ID.trim()) {
      return { rowCount: 0, sheetUrl: '', message: 'FINANCE_GOOGLE_SPREADSHEET_ID belum diisi.' }
    }
    if (this.syncingSheets) {
      return { rowCount: 0, sheetUrl: '', message: 'Sinkronisasi Google Sheets sedang berjalan.' }
    }
    this.syncingSheets = true
    try {
      const result = await this.sheets.syncTransactions(financeService.allTransactions(true))
      return {
        rowCount: result.rowCount,
        sheetUrl: result.sheetUrl,
        message: `Google Sheets diperbarui: ${result.rowCount} transaksi.`,
      }
    } finally {
      this.syncingSheets = false
    }
  }

  private async notifyBatch(summary: FinanceSyncResult, results: FinanceIngestResult[]): Promise<void> {
    if (!this.client?.status.connected) return
    await this.client.sendText(
      ownerJid(),
      `📥 *Email transaksi tersinkron*\n${summary.created} transaksi baru · ${summary.confirmed} otomatis · ${summary.pending} perlu diperiksa.`,
    )
    const pending = results
      .flatMap(result => [
        ...(result.transaction ? [result.transaction] : []),
        ...(result.relatedTransactions || []),
      ])
      .filter((transaction): transaction is FinanceTransactionRecord => ['pending', 'pending_duplicate'].includes(transaction.status))
      .slice(0, 5)
    for (const transaction of pending) await sendFinanceReview(this.client, ownerJid(), transaction)
    if (summary.pending > pending.length) {
      await this.client.sendText(ownerJid(), `Masih ada ${summary.pending - pending.length} transaksi lain. Buka ${config.PREFIX}pending.`)
    }
  }

  private async deliverMonthlyReport(): Promise<void> {
    if (!config.FINANCE_ENABLED || !this.client?.status.connected) return
    const nowParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date())
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(nowParts.find(value => value.type === type)?.value || 0)
    const currentPeriod = `${part('year')}-${String(part('month')).padStart(2, '0')}`
    const [reportHour, reportMinute] = config.FINANCE_REPORT_TIME.split(':').map(Number)
    const currentMinutes = part('hour') * 60 + part('minute')
    if (part('day') < 1 || currentMinutes < reportHour * 60 + reportMinute) return

    const period = previousFinancePeriod(currentPeriod)
    if (!botDatabase.claimFinanceReport(period)) return
    try {
      const summary = financeService.summary(period)
      if (summary.confirmedCount === 0 && summary.pendingCount === 0) {
        botDatabase.completeFinanceReport(period)
        return
      }
      const delivered = await deliverFinanceReport(this.client, ownerJid(), period, undefined, summary)
      if (!delivered.textSent) throw new Error('Ringkasan bulanan gagal dikirim')
      if (!delivered.imageSent) logger.warn({ period }, 'Finance monthly image failed after text was delivered')
      botDatabase.completeFinanceReport(period)

      const exported = await financeService.exportCsv(period)
      try {
        const fileSent = await this.client.sendFile(ownerJid(), exported.filePath, 'document', `${exported.count} transaksi · ${period}`, undefined, exported.fileName)
        if (!fileSent) logger.warn({ period }, 'Finance monthly CSV failed after summary was delivered')
      } finally {
        await unlink(exported.filePath).catch(() => {})
      }
    } catch (err) {
      botDatabase.failFinanceReport(period)
      throw err
    }
  }

  private async handleBackgroundError(err: unknown, message: string): Promise<void> {
    const error = err instanceof Error ? err : new Error(String(err))
    logger.warn({ err: error.message }, message)
    if (!this.client?.status.connected || Date.now() - this.lastAlertAt < ALERT_COOLDOWN_MS) return
    this.lastAlertAt = Date.now()
    await this.client.sendText(ownerJid(), `⚠️ Sinkronisasi keuangan bermasalah: ${error.message.slice(0, 240)}`)
  }
}

export const financeManager = new FinanceManager()

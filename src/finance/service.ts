import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiBridge } from '../core/ai.js'
import { botDatabase } from '../storage/database.js'
import { config } from '../system/config.js'
import {
  merchantSimilarity,
  normalizeCategory,
  normalizeExtraction,
  normalizeTransactionType,
  parseBankEmail,
  parseFinanceDate,
  parseManualFallback,
  parseMoney,
  redactSensitiveText,
} from './parser.js'
import type {
  FinanceEmailInput,
  FinanceIngestResult,
  FinanceMonthSummary,
  FinanceTransactionDraft,
  FinanceTransactionPatch,
  FinanceTransactionRecord,
  FinanceTransactionStatus,
} from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WIB = 'Asia/Jakarta'

const MONTHS = new Map<string, number>([
  ['januari', 1], ['jan', 1], ['january', 1],
  ['februari', 2], ['feb', 2], ['february', 2],
  ['maret', 3], ['mar', 3], ['march', 3],
  ['april', 4], ['apr', 4],
  ['mei', 5], ['may', 5],
  ['juni', 6], ['jun', 6], ['june', 6],
  ['juli', 7], ['jul', 7], ['july', 7],
  ['agustus', 8], ['agu', 8], ['ags', 8], ['aug', 8], ['august', 8],
  ['september', 9], ['sep', 9], ['sept', 9],
  ['oktober', 10], ['okt', 10], ['oct', 10], ['october', 10],
  ['november', 11], ['nov', 11],
  ['desember', 12], ['des', 12], ['dec', 12], ['december', 12],
])

function currentFinancePeriod(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WIB,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const year = parts.find(part => part.type === 'year')?.value
  const month = parts.find(part => part.type === 'month')?.value
  return `${year}-${month}`
}

function shiftFinancePeriod(period: string, offset: number): string {
  const [year, month] = period.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Normalize command/tool input into a YYYY-MM finance period. */
export function normalizeFinancePeriod(period?: string): string {
  const input = period?.trim().toLocaleLowerCase('id-ID').replace(/\s+/g, ' ')
  if (!input) return currentFinancePeriod()
  if (input === 'bulan ini' || input === 'bulan sekarang') return currentFinancePeriod()
  if (input === 'bulan lalu' || input === 'bulan kemarin') return shiftFinancePeriod(currentFinancePeriod(), -1)
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(input)) return input

  const namedMonth = input.match(/^([a-zà-ÿ]+)\s+(\d{4})$/i)
  if (namedMonth) {
    const month = MONTHS.get(namedMonth[1])
    if (month) return `${namedMonth[2]}-${String(month).padStart(2, '0')}`
  }

  throw new Error('Periode tidak valid. Gunakan YYYY-MM atau nama bulan, contoh: Juli 2026.')
}

export function financePeriodRange(period?: string): { period: string; startAt: number; endAt: number } {
  const normalized = normalizeFinancePeriod(period)
  const [year, month] = normalized.split('-').map(Number)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return {
    period: normalized,
    startAt: Date.parse(`${normalized}-01T00:00:00+07:00`),
    endAt: Date.parse(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+07:00`),
  }
}

export function previousFinancePeriod(period?: string): string {
  const { period: value } = financePeriodRange(period)
  return shiftFinancePeriod(value, -1)
}

export function formatFinancePeriodLabel(period: string): string {
  const normalized = normalizeFinancePeriod(period)
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: WIB,
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${normalized}-01T00:00:00+07:00`))
}

export function formatRupiah(amount: number, currency = 'IDR'): string {
  if (currency !== 'IDR') return `${currency} ${amount.toLocaleString('id-ID')}`
  return new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 0,
  }).format(amount)
}

export function formatFinanceTransaction(transaction: FinanceTransactionRecord): string {
  const date = new Intl.DateTimeFormat('id-ID', {
    timeZone: WIB,
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(transaction.occurredAt))
  const type = transaction.type === 'expense' ? 'Pengeluaran'
    : transaction.type === 'income' ? 'Pemasukan' : 'Transfer'
  const merchant = transaction.merchant || transaction.counterpartyAccount || '(belum terbaca)'
  const duplicate = transaction.duplicateOf ? `\nKemungkinan sama dengan: ${transaction.duplicateOf}` : ''
  return [
    `💳 *${type}* · ${transaction.id}`,
    `${formatRupiah(transaction.amount, transaction.currency)} · ${transaction.category}`,
    `${merchant} · ${date} WIB`,
    transaction.account ? `Akun: ${transaction.account}` : '',
    `Sumber: ${transaction.source} · status: ${transaction.status}`,
    transaction.note ? `Catatan: ${transaction.note}` : '',
  ].filter(Boolean).join('\n') + duplicate
}

export function summarizeFinanceRecords(
  period: string,
  transactions: FinanceTransactionRecord[],
  pendingCount: number,
  previousExpense: number,
): FinanceMonthSummary {
  const income = transactions.filter(item => item.type === 'income').reduce((sum, item) => sum + item.amount, 0)
  const expense = transactions.filter(item => item.type === 'expense').reduce((sum, item) => sum + item.amount, 0)
  const transfer = transactions.filter(item => item.type === 'transfer').reduce((sum, item) => sum + item.amount, 0)
  const categories = new Map<string, number>()
  for (const item of transactions.filter(value => value.type === 'expense')) {
    categories.set(item.category, (categories.get(item.category) || 0) + item.amount)
  }
  return {
    period,
    income,
    expense,
    transfer,
    net: income - expense,
    confirmedCount: transactions.length,
    pendingCount,
    categories: [...categories.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
    largestExpenses: transactions.filter(item => item.type === 'expense')
      .sort((a, b) => b.amount - a.amount).slice(0, 5),
    previousExpense,
  }
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export class FinanceService {
  async recordReceipt(buffer: Buffer, hint: string, fallbackAt: number): Promise<FinanceIngestResult> {
    const hash = createHash('sha256').update(buffer).digest('hex')
    const existingImport = botDatabase.getFinanceImport('receipt', hash)
    if (existingImport?.transactionId) {
      return {
        kind: 'duplicate',
        existing: botDatabase.getFinanceTransaction(existingImport.transactionId),
        reason: 'Struk yang sama sudah pernah diproses',
      }
    }
    const claimed = botDatabase.claimFinanceImport('receipt', hash, hash, fallbackAt, true)
    if (!claimed) return { kind: 'duplicate', reason: 'Struk yang sama sedang atau sudah diproses' }

    try {
      const extraction = await aiBridge.extractFinanceTransaction({
        kind: 'receipt', text: hint, imageBuffer: buffer, fallbackAt,
      })
      if (!extraction) {
        botDatabase.completeFinanceImport('receipt', hash, 'failed', undefined, 'vision_failed')
        return { kind: 'failed', reason: 'Vision AI belum bisa membaca struk ini' }
      }
      const draft = normalizeExtraction(extraction, 'receipt', fallbackAt, hint)
      const transaction = this.createWithDedup(draft, 'pending')
      botDatabase.completeFinanceImport('receipt', hash, 'processed', transaction.id)
      return { kind: 'created', transaction }
    } catch (err: any) {
      botDatabase.completeFinanceImport('receipt', hash, 'failed', undefined, 'processing_failed')
      return { kind: 'failed', reason: err.message }
    }
  }

  async recordManual(request: string, fallbackAt = Date.now()): Promise<FinanceIngestResult> {
    const extraction = await aiBridge.extractFinanceTransaction({ kind: 'manual', text: request, fallbackAt })
    const draft = extraction
      ? normalizeExtraction(extraction, 'manual', fallbackAt, request)
      : parseManualFallback(request, fallbackAt)
    const transaction = this.createWithDedup(draft, 'pending')
    return { kind: 'created', transaction }
  }

  async ingestEmail(
    input: FinanceEmailInput,
    retryFailed = false,
    autoConfirmOverride = config.FINANCE_EMAIL_AUTO_CONFIRM,
  ): Promise<FinanceIngestResult> {
    const hash = createHash('sha256').update(`${input.sender}\n${input.subject}\n${input.body}`).digest('hex')
    const existingImport = botDatabase.getFinanceImport('gmail', input.messageId)
    if (existingImport?.transactionId) {
      return {
        kind: 'duplicate',
        existing: botDatabase.getFinanceTransaction(existingImport.transactionId),
        reason: 'Email sudah pernah diproses',
      }
    }
    if (!botDatabase.claimFinanceImport('gmail', input.messageId, hash, input.receivedAt, retryFailed)) {
      return { kind: 'duplicate', reason: 'Email sudah atau sedang diproses' }
    }

    try {
      const parsed = parseBankEmail(input)
      if (parsed.ignoredReason) {
        botDatabase.completeFinanceImport('gmail', input.messageId, 'ignored', undefined, 'bank_rejected')
        return { kind: 'ignored', reason: parsed.ignoredReason }
      }

      let extraction = parsed.extraction
      if (!parsed.deterministic) {
        const aiExtraction = await aiBridge.extractFinanceTransaction({
          kind: 'email',
          text: redactSensitiveText(`${input.subject}\n${input.body}`),
          fallbackAt: input.receivedAt,
        })
        if (aiExtraction) {
          extraction = {
            ...aiExtraction,
            ...parsed.extraction,
            // Bank-labelled values are more reliable than an AI guess. AI may
            // still fill merchant/category fields that the bank template omits,
            // but it must never replace a parsed amount or date.
            type: parsed.extraction?.type || aiExtraction.type,
            amount: parsed.extraction?.amount ?? aiExtraction.amount,
            currency: parsed.extraction?.currency || aiExtraction.currency,
            occurredAt: parsed.extraction?.occurredAt ?? aiExtraction.occurredAt,
            merchant: parsed.extraction?.merchant || aiExtraction.merchant,
            category: parsed.extraction?.category && parsed.extraction.category !== 'Lainnya'
              ? parsed.extraction.category
              : (aiExtraction.category || parsed.extraction?.category),
            account: parsed.extraction?.account || aiExtraction.account,
            counterpartyAccount: parsed.extraction?.counterpartyAccount || aiExtraction.counterpartyAccount,
            note: parsed.extraction?.note || aiExtraction.note,
            confidence: parsed.extraction?.amount !== undefined
              ? parsed.extraction?.confidence
              : aiExtraction.confidence,
          }
        }
      }
      if (!extraction) {
        botDatabase.completeFinanceImport('gmail', input.messageId, 'failed', undefined, 'parse_failed')
        return { kind: 'failed', reason: 'Format email belum dikenali' }
      }

      const draft = normalizeExtraction(
        extraction,
        'email',
        input.receivedAt,
        `${input.subject} ${parsed.bank || ''}`,
      )
      const autoConfirmed = Boolean(
        autoConfirmOverride &&
        input.authenticated &&
        parsed.deterministic &&
        draft.amount > 0 &&
        draft.currency === 'IDR' &&
        draft.confidence >= 0.95
      )
      const transaction = this.createWithDedup(draft, autoConfirmed ? 'confirmed' : 'pending')
      const relatedTransactions: FinanceTransactionRecord[] = []
      if (draft.type === 'transfer' && Number(parsed.feeAmount || 0) > 0) {
        relatedTransactions.push(this.createWithDedup({
          type: 'expense',
          amount: Number(parsed.feeAmount),
          currency: draft.currency,
          occurredAt: draft.occurredAt + 1,
          merchant: `${parsed.bank || draft.account || 'Bank'} Biaya Admin`,
          category: 'Tagihan',
          account: draft.account,
          counterpartyAccount: '',
          note: `Biaya admin untuk transfer ${transaction.id}`,
          source: 'email',
          confidence: draft.confidence,
        }, autoConfirmed ? 'confirmed' : 'pending', false))
      }
      botDatabase.completeFinanceImport('gmail', input.messageId, 'processed', transaction.id)
      return {
        kind: 'created',
        transaction,
        relatedTransactions,
        autoConfirmed: transaction.status === 'confirmed' && relatedTransactions.every(item => item.status === 'confirmed'),
      }
    } catch (err: any) {
      botDatabase.completeFinanceImport('gmail', input.messageId, 'failed', undefined, 'processing_failed')
      return { kind: 'failed', reason: err.message }
    }
  }

  confirm(id: string): { transaction?: FinanceTransactionRecord; error?: string } {
    const transaction = botDatabase.getFinanceTransaction(id)
    if (!transaction) return { error: 'Transaksi tidak ditemukan atau ID ambigu' }
    if (transaction.amount <= 0) return { error: 'Nominal belum valid. Edit transaksi sebelum disimpan.' }
    if (transaction.currency !== 'IDR') return { error: 'Versi awal hanya menjumlahkan IDR. Edit mata uang/nominal lebih dulu.' }
    if (transaction.status === 'pending_duplicate') {
      return { error: 'Pilih Gabungkan atau Simpan terpisah untuk transaksi duplikat.' }
    }
    return { transaction: botDatabase.updateFinanceTransaction(transaction.id, { status: 'confirmed' }) }
  }

  ignore(id: string): FinanceTransactionRecord | undefined {
    return botDatabase.updateFinanceTransaction(id, { status: 'ignored' })
  }

  saveSeparate(id: string): { transaction?: FinanceTransactionRecord; error?: string } {
    const transaction = botDatabase.getFinanceTransaction(id)
    if (!transaction) return { error: 'Transaksi tidak ditemukan atau ID ambigu' }
    if (transaction.amount <= 0) return { error: 'Nominal belum valid.' }
    return {
      transaction: botDatabase.updateFinanceTransaction(transaction.id, {
        status: 'confirmed', duplicateOf: null,
      }),
    }
  }

  merge(id: string): { target?: FinanceTransactionRecord; error?: string } {
    const transaction = botDatabase.getFinanceTransaction(id)
    if (!transaction?.duplicateOf) return { error: 'Pasangan duplikat tidak ditemukan' }
    const target = botDatabase.getFinanceTransaction(transaction.duplicateOf)
    if (!target) return { error: 'Transaksi tujuan tidak ditemukan' }
    if (!botDatabase.mergeFinanceTransaction(transaction.id, target.id)) return { error: 'Gagal menggabungkan transaksi' }
    return { target }
  }

  edit(id: string, input: string): { transaction?: FinanceTransactionRecord; error?: string } {
    const current = botDatabase.getFinanceTransaction(id)
    if (!current) return { error: 'Transaksi tidak ditemukan atau ID ambigu' }
    const patch = this.parseEditPatch(input, current.occurredAt)
    if (Object.keys(patch).length === 0) {
      return { error: 'Tidak ada perubahan. Contoh: nominal=45000 kategori=Transportasi merchant=Gojek' }
    }
    return { transaction: botDatabase.updateFinanceTransaction(current.id, patch) }
  }

  get(id: string): FinanceTransactionRecord | undefined {
    return botDatabase.getFinanceTransaction(id)
  }

  pending(limit = 20): FinanceTransactionRecord[] {
    return botDatabase.listPendingFinanceTransactions(limit)
  }

  /** Confirm non-duplicate email transactions brought in by a manual sync. */
  confirmSyncedEmailTransactions(): string[] {
    const confirmed: string[] = []
    for (const transaction of botDatabase.listPendingFinanceTransactions(5_000)) {
      if (
        transaction.source !== 'email' ||
        transaction.status !== 'pending' ||
        transaction.amount <= 0 ||
        transaction.currency !== 'IDR' ||
        transaction.confidence < 0.95 ||
        transaction.duplicateOf
      ) continue
      const updated = botDatabase.updateFinanceTransaction(transaction.id, { status: 'confirmed' })
      if (updated?.status === 'confirmed') confirmed.push(updated.id)
    }
    return confirmed
  }

  transactions(period?: string, includePending = false, limit = 100): FinanceTransactionRecord[] {
    const range = financePeriodRange(period)
    const statuses: FinanceTransactionStatus[] = includePending
      ? ['confirmed', 'pending', 'pending_duplicate']
      : ['confirmed']
    return botDatabase.listFinanceTransactions(range.startAt, range.endAt, statuses, limit)
  }

  allTransactions(includePending = true, limit = 10_000): FinanceTransactionRecord[] {
    const statuses: FinanceTransactionStatus[] = includePending
      ? ['confirmed', 'pending', 'pending_duplicate']
      : ['confirmed']
    return botDatabase.listFinanceTransactions(0, Date.now() + 100 * 365 * 24 * 60 * 60 * 1000, statuses, limit)
  }

  summary(period?: string): FinanceMonthSummary {
    const range = financePeriodRange(period)
    const transactions = botDatabase.listFinanceTransactions(range.startAt, range.endAt, ['confirmed'], 5_000)
    const pendingCount = botDatabase.listFinanceTransactions(
      range.startAt, range.endAt, ['pending', 'pending_duplicate'], 5_000,
    ).length
    const previousRange = financePeriodRange(previousFinancePeriod(range.period))
    const previousExpense = botDatabase.listFinanceTransactions(previousRange.startAt, previousRange.endAt, ['confirmed'], 5_000)
      .filter(item => item.type === 'expense')
      .reduce((sum, item) => sum + item.amount, 0)
    return summarizeFinanceRecords(range.period, transactions, pendingCount, previousExpense)
  }

  formatSummary(period?: string): string {
    const summary = this.summary(period)
    const comparison = summary.previousExpense > 0
      ? ((summary.expense - summary.previousExpense) / summary.previousExpense) * 100
      : null
    const categoryLines = summary.categories.length
      ? summary.categories.slice(0, 8).map(item => `• ${item.category}: ${formatRupiah(item.amount)}`).join('\n')
      : '• Belum ada pengeluaran terkonfirmasi'
    const largest = summary.largestExpenses.length
      ? summary.largestExpenses.map((item, index) => `${index + 1}. ${item.merchant || item.category} — ${formatRupiah(item.amount)}`).join('\n')
      : 'Belum ada'
    return [
      `📊 *Laporan Keuangan ${summary.period}*`,
      '',
      `Pemasukan: ${formatRupiah(summary.income)}`,
      `Pengeluaran: ${formatRupiah(summary.expense)}`,
      `Arus kas bersih: ${formatRupiah(summary.net)}`,
      `Transfer (tidak dihitung belanja): ${formatRupiah(summary.transfer)}`,
      comparison === null ? 'Perbandingan: belum ada data bulan sebelumnya'
        : `Dibanding bulan lalu: ${comparison >= 0 ? '+' : ''}${comparison.toFixed(1)}%`,
      '',
      '*Per kategori*',
      categoryLines,
      '',
      '*5 pengeluaran terbesar*',
      largest,
      '',
      `Transaksi terkonfirmasi: ${summary.confirmedCount} · pending: ${summary.pendingCount}`,
    ].join('\n')
  }

  async exportCsv(period?: string): Promise<{ filePath: string; fileName: string; count: number }> {
    const range = financePeriodRange(period)
    const transactions = this.transactions(range.period, false, 10_000).sort((a, b) => a.occurredAt - b.occurredAt)
    const header = ['id', 'tanggal_wib', 'jenis', 'nominal', 'mata_uang', 'merchant', 'kategori', 'akun', 'akun_tujuan', 'catatan', 'sumber']
    const rows = transactions.map(item => [
      item.id,
      new Intl.DateTimeFormat('sv-SE', { timeZone: WIB, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(item.occurredAt)),
      item.type,
      item.amount,
      item.currency,
      item.merchant,
      item.category,
      item.account,
      item.counterpartyAccount,
      item.note,
      item.source,
    ].map(csvCell).join(','))
    const fileName = `keuangan-${range.period}.csv`
    const filePath = join(tmpdir(), `${Date.now()}-${fileName}`)
    await writeFile(filePath, `\uFEFF${header.join(',')}\n${rows.join('\n')}\n`, { mode: 0o600 })
    return { filePath, fileName, count: transactions.length }
  }

  private createWithDedup(
    draft: FinanceTransactionDraft,
    desiredStatus: Exclude<FinanceTransactionStatus, 'ignored' | 'pending_duplicate'>,
    allowDedup = true,
  ): FinanceTransactionRecord {
    const candidates = allowDedup && draft.amount > 0
      ? botDatabase.findFinanceCandidates(draft.amount, draft.currency, draft.occurredAt, DAY_MS)
      : []
    const duplicate = candidates.find(candidate => {
      const delta = Math.abs(candidate.occurredAt - draft.occurredAt)
      if (draft.type === 'transfer' && candidate.type === 'transfer' && delta <= 30 * 60_000) return true
      const similarity = merchantSimilarity(candidate.merchant, draft.merchant)
      return similarity >= 0.6 || (!candidate.merchant || !draft.merchant) && delta <= 15 * 60_000
    })
    return botDatabase.createFinanceTransaction(
      draft,
      duplicate ? 'pending_duplicate' : desiredStatus,
      duplicate?.id,
    )
  }

  private parseEditPatch(input: string, fallbackAt: number): FinanceTransactionPatch {
    const patch: FinanceTransactionPatch = {}
    const keyPattern = '(?:nominal|jumlah|kategori|merchant|toko|tanggal|akun|tujuan|catatan|note|jenis|tipe|mata_uang|currency)'
    const regex = new RegExp(`(?:^|\\s)(${keyPattern})=([\\s\\S]*?)(?=\\s+${keyPattern}=|$)`, 'gi')
    for (const match of input.matchAll(regex)) {
      const key = match[1].toLowerCase()
      const value = match[2].trim()
      if (key === 'nominal' || key === 'jumlah') {
        const amount = parseMoney(value)
        if (amount !== null) patch.amount = amount
      } else if (key === 'kategori') {
        patch.category = normalizeCategory(value, value)
      } else if (key === 'merchant' || key === 'toko') {
        patch.merchant = value.slice(0, 160)
      } else if (key === 'tanggal') {
        patch.occurredAt = parseFinanceDate(value, fallbackAt)
      } else if (key === 'akun') {
        patch.account = value.slice(0, 80)
      } else if (key === 'tujuan') {
        patch.counterpartyAccount = value.slice(0, 80)
      } else if (key === 'catatan' || key === 'note') {
        patch.note = value.slice(0, 300)
      } else if (key === 'jenis' || key === 'tipe') {
        patch.type = normalizeTransactionType(value, value)
        if (patch.type === 'transfer') patch.category = 'Transfer'
      } else if (key === 'mata_uang' || key === 'currency') {
        patch.currency = value.toUpperCase().slice(0, 8)
      }
    }
    return patch
  }
}

export const financeService = new FinanceService()

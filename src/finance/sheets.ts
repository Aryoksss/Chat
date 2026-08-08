import { config } from '../system/config.js'
import { GmailReadOnlyClient } from './gmail.js'
import type { FinanceTransactionRecord } from './types.js'

const SHEETS_API = 'https://sheets.googleapis.com/v4'
const DASHBOARD_SHEET = 'Dashboard'
const REVIEW_SHEET = 'Perlu Ditinjau'
const SYSTEM_SHEET = 'Data_System'
const DASHBOARD_DATA_END_ROW = 40

const SYSTEM_HEADER = [
  'ID', 'Tanggal WIB', 'Jenis', 'Nominal', 'Mata Uang', 'Merchant', 'Kategori',
  'Akun', 'Akun Tujuan', 'Catatan', 'Sumber', 'Status', 'Confidence', 'Diperbarui WIB',
]
const TRANSACTION_HEADER = [
  'Tanggal', 'Merchant', 'Kategori', 'Jenis', 'Nominal', 'Mata Uang',
  'Akun', 'Status', 'Sumber', 'Catatan', 'ID Transaksi',
]
const REVIEW_HEADER = [
  'ID Transaksi', 'Tanggal', 'Jenis', 'Nominal', 'Merchant', 'Kategori',
  'Akun', 'Status', 'Sumber', 'Catatan', 'Tindakan',
]

type Color = { red: number; green: number; blue: number }
type CellValue = string | number

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isTransient(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

const COLORS = {
  navy: { red: 0.12, green: 0.31, blue: 0.47 } satisfies Color,
  dark: { red: 0.16, green: 0.20, blue: 0.25 } satisfies Color,
  white: { red: 1, green: 1, blue: 1 } satisfies Color,
  muted: { red: 0.93, green: 0.95, blue: 0.97 } satisfies Color,
  bandOne: { red: 0.97, green: 0.98, blue: 0.99 } satisfies Color,
  bandTwo: { red: 0.91, green: 0.95, blue: 0.98 } satisfies Color,
  confirmed: { red: 0.85, green: 0.92, blue: 0.82 } satisfies Color,
  pending: { red: 1, green: 0.95, blue: 0.80 } satisfies Color,
  duplicate: { red: 0.99, green: 0.89, blue: 0.82 } satisfies Color,
  expense: { red: 0.98, green: 0.89, blue: 0.85 } satisfies Color,
  income: { red: 0.85, green: 0.92, blue: 0.82 } satisfies Color,
  transfer: { red: 0.85, green: 0.92, blue: 0.98 } satisfies Color,
  positive: { red: 0.80, green: 0.93, blue: 0.78 } satisfies Color,
  negative: { red: 0.98, green: 0.85, blue: 0.82 } satisfies Color,
}

const STATUS_TEXT: Record<string, string> = {
  confirmed: 'Terkonfirmasi',
  pending: 'Perlu ditinjau',
  pending_duplicate: 'Kandidat duplikat',
  ignored: 'Diabaikan',
}

const TYPE_TEXT: Record<string, string> = {
  expense: 'Pengeluaran',
  income: 'Pemasukan',
  transfer: 'Transfer',
}

const SOURCE_TEXT: Record<string, string> = {
  email: 'Gmail',
  receipt: 'Struk',
  manual: 'Manual',
}

interface SheetInfo {
  sheetId: number
  title: string
  bandedRangeIds: number[]
  chartIds: number[]
  protectedRangeIds: number[]
}

interface FinanceSummary {
  income: number
  expense: number
  transfer: number
  net: number
  pending: number
  categories: Array<{ category: string; amount: number }>
  largestExpenses: FinanceTransactionRecord[]
}

export interface FinanceSheetSyncResult {
  rowCount: number
  sheetUrl: string
}

function quoteSheetName(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function safeCell(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized
}

function displayCell(value: string, fallback = '—'): string {
  const cleaned = safeCell(value)
  return cleaned || fallback
}

function formatWib(timestamp: number): string {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

function sheetDate(timestamp: number): number {
  // Google Sheets stores numeric dates without a timezone. Shift the serial
  // to the Asia/Jakarta wall clock so DATE()/SUMIFS() month boundaries match
  // the finance ledger's WIB periods.
  return timestamp / 86_400_000 + 25_569 + (7 * 60 * 60 * 1000) / 86_400_000
}

function currentPeriod(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date())
  const year = parts.find(part => part.type === 'year')?.value || '1970'
  const month = parts.find(part => part.type === 'month')?.value || '01'
  return `${year}-${month}`
}

function periodFromTimestamp(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date(timestamp))
  const year = parts.find(part => part.type === 'year')?.value || '1970'
  const month = parts.find(part => part.type === 'month')?.value || '01'
  return `${year}-${month}`
}

function shiftPeriod(period: string, offset: number): string {
  const [year, month] = period.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

function validPeriod(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false
  const [year] = value.split('-').map(Number)
  return year >= 2000 && year <= 2200
}

function periodTextFormula(cell: string): string {
  return `IF(ISNUMBER(${cell});TEXT(${cell};"yyyy-mm");${cell})`
}

function labelType(type: string): string {
  return TYPE_TEXT[type] || type || '—'
}

function labelStatus(status: string): string {
  return STATUS_TEXT[status] || status || '—'
}

function labelSource(source: string): string {
  return SOURCE_TEXT[source] || source || '—'
}

function systemRow(transaction: FinanceTransactionRecord): CellValue[] {
  return [
    safeCell(transaction.id),
    sheetDate(transaction.occurredAt),
    safeCell(transaction.type),
    transaction.amount,
    safeCell(transaction.currency),
    displayCell(transaction.merchant),
    displayCell(transaction.category),
    displayCell(transaction.account),
    displayCell(transaction.counterpartyAccount),
    displayCell(transaction.note),
    safeCell(transaction.source),
    safeCell(transaction.status),
    transaction.confidence,
    sheetDate(transaction.updatedAt),
  ]
}

function transactionRow(transaction: FinanceTransactionRecord): CellValue[] {
  return [
    sheetDate(transaction.occurredAt),
    displayCell(transaction.merchant || transaction.counterpartyAccount),
    displayCell(transaction.category),
    labelType(transaction.type),
    transaction.amount,
    safeCell(transaction.currency),
    displayCell(transaction.account),
    labelStatus(transaction.status),
    labelSource(transaction.source),
    displayCell(transaction.note),
    safeCell(transaction.id),
  ]
}

function reviewRow(transaction: FinanceTransactionRecord): CellValue[] {
  return [
    safeCell(transaction.id),
    sheetDate(transaction.occurredAt),
    labelType(transaction.type),
    transaction.amount > 0 ? transaction.amount : '',
    displayCell(transaction.merchant || transaction.counterpartyAccount),
    displayCell(transaction.category),
    displayCell(transaction.account),
    labelStatus(transaction.status),
    labelSource(transaction.source),
    displayCell(transaction.note, 'Nominal belum terbaca'),
    'Gunakan command WhatsApp',
  ]
}

function summarize(transactions: FinanceTransactionRecord[], period: string): FinanceSummary {
  const confirmed = transactions.filter(item => item.status === 'confirmed' && item.amount > 0 && periodFromTimestamp(item.occurredAt) === period)
  const pending = transactions.filter(item => ['pending', 'pending_duplicate'].includes(item.status) && periodFromTimestamp(item.occurredAt) === period).length
  const income = confirmed.filter(item => item.type === 'income').reduce((sum, item) => sum + item.amount, 0)
  const expenseItems = confirmed.filter(item => item.type === 'expense')
  const transfer = confirmed.filter(item => item.type === 'transfer').reduce((sum, item) => sum + item.amount, 0)
  const categories = new Map<string, number>()
  for (const item of expenseItems) categories.set(item.category || 'Lainnya', (categories.get(item.category || 'Lainnya') || 0) + item.amount)
  return {
    income,
    expense: expenseItems.reduce((sum, item) => sum + item.amount, 0),
    transfer,
    net: income - expenseItems.reduce((sum, item) => sum + item.amount, 0),
    pending,
    categories: [...categories.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((left, right) => right.amount - left.amount),
    largestExpenses: expenseItems.sort((left, right) => right.amount - left.amount).slice(0, 5),
  }
}

function addHeader(requests: unknown[], sheetId: number, endColumnIndex: number, color = COLORS.navy): void {
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex },
      cell: { userEnteredFormat: {
        backgroundColor: color,
        textFormat: { foregroundColor: COLORS.white, bold: true, fontSize: 10 },
        horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE', wrapStrategy: 'WRAP',
      } },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)',
    },
  })
}

function addWidths(requests: unknown[], sheetId: number, widths: number[]): void {
  widths.forEach((pixelSize, index) => requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: index, endIndex: index + 1 },
      properties: { pixelSize }, fields: 'pixelSize',
    },
  }))
}

function addBanding(requests: unknown[], sheet: SheetInfo, rowCount: number, columnCount: number): void {
  for (const bandedRangeId of sheet.bandedRangeIds) requests.push({ deleteBanding: { bandedRangeId } })
  if (rowCount <= 1) return
  requests.push({
    addBanding: { bandedRange: {
      range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: columnCount },
      rowProperties: { firstBandColor: COLORS.bandOne, secondBandColor: COLORS.bandTwo },
    } },
  })
}

function addProtection(requests: unknown[], sheet: SheetInfo, description: string): void {
  if (sheet.protectedRangeIds.length > 0) return
  requests.push({
    addProtectedRange: { protectedRange: {
      range: { sheetId: sheet.sheetId },
      description,
      warningOnly: true,
    } },
  })
}

function addGroupedColor(
  requests: unknown[],
  sheetId: number,
  rows: CellValue[][],
  columnIndex: number,
  styles: Record<string, { backgroundColor: Color; textColor?: Color }>,
): void {
  let start = 0
  while (start < rows.length) {
    const value = String(rows[start]?.[columnIndex] || '')
    let end = start + 1
    while (end < rows.length && String(rows[end]?.[columnIndex] || '') === value) end += 1
    const style = styles[value]
    if (style) requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: start + 1, endRowIndex: end + 1, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
        cell: { userEnteredFormat: {
          backgroundColor: style.backgroundColor,
          ...(style.textColor ? { textFormat: { foregroundColor: style.textColor, bold: true } } : {}),
          horizontalAlignment: 'CENTER',
        } },
        fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment',
      },
    })
    start = end
  }
}

function buildDashboardRows(
  period: string,
  syncedAt: number,
  summary: FinanceSummary,
  trends: Array<{ period: string; income: number; expense: number }>,
): CellValue[][] {
  const rows: CellValue[][] = [
    ['DASHBOARD KEUANGAN', '', '', '', '', '', '', '', '', ''],
    ['Pilih periode (YYYY-MM)', period, 'Terakhir sinkronisasi', formatWib(syncedAt), '', '', '', '', '', ''],
    ['Data dihitung dari transaksi terkonfirmasi. Pending tidak masuk total.', '', '', '', '', '', '', '', '', ''],
    ['METRIK', 'NILAI', '', 'TRANSAKSI TERBESAR', 'NOMINAL', 'KATEGORI', '', '', '', ''],
    ['Pemasukan', summary.income, '', '', '', '', '', '', '', ''],
    ['Pengeluaran', summary.expense, '', '', '', '', '', '', '', ''],
    ['Arus kas bersih', summary.net, '', '', '', '', '', '', '', ''],
    ['Transfer', summary.transfer, '', '', '', '', '', '', '', ''],
    ['Perlu ditinjau', summary.pending, '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', ''],
    ['PENGELUARAN PER KATEGORI', 'NOMINAL', '', '5 TRANSAKSI TERBESAR', 'NOMINAL', 'KATEGORI', '', 'TREN BULANAN', 'PEMASUKAN', 'PENGELUARAN'],
  ]
  const maxRows = Math.max(summary.categories.length, summary.largestExpenses.length, trends.length, 1)
  for (let index = 0; index < maxRows; index += 1) {
    const category = summary.categories[index]
    const largest = summary.largestExpenses[index]
    const trend = trends[index]
    rows.push([
      category?.category || (index === 0 ? 'Belum ada pengeluaran' : ''), category?.amount || (index === 0 ? 0 : ''), '',
      largest?.merchant || (index === 0 ? 'Belum ada' : ''), largest?.amount || (index === 0 ? 0 : ''), largest?.category || '', '',
      trend?.period || '', trend?.income ?? '', trend?.expense ?? '',
    ])
  }
  return rows
}

function periodStartFormula(cell: string): string {
  const text = periodTextFormula(cell)
  return `DATE(VALUE(LEFT(${text};4));VALUE(RIGHT(${text};2));1)`
}

function periodEndFormula(cell: string): string {
  return `EDATE(${periodStartFormula(cell)};1)`
}

function sumFormula(type: string, cell: string): string {
  const start = periodStartFormula(cell)
  const end = periodEndFormula(cell)
  return `=SUMIFS('Data_System'!$D:$D;'Data_System'!$C:$C;"${type}";'Data_System'!$L:$L;"confirmed";'Data_System'!$B:$B;">="&${start};'Data_System'!$B:$B;"<"&${end})`
}

function pendingFormula(cell: string): string {
  const start = periodStartFormula(cell)
  const end = periodEndFormula(cell)
  const range = `'Data_System'!$B:$B`
  return `=COUNTIFS('Data_System'!$L:$L;"pending";${range};">="&${start};${range};"<"&${end})+COUNTIFS('Data_System'!$L:$L;"pending_duplicate";${range};">="&${start};${range};"<"&${end})`
}

function categoryFormula(): string {
  const start = periodStartFormula('$B$2')
  const end = periodEndFormula('$B$2')
  return `=IFERROR(QUERY('Data_System'!A:N;"select G, sum(D) where C = 'expense' and L = 'confirmed' and B >= date '"&TEXT(${start};"yyyy-mm-dd")&"' and B < date '"&TEXT(${end};"yyyy-mm-dd")&"' group by G order by sum(D) desc label G '', sum(D) ''";1);"Belum ada pengeluaran")`
}

function largestExpensesFormula(): string {
  const start = periodStartFormula('$B$2')
  const end = periodEndFormula('$B$2')
  return `=IFERROR(QUERY('Data_System'!A:N;"select F, D, G where C = 'expense' and L = 'confirmed' and B >= date '"&TEXT(${start};"yyyy-mm-dd")&"' and B < date '"&TEXT(${end};"yyyy-mm-dd")&"' order by D desc limit 5 label F '', D '', G ''";1);"Belum ada")`
}

export class FinanceSheetsClient {
  private readonly auth = new GmailReadOnlyClient()

  async syncTransactions(transactions: FinanceTransactionRecord[]): Promise<FinanceSheetSyncResult> {
    const spreadsheetId = config.FINANCE_GOOGLE_SPREADSHEET_ID.trim()
    if (!spreadsheetId) throw new Error('FINANCE_GOOGLE_SPREADSHEET_ID belum diisi')
    const transactionSheetName = config.FINANCE_GOOGLE_SHEET_NAME.trim() || 'Transactions'
    const [dashboard, transactionSheet, reviewSheet, systemSheet] = await Promise.all([
      this.ensureSheet(spreadsheetId, DASHBOARD_SHEET),
      this.ensureSheet(spreadsheetId, transactionSheetName),
      this.ensureSheet(spreadsheetId, REVIEW_SHEET),
      this.ensureSheet(spreadsheetId, SYSTEM_SHEET),
    ])

    const allVisible = transactions.filter(transaction => transaction.status !== 'ignored')
    const visible = allVisible.filter(transaction => transaction.amount > 0).sort((left, right) => right.occurredAt - left.occurredAt)
    const review = allVisible
      .filter(transaction => ['pending', 'pending_duplicate'].includes(transaction.status))
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const selectedPeriod = await this.readDashboardPeriod(spreadsheetId, dashboard)
    const summaries = new Map<string, FinanceSummary>()
    const getSummary = (period: string) => {
      const existing = summaries.get(period)
      if (existing) return existing
      const summary = summarize(allVisible, period)
      summaries.set(period, summary)
      return summary
    }
    const trends = Array.from({ length: 6 }, (_, index) => {
      const trendPeriod = shiftPeriod(selectedPeriod, index - 5)
      const trend = getSummary(trendPeriod)
      return { period: trendPeriod, income: trend.income, expense: trend.expense }
    })
    const dashboardRows = buildDashboardRows(selectedPeriod, Date.now(), getSummary(selectedPeriod), trends)

    await this.writeValues(spreadsheetId, dashboard.title, 'A1:J1000', dashboardRows)
    await this.writeValues(spreadsheetId, transactionSheet.title, 'A:K', [TRANSACTION_HEADER, ...visible.map(transactionRow)])
    await this.writeValues(spreadsheetId, reviewSheet.title, 'A:K', [REVIEW_HEADER, ...review.map(reviewRow)])
    await this.writeValues(spreadsheetId, systemSheet.title, 'A:N', [SYSTEM_HEADER, ...allVisible.sort((left, right) => left.occurredAt - right.occurredAt).map(systemRow)])
    await this.writeDashboardFormulas(spreadsheetId, dashboard.title)

    await this.formatDashboard(spreadsheetId, dashboard, dashboardRows, selectedPeriod, allVisible)
    await this.formatTransactions(spreadsheetId, transactionSheet, visible)
    await this.formatReview(spreadsheetId, reviewSheet, review)
    await this.formatSystem(spreadsheetId, systemSheet, allVisible.length + 1)

    return {
      rowCount: visible.length,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`,
    }
  }

  private async readDashboardPeriod(spreadsheetId: string, dashboard: SheetInfo): Promise<string> {
    try {
      const data = await this.api<{ values?: CellValue[][] }>(
        `/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`${dashboard.title}!B2`)}`,
      )
      const rawValue = data.values?.[0]?.[0]
      if (typeof rawValue === 'number') {
        const numericPeriod = periodFromTimestamp((rawValue - 25_569) * 86_400_000)
        return validPeriod(numericPeriod) ? numericPeriod : currentPeriod()
      }
      const value = String(rawValue || '')
      return validPeriod(value) ? value : currentPeriod()
    } catch {
      return currentPeriod()
    }
  }

  private async writeValues(spreadsheetId: string, sheetName: string, range: string, rows: CellValue[][]): Promise<void> {
    const encodedRange = encodeURIComponent(`${quoteSheetName(sheetName)}!${range}`)
    await this.clearValues(spreadsheetId, sheetName, range)
    await this.api(`/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}?valueInputOption=RAW`, {
      method: 'PUT', body: JSON.stringify({ range: `${quoteSheetName(sheetName)}!${range}`, majorDimension: 'ROWS', values: rows }),
    })
  }

  private async clearValues(spreadsheetId: string, sheetName: string, range: string): Promise<void> {
    const encodedRange = encodeURIComponent(`${quoteSheetName(sheetName)}!${range}`)
    await this.api(`/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}:clear`, { method: 'POST', body: '{}' })
  }

  private async writeDashboardFormulas(spreadsheetId: string, sheetName: string): Promise<void> {
    const put = async (range: string, rows: CellValue[][]) => {
      const encodedRange = encodeURIComponent(`${quoteSheetName(sheetName)}!${range}`)
      await this.api(`/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodedRange}?valueInputOption=USER_ENTERED`, {
        method: 'PUT', body: JSON.stringify({ range: `${quoteSheetName(sheetName)}!${range}`, majorDimension: 'ROWS', values: rows }),
      })
    }
    await put('B5:B9', [
      [sumFormula('income', '$B$2')],
      [sumFormula('expense', '$B$2')],
      ['=B5-B6'],
      [sumFormula('transfer', '$B$2')],
      [pendingFormula('$B$2')],
    ])
    await this.clearValues(spreadsheetId, sheetName, 'A12:B40')
    await put('A12', [[categoryFormula()]])
    await this.clearValues(spreadsheetId, sheetName, 'D12:F18')
    await put('D12', [[largestExpensesFormula()]])
    await this.clearValues(spreadsheetId, sheetName, 'H12:J18')
    const trendRows: CellValue[][] = []
    for (let index = -5; index <= 0; index += 1) {
      const row = 12 + index + 5
      trendRows.push([
        `=TEXT(EDATE(${periodStartFormula('$B$2')};${index});"yyyy-mm")`,
        sumFormula('income', `$H${row}`),
        sumFormula('expense', `$H${row}`),
      ])
    }
    await put('H12:J17', trendRows)
  }

  private async formatDashboard(
    spreadsheetId: string,
    sheet: SheetInfo,
    rows: CellValue[][],
    period: string,
    transactions: FinanceTransactionRecord[],
  ): Promise<void> {
    const requests: unknown[] = sheet.chartIds.map(chartId => ({ deleteEmbeddedObject: { objectId: chartId } }))
    requests.push(
      { updateSpreadsheetProperties: { properties: { timeZone: 'Asia/Jakarta' }, fields: 'timeZone' } },
      { updateSheetProperties: { properties: { sheetId: sheet.sheetId, hidden: false, gridProperties: { frozenRowCount: 2 }, tabColor: COLORS.navy }, fields: 'hidden,gridProperties.frozenRowCount,tabColor' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 10 }, cell: { userEnteredFormat: { backgroundColor: COLORS.navy, textFormat: { foregroundColor: COLORS.white, bold: true, fontSize: 16 }, verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment)' } },
      { updateDimensionProperties: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 42 }, fields: 'pixelSize' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 4 }, cell: { userEnteredFormat: { backgroundColor: COLORS.muted, textFormat: { bold: true } } }, fields: 'userEnteredFormat(backgroundColor,textFormat)' } },
      { setDataValidation: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 2 }, rule: { condition: { type: 'ONE_OF_LIST', values: [...new Set(transactions.map(item => periodFromTimestamp(item.occurredAt))).add(period)].sort().reverse().map(value => ({ userEnteredValue: value })) }, strict: false, showCustomUi: true } } },
    )
    addWidths(requests, sheet.sheetId, [180, 135, 24, 210, 125, 170, 24, 110, 125, 125])
    for (const rowIndex of [3, 10]) {
      requests.push({ repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: rowIndex, endRowIndex: rowIndex + 1, startColumnIndex: 0, endColumnIndex: 10 }, cell: { userEnteredFormat: { backgroundColor: COLORS.dark, textFormat: { foregroundColor: COLORS.white, bold: true }, horizontalAlignment: 'CENTER', wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy)' } })
    }
    requests.push(
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 4, endRowIndex: 8, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '"Rp" #,##0' }, horizontalAlignment: 'RIGHT', textFormat: { bold: true, fontSize: 12 } } }, fields: 'userEnteredFormat(numberFormat,horizontalAlignment,textFormat)' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 11, endRowIndex: DASHBOARD_DATA_END_ROW, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '"Rp" #,##0' }, horizontalAlignment: 'RIGHT' } }, fields: 'userEnteredFormat(numberFormat,horizontalAlignment)' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 11, endRowIndex: 18, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '"Rp" #,##0' }, horizontalAlignment: 'RIGHT' } }, fields: 'userEnteredFormat(numberFormat,horizontalAlignment)' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 11, endRowIndex: 18, startColumnIndex: 8, endColumnIndex: 10 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '"Rp" #,##0' }, horizontalAlignment: 'RIGHT' } }, fields: 'userEnteredFormat(numberFormat,horizontalAlignment)' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { backgroundColor: COLORS.negative } }, fields: 'userEnteredFormat.backgroundColor' } },
    )
    const periods = Array.from({ length: 6 }, (_, index) => shiftPeriod(period, index - 5))
    const trendStart = 11
    const categoryStart = 11
    const categoryEnd = DASHBOARD_DATA_END_ROW
    const trendEnd = trendStart + periods.length + 1
    const categoryChart = {
      addChart: { chart: {
        spec: {
          title: 'Pengeluaran per kategori',
          pieChart: {
            legendPosition: 'RIGHT_LEGEND',
            domain: { sourceRange: { sources: [{ sheetId: sheet.sheetId, startRowIndex: 10, endRowIndex: categoryEnd, startColumnIndex: 0, endColumnIndex: 1 }] } },
            series: { sourceRange: { sources: [{ sheetId: sheet.sheetId, startRowIndex: 10, endRowIndex: categoryEnd, startColumnIndex: 1, endColumnIndex: 2 }] } },
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId: sheet.sheetId, rowIndex: 1, columnIndex: 11 }, widthPixels: 500, heightPixels: 300 } },
      } },
    }
    const trendChart = {
      addChart: { chart: {
        spec: {
          title: 'Tren pemasukan dan pengeluaran',
          basicChart: {
            chartType: 'LINE',
            legendPosition: 'BOTTOM_LEGEND',
            domains: [{ domain: { sourceRange: { sources: [{ sheetId: sheet.sheetId, startRowIndex: 10, endRowIndex: trendEnd, startColumnIndex: 7, endColumnIndex: 8 }] } } }],
            series: [
              { series: { sourceRange: { sources: [{ sheetId: sheet.sheetId, startRowIndex: 10, endRowIndex: trendEnd, startColumnIndex: 8, endColumnIndex: 9 }] } } },
              { series: { sourceRange: { sources: [{ sheetId: sheet.sheetId, startRowIndex: 10, endRowIndex: trendEnd, startColumnIndex: 9, endColumnIndex: 10 }] } } },
            ],
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId: sheet.sheetId, rowIndex: 18, columnIndex: 11 }, widthPixels: 500, heightPixels: 300 } },
      } },
    }
    requests.push(categoryChart, trendChart)
  
    await this.api(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) })
  }

  private async formatTransactions(spreadsheetId: string, sheet: SheetInfo, transactions: FinanceTransactionRecord[]): Promise<void> {
    const rows = transactions.map(transactionRow)
    const requests: unknown[] = []
    addHeader(requests, sheet.sheetId, TRANSACTION_HEADER.length)
    addBanding(requests, sheet, rows.length + 1, TRANSACTION_HEADER.length)
    addWidths(requests, sheet.sheetId, [145, 220, 150, 125, 130, 95, 165, 150, 90, 300, 125])
    requests.push(
      { updateSheetProperties: { properties: { sheetId: sheet.sheetId, hidden: false, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 }, tabColor: COLORS.transfer }, fields: 'hidden,gridProperties.frozenRowCount,gridProperties.frozenColumnCount,tabColor' } },
      { setBasicFilter: { filter: { range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: Math.max(rows.length + 1, 1), startColumnIndex: 0, endColumnIndex: TRANSACTION_HEADER.length } } } },
      ...(rows.length > 1 ? [{ sortRange: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 0, endColumnIndex: TRANSACTION_HEADER.length }, sortSpecs: [{ dimensionIndex: 0, sortOrder: 'DESCENDING' }] } }] : []),
      { updateDimensionProperties: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 36 }, fields: 'pixelSize' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 0, endColumnIndex: TRANSACTION_HEADER.length }, cell: { userEnteredFormat: { verticalAlignment: 'MIDDLE' } }, fields: 'userEnteredFormat.verticalAlignment' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd mmm yyyy hh:mm' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 4, endColumnIndex: 5 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '"Rp" #,##0' }, horizontalAlignment: 'RIGHT' } }, fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment' } },
    )
    addGroupedColor(requests, sheet.sheetId, rows, 3, { [TYPE_TEXT.expense]: { backgroundColor: COLORS.expense }, [TYPE_TEXT.income]: { backgroundColor: COLORS.income }, [TYPE_TEXT.transfer]: { backgroundColor: COLORS.transfer } })
    addGroupedColor(requests, sheet.sheetId, rows, 7, { [STATUS_TEXT.confirmed]: { backgroundColor: COLORS.confirmed, textColor: COLORS.dark }, [STATUS_TEXT.pending]: { backgroundColor: COLORS.pending, textColor: COLORS.dark }, [STATUS_TEXT.pending_duplicate]: { backgroundColor: COLORS.duplicate, textColor: COLORS.dark } })
    addProtection(requests, sheet, 'Tabel transaksi dikelola oleh BotWa; ubah melalui bot agar tidak tertimpa sinkronisasi.')
    await this.api(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) })
  }

  private async formatReview(spreadsheetId: string, sheet: SheetInfo, transactions: FinanceTransactionRecord[]): Promise<void> {
    const rows = transactions.map(reviewRow)
    const requests: unknown[] = []
    addHeader(requests, sheet.sheetId, REVIEW_HEADER.length, COLORS.dark)
    addBanding(requests, sheet, rows.length + 1, REVIEW_HEADER.length)
    addWidths(requests, sheet.sheetId, [125, 145, 125, 130, 220, 150, 165, 160, 90, 300, 190])
    requests.push(
      { updateSheetProperties: { properties: { sheetId: sheet.sheetId, hidden: false, gridProperties: { frozenRowCount: 1 }, tabColor: COLORS.pending }, fields: 'hidden,gridProperties.frozenRowCount,tabColor' } },
      { setBasicFilter: { filter: { range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: Math.max(rows.length + 1, 1), startColumnIndex: 0, endColumnIndex: REVIEW_HEADER.length } } } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd mmm yyyy hh:mm' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: rows.length + 1, startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '"Rp" #,##0' }, horizontalAlignment: 'RIGHT' } }, fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment' } },
    )
    addGroupedColor(requests, sheet.sheetId, rows, 7, { [STATUS_TEXT.pending]: { backgroundColor: COLORS.pending, textColor: COLORS.dark }, [STATUS_TEXT.pending_duplicate]: { backgroundColor: COLORS.duplicate, textColor: COLORS.dark } })
    await this.api(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) })
  }

  private async formatSystem(spreadsheetId: string, sheet: SheetInfo, rowCount: number): Promise<void> {
    const requests: unknown[] = []
    addHeader(requests, sheet.sheetId, SYSTEM_HEADER.length, COLORS.dark)
    addWidths(requests, sheet.sheetId, [125, 145, 100, 130, 90, 220, 150, 150, 150, 300, 90, 140, 100, 145])
    requests.push(
      { updateSheetProperties: { properties: { sheetId: sheet.sheetId, hidden: true, gridProperties: { frozenRowCount: 1 } }, fields: 'hidden,gridProperties.frozenRowCount' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount, 1), startColumnIndex: 1, endColumnIndex: 2 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd mmm yyyy hh:mm' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount, 1), startColumnIndex: 3, endColumnIndex: 4 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '"Rp" #,##0' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount, 1), startColumnIndex: 12, endColumnIndex: 13 }, cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.00' } } }, fields: 'userEnteredFormat.numberFormat' } },
      { repeatCell: { range: { sheetId: sheet.sheetId, startRowIndex: 1, endRowIndex: Math.max(rowCount, 1), startColumnIndex: 13, endColumnIndex: 14 }, cell: { userEnteredFormat: { numberFormat: { type: 'DATE_TIME', pattern: 'dd mmm yyyy hh:mm' } } }, fields: 'userEnteredFormat.numberFormat' } },
    )
    addProtection(requests, sheet, 'Data internal BotWa; jangan diedit manual.')
    await this.api(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests }) })
  }

  private async ensureSheet(spreadsheetId: string, sheetName: string): Promise<SheetInfo> {
    const metadata = await this.api<{ sheets?: Array<{
      properties?: { title?: string; sheetId?: number }
      bandedRanges?: Array<{ bandedRangeId?: number }>
      charts?: Array<{ chartId?: number }>
      protectedRanges?: Array<{ protectedRangeId?: number }>
    }> }>(`/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties,sheets.bandedRanges.bandedRangeId,sheets.charts.chartId,sheets.protectedRanges.protectedRangeId`)
    const existing = metadata.sheets?.find(sheet => sheet.properties?.title === sheetName)
    if (existing?.properties?.sheetId !== undefined) return {
      sheetId: existing.properties.sheetId,
      title: sheetName,
      bandedRangeIds: (existing.bandedRanges || []).map(item => item.bandedRangeId).filter((id): id is number => id !== undefined),
      chartIds: (existing.charts || []).map(item => item.chartId).filter((id): id is number => id !== undefined),
      protectedRangeIds: (existing.protectedRanges || []).map(item => item.protectedRangeId).filter((id): id is number => id !== undefined),
    }
    const created = await this.api<{ replies?: Array<{ addSheet?: { properties?: { sheetId?: number } } }> }>(`/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetName } } }] }),
    })
    const sheetId = created.replies?.[0]?.addSheet?.properties?.sheetId
    if (sheetId === undefined) throw new Error(`Gagal membuat tab Google Sheets "${sheetName}"`)
    return { sheetId, title: sheetName, bandedRangeIds: [], chartIds: [], protectedRangeIds: [] }
  }

  private async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.auth.getGoogleAccessToken()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${SHEETS_API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
        signal: AbortSignal.timeout(30_000),
      })
      if (response.ok) {
        if (response.status === 204) return undefined as T
        return response.json() as Promise<T>
      }
      const detail = (await response.text()).slice(0, 300)
      if (!isTransient(response.status) || attempt === 2) {
        throw new Error(`Google Sheets API ${response.status}: ${detail}`)
      }
      await sleep(500 * (attempt + 1))
    }
    throw new Error('Google Sheets API gagal setelah retry')
  }
}

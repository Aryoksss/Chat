import { chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { formatFinancePeriodLabel, formatRupiah } from './service.js'
import type { FinanceMonthSummary, FinanceTransactionRecord } from './types.js'

const WIDTH = 1080
const MIN_HEIGHT = 1350
const CATEGORY_Y = 460
const CATEGORY_ROW_START = CATEGORY_Y + 160
const CATEGORY_ROW_HEIGHT = 62
const LARGEST_ROW_HEIGHT = 54

export interface FinanceReportImage {
  filePath: string
  fileName: string
}

function escapeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function truncate(value: string, maxLength: number): string {
  const text = value.trim() || 'Tidak diketahui'
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

function rupiah(value: number): string {
  return formatRupiah(value).replace(/\u00a0/g, ' ')
}

function text(
  value: string,
  x: number,
  y: number,
  size: number,
  color = '#F8FAFC',
  weight = 400,
  anchor: 'start' | 'middle' | 'end' = 'start',
): string {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, Helvetica, sans-serif" font-size="${size}px" font-weight="${weight}" text-anchor="${anchor}">${escapeXml(value)}</text>`
}

function card(x: number, y: number, width: number, title: string, amount: string, color: string): string {
  return [
    `<rect x="${x}" y="${y}" width="${width}" height="150" rx="24" fill="#1F2937"/>`,
    `<rect x="${x}" y="${y}" width="8" height="150" rx="4" fill="${color}"/>`,
    text(title, x + 28, y + 43, 22, '#CBD5E1', 600),
    text(amount, x + 28, y + 102, 30, '#F8FAFC', 700),
  ].join('')
}

function categoryRows(summary: FinanceMonthSummary): string {
  const categories = summary.categories.slice(0, 8)
  if (categories.length === 0) return text('Belum ada pengeluaran terkonfirmasi', 72, CATEGORY_ROW_START, 24, '#94A3B8')

  const maxAmount = Math.max(...categories.map(item => item.amount), 1)
  return categories.map((item, index) => {
    const y = CATEGORY_ROW_START + index * CATEGORY_ROW_HEIGHT
    const barWidth = Math.max(8, Math.round((item.amount / maxAmount) * 430))
    return [
      text(truncate(item.category, 24), 72, y, 22, '#E2E8F0', 600),
      text(rupiah(item.amount), 1008, y, 20, '#CBD5E1', 600, 'end'),
      `<rect x="72" y="${y + 14}" width="430" height="12" rx="6" fill="#334155" opacity="0.55"/>`,
      `<rect x="72" y="${y + 14}" width="${barWidth}" height="12" rx="6" fill="#F97316"/>`,
    ].join('')
  }).join('')
}

function largestRows(summary: FinanceMonthSummary, rowStart: number): string {
  const expenses = summary.largestExpenses.slice(0, 5)
  if (expenses.length === 0) return text('Belum ada transaksi', 72, rowStart, 24, '#94A3B8')

  return expenses.map((item: FinanceTransactionRecord, index) => {
    const y = rowStart + index * LARGEST_ROW_HEIGHT
    const merchant = truncate(item.merchant || item.category, 30)
    return [
      text(`${index + 1}`, 76, y, 22, '#FB923C', 700),
      text(merchant, 116, y, 22, '#E2E8F0', 600),
      text(rupiah(item.amount), 1008, y, 20, '#CBD5E1', 600, 'end'),
    ].join('')
  }).join('')
}

function buildSvg(summary: FinanceMonthSummary): string {
  const label = formatFinancePeriodLabel(summary.period)
  const empty = summary.confirmedCount === 0
  const categorySlots = Math.max(1, Math.min(summary.categories.length, 8))
  const categoryHeight = 150 + categorySlots * CATEGORY_ROW_HEIGHT
  const largestY = CATEGORY_Y + categoryHeight + 40
  const largestHeight = 100 + 5 * LARGEST_ROW_HEIGHT + 20
  const largestRowStart = largestY + 100
  const footerY = largestY + largestHeight + 38
  const height = Math.max(MIN_HEIGHT, footerY + 50)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
  <rect width="${WIDTH}" height="${height}" fill="#0F172A"/>
  <circle cx="970" cy="80" r="180" fill="#F97316" opacity="0.08"/>
  <circle cx="1040" cy="260" r="120" fill="#38BDF8" opacity="0.06"/>
  ${text('LAPORAN KEUANGAN', 72, 92, 30, '#FB923C', 700)}
  ${text(label, 72, 150, 52, '#F8FAFC', 700)}
  ${text('Ringkasan transaksi terkonfirmasi · IDR · WIB', 72, 194, 22, '#94A3B8', 400)}

  ${card(72, 250, 296, 'PEMASUKAN', rupiah(summary.income), '#22C55E')}
  ${card(392, 250, 296, 'PENGELUARAN', rupiah(summary.expense), '#F97316')}
  ${card(712, 250, 296, 'ARUS KAS BERSIH', rupiah(summary.net), '#38BDF8')}

  <rect x="48" y="${CATEGORY_Y}" width="984" height="${categoryHeight}" rx="28" fill="#111827" stroke="#1E293B" stroke-width="2"/>
  ${text('PENGELUARAN PER KATEGORI', 72, 520, 26, '#F8FAFC', 700)}
  ${categoryRows(summary)}

  <rect x="48" y="${largestY}" width="984" height="${largestHeight}" rx="28" fill="#111827" stroke="#1E293B" stroke-width="2"/>
  ${text('5 PENGELUARAN TERBESAR', 72, largestY + 50, 26, '#F8FAFC', 700)}
  ${largestRows(summary, largestRowStart)}

  <line x1="72" y1="${footerY}" x2="1008" y2="${footerY}" stroke="#334155" stroke-width="2"/>
  ${text(empty ? 'Belum ada transaksi terkonfirmasi' : `${summary.confirmedCount} transaksi terkonfirmasi · ${summary.pendingCount} pending`, 72, footerY + 39, 20, '#94A3B8', 500)}
</svg>`
}

export async function renderFinanceReportImage(summary: FinanceMonthSummary): Promise<FinanceReportImage> {
  const fileName = `keuangan-${summary.period}.png`
  const filePath = join(tmpdir(), `finance-report-${summary.period}-${randomUUID()}.png`)
  await sharp(Buffer.from(buildSvg(summary))).png().toFile(filePath)
  await chmod(filePath, 0o600)
  return { filePath, fileName }
}

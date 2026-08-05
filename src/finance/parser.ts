import type {
  FinanceEmailInput,
  FinanceExtraction,
  FinanceTransactionDraft,
  FinanceTransactionType,
} from './types.js'

export const FINANCE_CATEGORIES = [
  'Makanan & Minuman',
  'Transportasi',
  'Belanja',
  'Tagihan',
  'Kesehatan',
  'Pendidikan',
  'Hiburan',
  'Perjalanan',
  'Rumah Tangga',
  'Pendapatan',
  'Transfer',
  'Lainnya',
] as const

const CATEGORY_RULES: Array<[RegExp, string]> = [
  [/\b(makan|minum|resto|restaurant|cafe|coffee|kopi|food|gofood|grabfood|shopeefood|warung|warmindo|kedai|bakso)\b/i, 'Makanan & Minuman'],
  [/\b(gojek|grab|taxi|taksi|transport|bensin|pertamina|shell|parkir|tol|kereta|bus)\b/i, 'Transportasi'],
  [/\b(shop|store|belanja|tokopedia|shopee|lazada|blibli|mall|marketplace)\b/i, 'Belanja'],
  [/\b(tagihan|listrik|pln|internet|wifi|telkom|pulsa|paket data|air|pdam|insurance|asuransi)\b/i, 'Tagihan'],
  [/\b(apotek|dokter|rumah sakit|hospital|klinik|obat|health)\b/i, 'Kesehatan'],
  [/\b(sekolah|kampus|kuliah|course|kursus|buku|education|pendidikan)\b/i, 'Pendidikan'],
  [/\b(netflix|spotify|steam|game|bioskop|cinema|hiburan|entertainment)\b/i, 'Hiburan'],
  [/\b(hotel|flight|pesawat|travel|villa|penginapan|tiket)\b/i, 'Perjalanan'],
  [/\b(rumah|furniture|perabot|laundry|household|supermarket|minimarket|indomaret|alfamart|sembako)\b/i, 'Rumah Tangga'],
  [/\b(gaji|salary|pendapatan|income|bonus|honor)\b/i, 'Pendapatan'],
  [/\b(transfer|kirim uang|pemindahbukuan)\b/i, 'Transfer'],
]

const MONTHS: Record<string, number> = {
  januari: 0, january: 0, jan: 0,
  februari: 1, february: 1, feb: 1,
  maret: 2, march: 2, mar: 2,
  april: 3, apr: 3,
  mei: 4, may: 4,
  juni: 5, june: 5, jun: 5,
  juli: 6, july: 6, jul: 6,
  agustus: 7, august: 7, agu: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  oktober: 9, october: 9, okt: 9, oct: 9,
  november: 10, nov: 10,
  desember: 11, december: 11, des: 11, dec: 11,
}

function cleanText(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

export function clampConfidence(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback
}

export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null
  }
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  if (!raw) return null

  const multiplier = /(?:rb|ribu|k)\s*$/.test(raw)
    ? 1_000
    : /(?:jt|juta|m)\s*$/.test(raw) ? 1_000_000 : 1
  let numeric = raw
    .replace(/(?:rp|idr)/gi, '')
    .replace(/\s+/g, '')
    .replace(/(?:rb|ribu|jt|juta|k|m)$/i, '')

  if (multiplier > 1 && /^\d+(?:[,.]\d+)?$/.test(numeric)) {
    const compact = Number(numeric.replace(',', '.'))
    return Number.isFinite(compact) ? Math.round(compact * multiplier) : null
  }

  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(numeric)) {
    numeric = numeric.replace(/\./g, '').replace(/,\d{1,2}$/, '')
  } else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(numeric)) {
    numeric = numeric.replace(/,/g, '').replace(/\.\d{1,2}$/, '')
  } else if (/^\d+[,.]\d{1,2}$/.test(numeric) && multiplier === 1) {
    numeric = numeric.replace(/[,.]\d{1,2}$/, '')
  } else {
    numeric = numeric.replace(/[^\d]/g, '')
  }

  const parsed = Number(numeric)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.round(parsed * multiplier)
}

export function parseFinanceDate(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== 'string' || !value.trim()) return fallback
  const text = value.trim().toLowerCase()

  const numeric = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:\s+(\d{1,2})[:.](\d{2})(?::(\d{2}))?)?\b/)
  if (numeric) {
    const year = Number(numeric[3]) + (numeric[3].length === 2 ? 2000 : 0)
    const iso = `${year}-${numeric[2].padStart(2, '0')}-${numeric[1].padStart(2, '0')}T${(numeric[4] || '00').padStart(2, '0')}:${numeric[5] || '00'}:${numeric[6] || '00'}+07:00`
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }

  const named = text.match(/\b(\d{1,2})\s+([a-z]+)\s+(\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?\b/)
  if (named && MONTHS[named[2]] !== undefined) {
    const iso = `${named[3]}-${String(MONTHS[named[2]] + 1).padStart(2, '0')}-${named[1].padStart(2, '0')}T${(named[4] || '00').padStart(2, '0')}:${named[5] || '00'}:00+07:00`
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return parsed
  }

  const direct = Date.parse(value)
  return Number.isFinite(direct) ? direct : fallback
}

export function normalizeCategory(value: unknown, context = ''): string {
  const supplied = cleanText(value, 80)
  if (supplied) {
    const exact = FINANCE_CATEGORIES.find(category => category.toLocaleLowerCase('id-ID') === supplied.toLocaleLowerCase('id-ID'))
    if (exact) return exact
  }
  const haystack = `${supplied} ${context}`
  return CATEGORY_RULES.find(([pattern]) => pattern.test(haystack))?.[1] || 'Lainnya'
}

export function normalizeTransactionType(value: unknown, context = ''): FinanceTransactionType {
  const raw = `${typeof value === 'string' ? value : ''} ${context}`.toLowerCase()
  if (/\b(transfer|pemindahbukuan|kirim uang|top ?up antar rekening)\b/.test(raw)) return 'transfer'
  if (/\b(income|pemasukan|masuk|diterima|received|gaji|salary|refund|pengembalian)\b/.test(raw)) return 'income'
  return 'expense'
}

export function normalizeExtraction(
  extraction: FinanceExtraction,
  source: FinanceTransactionDraft['source'],
  fallbackAt: number,
  context = '',
): FinanceTransactionDraft {
  const merchant = cleanText(redactSensitiveText(cleanText(extraction.merchant, 160)), 160)
  const type = normalizeTransactionType(extraction.type, `${context} ${extraction.note || ''}`)
  return {
    type,
    amount: parseMoney(extraction.amount) ?? 0,
    currency: cleanText(extraction.currency, 8).toUpperCase() || 'IDR',
    occurredAt: parseFinanceDate(extraction.occurredAt, fallbackAt),
    merchant,
    category: type === 'transfer'
      ? 'Transfer'
      : normalizeCategory(extraction.category, `${merchant} ${context}`),
    account: maskAccount(cleanText(extraction.account, 80)),
    counterpartyAccount: maskAccount(cleanText(extraction.counterpartyAccount, 80)),
    note: cleanText(redactSensitiveText(cleanText(extraction.note, 300)), 300),
    source,
    confidence: clampConfidence(extraction.confidence, source === 'manual' ? 0.8 : 0.5),
  }
}

function cleanLabelValue(value: string): string {
  return value
    .replace(/^\s*(?::\s*)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
}

function labelValue(body: string, labels: string[]): string {
  const escaped = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const pattern = new RegExp(`^\\s*(?:${escaped})\\s*(?::\\s*)?(.*)$`, 'i')
  const lines = body.split(/\n+/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern)
    if (!match) continue
    const sameLine = cleanLabelValue(match[1] || '')
    if (sameLine && !/^[:\-]+$/.test(sameLine)) return sameLine
    const nextLine = cleanLabelValue(lines[index + 1] || '')
    if (nextLine && !/^[:\-]+$/.test(nextLine)) return nextLine
  }
  return ''
}

function parseLabeledAmount(body: string, labels?: string[]): number | null {
  const candidates = labels || [
    'nominal tujuan', 'nominal tagihan', 'total bayar', 'nominal', 'jumlah', 'amount',
    'total', 'nilai transaksi', 'transaction amount',
  ]
  for (const label of candidates) {
    const fromLabel = parseMoney(labelValue(body, [label]))
    if (fromLabel !== null) return fromLabel
  }
  const inline = body.match(/(?:nominal|jumlah|amount|total|nilai transaksi)[^\n\d]{0,30}(?:(?:rp|idr)\s*)?([\d.,]+)/i)
  return parseMoney(inline?.[1])
}

export interface BankEmailParseResult {
  extraction?: FinanceExtraction
  bank?: 'BCA' | 'blu'
  deterministic: boolean
  ignoredReason?: string
  feeAmount?: number
}

export function parseBankEmail(input: FinanceEmailInput): BankEmailParseResult {
  const combined = `${input.subject}\n${input.body}`
  if (/\b(gagal|failed|dibatalkan|cancelled|ditolak|declined)\b/i.test(combined)) {
    return { deterministic: true, ignoredReason: 'Transaksi gagal atau dibatalkan' }
  }

  const bank = /\b(blu|bca digital)\b/i.test(`${input.sender} ${combined}`)
    ? 'blu'
    : /\bbca\b/i.test(`${input.sender} ${combined}`) ? 'BCA' : undefined
  if (!bank) return { deterministic: false }

  const dateText = labelValue(input.body, ['tanggal transaksi', 'transaction date', 'tanggal', 'waktu transaksi', 'waktu', 'date'])
  const transferText = labelValue(input.body, ['jenis transfer', 'transaction type', 'type', 'layanan transfer'])
  const paymentMerchant = labelValue(input.body, [
    'pembayaran ke', 'nama merchant', 'merchant', 'penerima', 'tujuan transfer', 'keterangan', 'description',
  ])
  const bankTarget = labelValue(input.body, ['bank tujuan', 'tujuan transaksi'])
  const account = labelValue(input.body, ['sumber dana', 'rekening sumber', 'dari rekening', 'account', 'rekening'])
  const counterparty = labelValue(input.body, ['no rekening tujuan', 'rekening tujuan', 'ke rekening', 'penerima', 'tujuan transfer'])
  const hasTransferMarker = /\b(transfer|pemindahan dana|bi.fast|bi fast)\b/i.test(`${combined} ${transferText}`)
  const type = normalizeTransactionType('', `${combined} ${transferText}`)
  const amount = parseLabeledAmount(input.body, type === 'transfer'
    ? ['nominal tujuan', 'nominal transfer', 'nominal', 'amount', 'jumlah', 'nilai transaksi', 'transaction amount', 'total']
    : ['total bayar', 'total', 'nominal tagihan', 'nominal', 'amount', 'jumlah', 'nilai transaksi', 'transaction amount'])
  const feeAmount = parseMoney(labelValue(input.body, ['biaya admin', 'admin fee', 'biaya transaksi', 'biaya', 'fee'])) ?? 0
  const feeOffset = /(?:offset|rewards|cashback|dibebaskan|gratis|free)/i.test(combined)
  const merchant = paymentMerchant || (type === 'transfer' ? bankTarget : '')
  const hasPaymentMarker = Boolean(paymentMerchant) || /\b(pembayaran|purchase|debit|kredit|total bayar|nominal tagihan)\b/i.test(combined)
  const hasTransactionMarker = /\b(transaksi|transaction|pembayaran|purchase|transfer|debit|kredit)\b/i.test(combined)
  // blu receipts often omit a separate date/merchant label, but their
  // labelled amount and transaction marker are still authoritative. BCA
  // templates retain the stricter date/evidence requirements below.
  const complete = amount !== null && hasTransactionMarker && (
    Boolean(dateText) && (Boolean(merchant) || hasPaymentMarker || hasTransferMarker)
    || bank === 'blu'
  )
  const context = `${input.subject} ${merchant} ${bankTarget} ${combined.slice(0, 600)}`
  const transferAmount = amount

  return {
    bank,
    deterministic: complete,
    extraction: {
      type,
      amount: transferAmount ?? undefined,
      currency: /\b(?:usd|sgd|eur|jpy)\b/i.exec(combined)?.[0]?.toUpperCase() || 'IDR',
      occurredAt: dateText ? parseFinanceDate(dateText, input.receivedAt) : input.receivedAt,
      merchant: merchant || (type === 'transfer' ? counterparty : ''),
      category: normalizeCategory('', context),
      account: account ? `${bank} ${maskAccount(account)}`.trim() : bank,
      counterpartyAccount: maskAccount(counterparty),
      note: cleanText(redactSensitiveText(input.subject), 200),
      confidence: complete ? 0.96 : amount !== null ? 0.72 : 0.45,
    },
    feeAmount: feeOffset ? 0 : feeAmount,
  }
}

export function maskAccount(value: string): string {
  return value.replace(/\d(?=\d{4})/g, '•').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/\b\d{10,19}\b/g, match => `${'•'.repeat(Math.max(4, match.length - 4))}${match.slice(-4)}`)
    .replace(/\b(?:ref(?:erensi)?|reference|trace|rrn)\s*[:#-]?\s*[a-z0-9-]{6,}\b/gi, '[REFERENSI DISAMARKAN]')
    .slice(0, 8_000)
}

export function parseManualFallback(request: string, fallbackAt: number): FinanceTransactionDraft {
  const withoutDates = request.replace(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}(?:\s+\d{1,2}[:.]\d{2})?\b/g, ' ')
  const amounts = [...withoutDates.matchAll(/(?:rp\s*)?\d[\d.,]*(?:\s*(?:rb|ribu|jt|juta|k|m))?/gi)]
    .map(match => parseMoney(match[0]))
    .filter((amount): amount is number => amount !== null)
  const amount = amounts.length > 0 ? Math.max(...amounts) : 0
  const accountMatch = request.match(/(?:pakai|dari|ke)\s+(bca|blu|cash|tunai|gopay|ovo|dana|shopeepay)\b/i)
  const merchantMatch = request.match(/(?:di|ke|dari)\s+([^,]+?)(?=\s+(?:pakai|seharga|sebesar|rp\s*\d)|$)/i)
  const type = normalizeTransactionType('', request)
  return normalizeExtraction({
    type,
    amount,
    merchant: merchantMatch?.[1] || '',
    category: normalizeCategory('', request),
    account: accountMatch?.[1] || '',
    note: request,
    confidence: amount > 0 ? 0.72 : 0.3,
  }, 'manual', fallbackAt, request)
}

export function normalizeMerchant(value: string): string {
  return value
    .toLocaleLowerCase('id-ID')
    .replace(/\b(pt|cv|tbk|store|merchant|official)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function merchantSimilarity(a: string, b: string): number {
  const left = new Set(normalizeMerchant(a).split(/\s+/).filter(Boolean))
  const right = new Set(normalizeMerchant(b).split(/\s+/).filter(Boolean))
  if (left.size === 0 || right.size === 0) return 0
  const intersection = [...left].filter(token => right.has(token)).length
  const union = new Set([...left, ...right]).size
  return union > 0 ? intersection / union : 0
}

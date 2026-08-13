import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { access, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { BotDatabase } from '../src/storage/database.js'
import {
  merchantSimilarity,
  normalizeExtraction,
  parseBankEmail,
  parseFinanceDate,
  parseManualFallback,
  parseMoney,
  redactSensitiveText,
} from '../src/finance/parser.js'
import { decodeGmailMessage, htmlToFinanceText } from '../src/finance/gmail.js'
import { FinanceCommandHandler } from '../src/finance/commands.js'
import { renderFinanceReportImage } from '../src/finance/report-image.js'
import { handleFinance } from '../src/tools/handlers/finance.js'
import { config } from '../src/system/config.js'
import {
  financePeriodRange,
  normalizeFinancePeriod,
  summarizeFinanceRecords,
} from '../src/finance/service.js'

test('finance parser handles Indonesian money, dates, and manual records', () => {
  assert.equal(parseMoney('Rp 125.000,00'), 125_000)
  assert.equal(parseMoney('35rb'), 35_000)
  assert.equal(parseMoney('1,5jt'), 1_500_000)
  assert.equal(
    parseFinanceDate('04/08/2026 13:45', 0),
    Date.parse('2026-08-04T13:45:00+07:00'),
  )
  const manual = parseManualFallback('makan 35000 di Solaria pakai BCA', Date.now())
  assert.equal(manual.amount, 35_000)
  assert.equal(manual.category, 'Makanan & Minuman')
  assert.equal(manual.account.toLowerCase(), 'bca')
  assert.equal(manual.merchant, 'Solaria')
  assert.equal(parseManualFallback('04/08/2026 beli obat 1500', Date.now()).amount, 1_500)
})

test('bank parser recognizes redacted BCA and blu transaction templates', () => {
  const bca = parseBankEmail({
    messageId: 'bca-1',
    sender: 'notification@example-bca.test',
    subject: 'Notifikasi Transaksi BCA',
    body: [
      'Jenis Transaksi: Pembayaran',
      'Nominal: Rp 125.000,00',
      'Tanggal Transaksi: 04/08/2026 13:45',
      'Nama Merchant: TOKO CONTOH',
      'Sumber Dana: 1234567890',
    ].join('\n'),
    receivedAt: Date.now(),
    authenticated: true,
  })
  assert.equal(bca.bank, 'BCA')
  assert.equal(bca.deterministic, true)
  assert.equal(bca.extraction?.amount, 125_000)
  assert.equal(bca.extraction?.merchant, 'TOKO CONTOH')
  assert.match(bca.extraction?.account || '', /•+7890/)

  const blu = parseBankEmail({
    messageId: 'blu-1',
    sender: 'notification@example-blu.test',
    subject: 'blu - Transaksi berhasil',
    body: [
      'Transaction: Transfer',
      'Amount: IDR 50.000',
      'Admin Fee: IDR 2.500',
      'Transaction Date: 4 August 2026 14:00',
      'Penerima: PENERIMA CONTOH',
    ].join('\n'),
    receivedAt: Date.now(),
    authenticated: true,
  })
  assert.equal(blu.bank, 'blu')
  assert.equal(blu.extraction?.type, 'transfer')
  assert.equal(blu.extraction?.amount, 50_000)
  assert.equal(blu.feeAmount, 2_500)

  const failed = parseBankEmail({
    messageId: 'failed', sender: 'notification@example-bca.test', subject: 'BCA transaksi gagal',
    body: 'Nominal: Rp 1.000', receivedAt: Date.now(), authenticated: true,
  })
  assert.match(failed.ignoredReason || '', /gagal/i)
})

test('bank parser preserves labelled amounts from real BCA/blu layouts', () => {
  const bcaPayment = parseBankEmail({
    messageId: 'bca-internet-payment',
    sender: 'bca@bca.co.id',
    subject: 'Internet Transaction Journal',
    body: [
      'Tanggal Transaksi: : : 02 Jul 2026 11:52:20',
      'Nominal: : : IDR 200,000.00',
      'Biaya Admin: : : IDR 1,000.00',
      'Total Bayar: : : IDR 201,000.00',
    ].join('\n'),
    receivedAt: Date.now(),
    authenticated: true,
  })
  assert.equal(bcaPayment.deterministic, true)
  assert.equal(bcaPayment.extraction?.type, 'expense')
  assert.equal(bcaPayment.extraction?.amount, 201_000)

  const bcaTransfer = parseBankEmail({
    messageId: 'bca-internet-transfer',
    sender: 'bca@bca.co.id',
    subject: 'Internet Transaction Journal',
    body: [
      'Tanggal Transaksi: : : 07 Jun 2026 01:44:16',
      'Jenis Transfer: : : Transfer ke BLU BY BCA DIGITAL',
      'Dari Rekening: : : 6975xxxx80',
      'Bank Tujuan: : : BLU BY BCA DIGITAL',
      'Nominal: : : IDR 600,000.00',
      'Biaya: : : IDR 2,500.00',
    ].join('\n'),
    receivedAt: Date.now(),
    authenticated: true,
  })
  assert.equal(bcaTransfer.deterministic, true)
  assert.equal(bcaTransfer.extraction?.type, 'transfer')
  assert.equal(bcaTransfer.extraction?.amount, 600_000)
  assert.equal(bcaTransfer.extraction?.merchant, 'BLU BY BCA DIGITAL')
  assert.equal(bcaTransfer.feeAmount, 2_500)

  const bluRefundOffset = parseBankEmail({
    messageId: 'blu-offset',
    sender: 'receipts@blubybcadigital.id',
    subject: 'Transaksimu Pakai blu Berhasil',
    body: [
      'Transaction: Transfer',
      'Nominal Transfer',
      'Rp 5.000 ,00',
      'Biaya Admin',
      ': Rp 2.500,00',
      'bluRewards Rp 2.500,00',
    ].join('\n'),
    receivedAt: Date.now(),
    authenticated: true,
  })
  assert.equal(bluRefundOffset.extraction?.amount, 5_000)
  assert.equal(bluRefundOffset.feeAmount, 0)
})

test('finance normalization redacts sensitive values and detects merchant similarity', () => {
  const fallback = Date.now()
  const draft = normalizeExtraction({
    type: 'expense', amount: 45_000, merchant: 'PT Gojek Indonesia', category: '', confidence: 2,
  }, 'receipt', fallback, 'transport gojek')
  assert.equal(draft.category, 'Transportasi')
  assert.equal(draft.confidence, 1)
  assert.ok(merchantSimilarity('PT Gojek Indonesia', 'GOJEK') >= 0.5)
  const redacted = redactSensitiveText('rekening 123456789012 ref: ABCDEF123456')
  assert.doesNotMatch(redacted, /123456789012/)
  assert.match(redacted, /REFERENSI DISAMARKAN/)
})

test('Gmail MIME decoding prefers plain text and verifies authentication headers', () => {
  const encoded = (value: string) => Buffer.from(value).toString('base64url')
  const decoded = decodeGmailMessage({
    id: 'gmail-1',
    internalDate: String(Date.parse('2026-08-04T10:00:00+07:00')),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Bank Example <notify@bank.test>' },
        { name: 'Subject', value: 'Transaksi' },
        { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@bank.test; dmarc=pass' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: encoded('Nominal: Rp 10.000') } },
        { mimeType: 'text/html', body: { data: encoded('<b>fallback</b>') } },
      ],
    },
  })
  assert.equal(decoded.sender, 'notify@bank.test')
  assert.equal(decoded.authenticated, true)
  assert.equal(decoded.body, 'Nominal: Rp 10.000')
  assert.equal(htmlToFinanceText('<table><tr><td>Nominal</td><td>Rp 10.000</td></tr></table>'), 'Nominal: Rp 10.000')
})

test('finance database persists ledger, imports, candidates, and report idempotency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-finance-db-'))
  const db = new BotDatabase(join(dir, 'finance.db'))
  try {
    const occurredAt = Date.parse('2026-08-04T12:00:00+07:00')
    const transaction = db.createFinanceTransaction({
      type: 'expense', amount: 25_000, currency: 'IDR', occurredAt,
      merchant: 'Kedai Contoh', category: 'Makanan & Minuman', account: 'BCA',
      counterpartyAccount: '', note: '', source: 'email', confidence: 0.96,
    }, 'confirmed')
    assert.equal(db.listFinanceTransactions(occurredAt - 1, occurredAt + 1)[0].id, transaction.id)
    assert.equal(db.findFinanceCandidates(25_000, 'IDR', occurredAt + 60_000, 24 * 60 * 60_000).length, 1)

    assert.equal(db.claimFinanceImport('gmail', 'message-1', 'hash', occurredAt), true)
    assert.equal(db.claimFinanceImport('gmail', 'message-1', 'hash', occurredAt), false)
    db.completeFinanceImport('gmail', 'message-1', 'processed', transaction.id)
    assert.equal(db.getFinanceImport('gmail', 'message-1')?.transactionId, transaction.id)

    assert.equal(db.claimFinanceReport('2026-07'), true)
    db.completeFinanceReport('2026-07')
    assert.equal(db.claimFinanceReport('2026-07'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('monthly summary excludes transfers and pending records from spending', () => {
  const base = {
    currency: 'IDR', occurredAt: Date.now(), merchant: '', category: 'Lainnya', account: '',
    counterpartyAccount: '', note: '', source: 'manual' as const, status: 'confirmed' as const,
    confidence: 1, createdAt: Date.now(), updatedAt: Date.now(),
  }
  const summary = summarizeFinanceRecords('2026-08', [
    { ...base, id: 'expense', type: 'expense', amount: 100_000 },
    { ...base, id: 'income', type: 'income', amount: 250_000 },
    { ...base, id: 'transfer', type: 'transfer', amount: 500_000, category: 'Transfer' },
  ], 2, 80_000)
  assert.equal(summary.expense, 100_000)
  assert.equal(summary.income, 250_000)
  assert.equal(summary.transfer, 500_000)
  assert.equal(summary.net, 150_000)
  assert.equal(summary.pendingCount, 2)
})

test('finance period parser accepts Indonesian month names and rejects invalid input', () => {
  assert.equal(normalizeFinancePeriod('2026-07'), '2026-07')
  assert.equal(normalizeFinancePeriod('Juli 2026'), '2026-07')
  assert.equal(normalizeFinancePeriod('July 2026'), '2026-07')
  assert.equal(financePeriodRange('Juli 2026').period, '2026-07')
  assert.throws(() => normalizeFinancePeriod('Juli 26'), /Periode tidak valid/)
  assert.throws(() => normalizeFinancePeriod('bulan fiksi 2026'), /Periode tidak valid/)
})

test('finance report renderer creates a private portrait PNG and supports empty reports', async () => {
  const summary = summarizeFinanceRecords('2026-07', [], 0, 0)
  const image = await renderFinanceReportImage(summary)
  try {
    const metadata = await sharp(image.filePath).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, 1080)
    assert.equal(metadata.height, 1350)
    assert.equal(image.fileName, 'keuangan-2026-07.png')
    assert.equal(statSync(image.filePath).mode & 0o777, 0o600)
  } finally {
    await unlink(image.filePath).catch(() => {})
  }
})

test('finance report renderer expands for long category lists', async () => {
  const base = {
    currency: 'IDR', occurredAt: Date.now(), merchant: 'Toko', account: '',
    counterpartyAccount: '', note: '', source: 'manual' as const, status: 'confirmed' as const,
    confidence: 1, createdAt: Date.now(), updatedAt: Date.now(), type: 'expense' as const,
  }
  const records = Array.from({ length: 8 }, (_, index) => ({
    ...base, id: `category-${index}`, amount: (index + 1) * 10_000,
    category: `Kategori ${index + 1}`,
  }))
  const image = await renderFinanceReportImage(summarizeFinanceRecords('2026-07', records, 0, 0))
  try {
    const metadata = await sharp(image.filePath).metadata()
    assert.equal(metadata.width, 1080)
    assert.ok((metadata.height || 0) > 1350)
  } finally {
    await unlink(image.filePath).catch(() => {})
  }
})

test('owner .laporan accepts Juli 2026, sends image and text, then cleans temporary image', async () => {
  const sentFiles: string[] = []
  const sentTexts: string[] = []
  const fakeClient = {
    sendFile: async (_jid: string, filePath: string, fileType: string) => {
      assert.equal(fileType, 'image')
      sentFiles.push(filePath)
      await access(filePath)
      return true
    },
    sendText: async (_jid: string, text: string) => {
      sentTexts.push(text)
      return true
    },
  } as any
  const owner = config.OWNER_LID || config.OWNER_NUMBER
  const handled = await new FinanceCommandHandler().handle({
    jid: `${owner}@s.whatsapp.net`,
    sender: owner,
    text: '.laporan Juli 2026',
    messageType: 'text',
    hasMedia: false,
    isGroup: false,
    isBotMentioned: false,
    isReplyToBot: false,
    raw: {},
  } as any, fakeClient)

  assert.equal(handled, true)
  assert.equal(sentFiles.length, 1)
  assert.match(sentTexts[0] || '', /2026-07/)
  await assert.rejects(stat(sentFiles[0]))
})

test('finance tool summary returns report image and keeps its text response', async () => {
  const owner = config.OWNER_LID || config.OWNER_NUMBER
  const result = await handleFinance(
    { action: 'summary', period: 'Juli 2026' },
    { jid: `${owner}@s.whatsapp.net`, sock: {} } as any,
  )
  assert.equal(result.success, true)
  assert.equal(result.fileType, 'image')
  assert.equal(result.preserveTextResponse, true)
  assert.match(result.text || '', /2026-07/)
  if (result.filePath) await unlink(result.filePath).catch(() => {})
})

test('interrupted finance imports become retryable after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-finance-restart-'))
  const file = join(dir, 'finance.db')
  let db = new BotDatabase(file)
  try {
    assert.equal(db.claimFinanceImport('gmail', 'interrupted', 'hash', Date.now()), true)
    db.close()
    db = new BotDatabase(file)
    assert.equal(db.getFinanceImport('gmail', 'interrupted')?.status, 'failed')
    assert.equal(db.claimFinanceImport('gmail', 'interrupted', 'hash', Date.now(), true), true)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finance commands silently ignore groups before touching private ledger', async () => {
  const handler = new FinanceCommandHandler()
  const messages: string[] = []
  const handled = await handler.handle({
    jid: 'group@g.us', sender: 'someone', text: '.keuangan', messageType: 'text', hasMedia: false,
    isGroup: true, isBotMentioned: true, isReplyToBot: false, raw: {},
  } as any, {
    sendText: async (_jid: string, text: string) => { messages.push(text); return true },
  } as any)
  assert.equal(handled, true)
  assert.equal(messages.length, 0)
})

test('finance guard does not swallow non-finance group commands', async () => {
  const handler = new FinanceCommandHandler()
  const messages: string[] = []
  const handled = await handler.handle({
    jid: 'group@g.us', sender: 'someone', text: '/s', messageType: 'text', hasMedia: false,
    isGroup: true, isBotMentioned: true, isReplyToBot: true, raw: {},
  } as any, {
    sendText: async (_jid: string, text: string) => { messages.push(text); return true },
  } as any)
  assert.equal(handled, false)
  assert.equal(messages.length, 0)
})

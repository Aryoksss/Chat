import { GmailReadOnlyClient } from '../src/finance/gmail.js'
import { parseBankEmail, normalizeExtraction } from '../src/finance/parser.js'
import { botDatabase } from '../src/storage/database.js'

/**
 * Repairs historical email rows that were confirmed by the old blanket-sync
 * behavior. It only promotes rows when the bank parser is now deterministic;
 * ambiguous rows are moved back to pending for owner review.
 */
const database = botDatabase as typeof botDatabase & {
  db: { prepare(sql: string): { all(...params: unknown[]): any[] } }
}

const rows = database.db.prepare(`
  SELECT t.id, i.external_id
  FROM finance_transactions t
  JOIN finance_imports i ON i.transaction_id=t.id AND i.source='gmail'
  WHERE t.source='email' AND (
    (t.status='confirmed' AND t.confidence < 0.95)
    OR t.status='pending'
    OR t.amount <= 0
  )
  ORDER BY t.occurred_at
`).all()

const gmail = new GmailReadOnlyClient()
let corrected = 0
let movedToPending = 0
let ignoredOffsetFees = 0
const correctedIds: string[] = []
const reviewIds: string[] = []

for (const row of rows) {
  const email = await gmail.getMessage(String(row.external_id))
  const parsed = parseBankEmail(email)
  if (parsed.deterministic && Number(parsed.extraction?.amount || 0) > 0) {
    const draft = normalizeExtraction(
      parsed.extraction,
      'email',
      email.receivedAt,
      `${email.subject} ${parsed.bank || ''}`,
    )
    const current = botDatabase.getFinanceTransaction(String(row.id))
    botDatabase.updateFinanceTransaction(String(row.id), {
      type: draft.type,
      amount: draft.amount,
      currency: draft.currency,
      occurredAt: draft.occurredAt,
      merchant: draft.merchant || current?.merchant,
      category: draft.category !== 'Lainnya' ? draft.category : current?.category,
      account: draft.account || current?.account,
      counterpartyAccount: draft.counterpartyAccount || current?.counterpartyAccount,
      note: draft.note || current?.note,
      status: 'confirmed',
      confidence: draft.confidence,
    })
    corrected += 1
    correctedIds.push(String(row.id))

    const feeRows = database.db.prepare(
      `SELECT id FROM finance_transactions WHERE source='email' AND note LIKE ?`,
    ).all(`%${String(row.id)}%`)
    if (parsed.feeAmount === 0) {
      for (const fee of feeRows) {
        botDatabase.updateFinanceTransaction(String(fee.id), { status: 'ignored' })
        ignoredOffsetFees += 1
      }
    }
  } else {
    botDatabase.updateFinanceTransaction(String(row.id), { status: 'pending' })
    movedToPending += 1
    reviewIds.push(String(row.id))
  }
}

const feeRows = database.db.prepare(`
  SELECT id, note
  FROM finance_transactions
  WHERE source='email' AND lower(note) LIKE '%biaya admin%'
`).all()
for (const fee of feeRows) {
  const transferId = String(fee.note || '').match(/transfer\s+([a-z0-9]+)/i)?.[1]
  if (!transferId) continue
  const transfer = botDatabase.getFinanceTransaction(transferId)
  if (transfer && /(?:offset|dikompensasi|rewards|cashback|dibebaskan)/i.test(transfer.note)) {
    const updated = botDatabase.updateFinanceTransaction(String(fee.id), { status: 'ignored' })
    if (updated?.status === 'ignored') ignoredOffsetFees += 1
  }
}

console.log(JSON.stringify({
  inspected: rows.length,
  corrected,
  movedToPending,
  ignoredOffsetFees,
  correctedIds,
  reviewIds,
}))

export type FinanceTransactionType = 'expense' | 'income' | 'transfer'

export type FinanceTransactionStatus =
  | 'pending'
  | 'confirmed'
  | 'pending_duplicate'
  | 'ignored'

export type FinanceTransactionSource = 'receipt' | 'email' | 'manual'

export interface FinanceTransactionDraft {
  type: FinanceTransactionType
  amount: number
  currency: string
  occurredAt: number
  merchant: string
  category: string
  account: string
  counterpartyAccount: string
  note: string
  source: FinanceTransactionSource
  confidence: number
}

export interface FinanceTransactionRecord extends FinanceTransactionDraft {
  id: string
  status: FinanceTransactionStatus
  duplicateOf?: string
  createdAt: number
  updatedAt: number
}

export interface FinanceTransactionPatch {
  type?: FinanceTransactionType
  amount?: number
  currency?: string
  occurredAt?: number
  merchant?: string
  category?: string
  account?: string
  counterpartyAccount?: string
  note?: string
  status?: FinanceTransactionStatus
  confidence?: number
  duplicateOf?: string | null
}

export type FinanceImportSource = 'gmail' | 'receipt'
export type FinanceImportStatus = 'processing' | 'processed' | 'ignored' | 'failed'

export interface FinanceImportRecord {
  source: FinanceImportSource
  externalId: string
  contentHash: string
  status: FinanceImportStatus
  transactionId?: string
  errorCode?: string
  receivedAt: number
  processedAt?: number
}

export interface FinanceExtraction {
  type?: FinanceTransactionType
  amount?: number
  currency?: string
  occurredAt?: number
  merchant?: string
  category?: string
  account?: string
  counterpartyAccount?: string
  note?: string
  confidence?: number
}

export interface FinanceEmailInput {
  messageId: string
  sender: string
  subject: string
  body: string
  receivedAt: number
  authenticated: boolean
}

export interface FinanceIngestResult {
  kind: 'created' | 'duplicate' | 'ignored' | 'failed'
  transaction?: FinanceTransactionRecord
  existing?: FinanceTransactionRecord
  relatedTransactions?: FinanceTransactionRecord[]
  reason?: string
  autoConfirmed?: boolean
}

export interface FinanceMonthSummary {
  period: string
  income: number
  expense: number
  transfer: number
  net: number
  confirmedCount: number
  pendingCount: number
  categories: Array<{ category: string; amount: number }>
  largestExpenses: FinanceTransactionRecord[]
  previousExpense: number
}

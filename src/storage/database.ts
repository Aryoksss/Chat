import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../system/config.js'
import type {
  FinanceImportRecord,
  FinanceImportSource,
  FinanceImportStatus,
  FinanceTransactionDraft,
  FinanceTransactionPatch,
  FinanceTransactionRecord,
  FinanceTransactionStatus,
} from '../finance/types.js'

export type MediaJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface MemberRecord {
  groupJid: string
  memberJid: string
  normalizedId: string
  displayName: string
  messageCount: number
  lastMessage: string
  lastSeenAt: number
}

export interface MediaJobRecord {
  id: string
  jid: string
  sender: string
  tool: string
  status: MediaJobStatus
  createdAt: number
  updatedAt: number
  error?: string
}

export interface ReminderRecord {
  id: string
  jid: string
  sender: string
  task: string
  dueAt: number
  recurrence?: string
  mentions: string[]
  status: 'active' | 'processing' | 'done' | 'cancelled'
  createdAt: number
}

function rowValue<T>(row: unknown, key: string): T {
  return row && typeof row === 'object' ? (row as Record<string, T>)[key] : undefined as T
}

export class BotDatabase {
  private db: DatabaseSync

  constructor(file = config.DATABASE_FILE) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_jid TEXT NOT NULL,
        member_jid TEXT NOT NULL,
        normalized_id TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        custom_name TEXT NOT NULL DEFAULT '',
        message_count INTEGER NOT NULL DEFAULT 0,
        last_message TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (group_jid, member_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_members_group_seen ON group_members(group_jid, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS outgoing_messages (
        jid TEXT NOT NULL,
        message_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (jid, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_outgoing_created ON outgoing_messages(created_at);

      CREATE TABLE IF NOT EXISTS sticker_usage (
        jid TEXT NOT NULL,
        file TEXT NOT NULL,
        used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sticker_usage ON sticker_usage(jid, used_at DESC);

      CREATE TABLE IF NOT EXISTS media_jobs (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        tool TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_media_jobs_jid ON media_jobs(jid, created_at DESC);

      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        task TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        recurrence TEXT NOT NULL DEFAULT '',
        mentions TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);

      CREATE TABLE IF NOT EXISTS owner_greeting_runs (
        greeting_date TEXT NOT NULL,
        period TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing',
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        PRIMARY KEY (greeting_date, period)
      );

      CREATE TABLE IF NOT EXISTS tool_contexts (
        jid TEXT NOT NULL,
        tool TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (jid, tool)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_contexts_updated ON tool_contexts(updated_at);

      CREATE TABLE IF NOT EXISTS finance_transactions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'IDR',
        occurred_at INTEGER NOT NULL,
        merchant TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT 'Lainnya',
        account TEXT NOT NULL DEFAULT '',
        counterparty_account TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        confidence REAL NOT NULL DEFAULT 0,
        duplicate_of TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (duplicate_of) REFERENCES finance_transactions(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_finance_period ON finance_transactions(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_finance_status ON finance_transactions(status, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS finance_imports (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'processing',
        transaction_id TEXT,
        error_code TEXT NOT NULL DEFAULT '',
        received_at INTEGER NOT NULL,
        processed_at INTEGER,
        PRIMARY KEY (source, external_id),
        FOREIGN KEY (transaction_id) REFERENCES finance_transactions(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_finance_import_transaction ON finance_imports(transaction_id);

      CREATE TABLE IF NOT EXISTS finance_sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_report_runs (
        period TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'processing',
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      );
    `)
    const memberColumns = this.db.prepare('PRAGMA table_info(group_members)').all()
      .map(row => rowValue<string>(row, 'name'))
    if (!memberColumns.includes('custom_name')) {
      this.db.exec(`ALTER TABLE group_members ADD COLUMN custom_name TEXT NOT NULL DEFAULT ''`)
    }
    const reminderColumns = this.db.prepare('PRAGMA table_info(reminders)').all()
      .map(row => rowValue<string>(row, 'name'))
    if (!reminderColumns.includes('mentions')) {
      this.db.exec(`ALTER TABLE reminders ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'`)
    }
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    this.db.prepare('DELETE FROM outgoing_messages WHERE created_at < ?').run(cutoff)
    this.db.prepare(`UPDATE media_jobs SET status='failed', error='Bot restart sebelum job selesai', updated_at=? WHERE status IN ('queued','running')`).run(Date.now())
    this.db.prepare(`UPDATE reminders SET status='active' WHERE status='processing'`).run()
    this.db.prepare(`DELETE FROM owner_greeting_runs WHERE status='processing'`).run()
    this.db.prepare(`DELETE FROM owner_greeting_runs WHERE created_at < ?`).run(Date.now() - 60 * 24 * 60 * 60 * 1000)
    this.db.prepare(`UPDATE finance_report_runs SET status='failed' WHERE status='processing'`).run()
    this.db.prepare(`UPDATE finance_imports SET status='failed', error_code='interrupted' WHERE status='processing'`).run()
    this.db.prepare('DELETE FROM tool_contexts WHERE updated_at < ?').run(Date.now() - 24 * 60 * 60 * 1000)
  }

  upsertMember(groupJid: string, memberJid: string, displayName: string, message: string, countMessage = true): void {
    const now = Date.now()
    const normalized = memberJid.replace(/[^0-9]/g, '')
    this.db.prepare(`
      INSERT INTO group_members(group_jid, member_jid, normalized_id, display_name, message_count, last_message, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_jid, member_jid) DO UPDATE SET
        normalized_id=excluded.normalized_id,
        display_name=CASE WHEN excluded.display_name <> '' THEN excluded.display_name ELSE group_members.display_name END,
        message_count=group_members.message_count + excluded.message_count,
        last_message=excluded.last_message,
        last_seen_at=excluded.last_seen_at
    `).run(groupJid, memberJid, normalized, displayName.trim().slice(0, 100), countMessage ? 1 : 0, message.trim().slice(0, 300), now, now)
  }

  listMembers(groupJid: string, limit = 40): MemberRecord[] {
    const rows = this.db.prepare(`
      SELECT group_jid, member_jid, normalized_id,
             COALESCE(NULLIF(custom_name, ''), display_name) AS effective_name,
             message_count, last_message, last_seen_at
      FROM group_members WHERE group_jid=? ORDER BY last_seen_at DESC LIMIT ?
    `).all(groupJid, limit)
    return rows.map(row => ({
      groupJid: rowValue<string>(row, 'group_jid'),
      memberJid: rowValue<string>(row, 'member_jid'),
      normalizedId: rowValue<string>(row, 'normalized_id'),
      displayName: rowValue<string>(row, 'effective_name'),
      messageCount: Number(rowValue<number>(row, 'message_count')),
      lastMessage: rowValue<string>(row, 'last_message'),
      lastSeenAt: Number(rowValue<number>(row, 'last_seen_at')),
    }))
  }

  findMembers(groupJid: string, query: string, limit = 10): MemberRecord[] {
    const clean = query.replace(/^@/, '').trim().toLocaleLowerCase('id-ID')
    if (!clean) return this.listMembers(groupJid, limit)
    const digits = clean.replace(/[^0-9]/g, '')
    return this.listMembers(groupJid, 200).filter(member =>
      (digits.length > 0 && member.normalizedId.includes(digits)) ||
      member.displayName.toLocaleLowerCase('id-ID').includes(clean)
    ).slice(0, limit)
  }

  setMemberName(groupJid: string, memberJid: string, displayName: string): void {
    this.upsertMember(groupJid, memberJid, '', '[nama panggilan diperbarui]', false)
    this.db.prepare('UPDATE group_members SET custom_name=?, last_seen_at=? WHERE group_jid=? AND member_jid=?')
      .run(displayName.trim().slice(0, 40), Date.now(), groupJid, memberJid)
  }

  memberContext(groupJid: string, limit = 25): string {
    const members = this.listMembers(groupJid, Math.max(limit * 2, 50)).filter(member => member.displayName).slice(0, limit)
    if (members.length === 0) return ''
    return members.map(member => {
      return `- ${member.displayName}: @${member.normalizedId} (aktif ${member.messageCount} pesan)`
    }).join('\n')
  }

  rememberOutgoing(jid: string, messageId: string, messageType: string): void {
    if (!jid || !messageId) return
    this.db.prepare(`INSERT OR REPLACE INTO outgoing_messages(jid, message_id, message_type, created_at) VALUES (?, ?, ?, ?)`)
      .run(jid, messageId, messageType, Date.now())
  }

  isOutgoing(jid: string, messageId?: string | null): boolean {
    if (!messageId) return false
    return Boolean(this.db.prepare('SELECT 1 FROM outgoing_messages WHERE jid=? AND message_id=?').get(jid, messageId))
  }

  recordStickerUsage(jid: string, file: string): void {
    this.db.prepare('INSERT INTO sticker_usage(jid, file, used_at) VALUES (?, ?, ?)').run(jid, file, Date.now())
    this.db.prepare(`DELETE FROM sticker_usage WHERE rowid IN (
      SELECT rowid FROM sticker_usage WHERE jid=? ORDER BY used_at DESC LIMIT -1 OFFSET 30
    )`).run(jid)
  }

  recentStickerFiles(jid: string, limit = 5): string[] {
    return this.db.prepare('SELECT file FROM sticker_usage WHERE jid=? ORDER BY used_at DESC LIMIT ?').all(jid, limit)
      .map(row => rowValue<string>(row, 'file'))
  }

  createMediaJob(jid: string, sender: string, tool: string, status: MediaJobStatus = 'running'): MediaJobRecord {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    const now = Date.now()
    this.db.prepare(`INSERT INTO media_jobs(id,jid,sender,tool,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, jid, sender, tool, status, now, now)
    return { id, jid, sender, tool, status, createdAt: now, updatedAt: now }
  }

  updateMediaJob(id: string, status: MediaJobStatus, error = ''): void {
    this.db.prepare('UPDATE media_jobs SET status=?, error=?, updated_at=? WHERE id=?').run(status, error.slice(0, 500), Date.now(), id)
  }

  isMediaJobCancelled(id: string): boolean {
    const row = this.db.prepare('SELECT status FROM media_jobs WHERE id=?').get(id)
    return rowValue<string | undefined>(row, 'status') === 'cancelled'
  }

  mediaJobStatus(id: string): MediaJobStatus | undefined {
    return rowValue<MediaJobStatus | undefined>(this.db.prepare('SELECT status FROM media_jobs WHERE id=?').get(id), 'status')
  }

  cancelMediaJobs(jid: string, sender: string, id?: string): number {
    const result = id
      ? this.db.prepare(`UPDATE media_jobs SET status='cancelled', updated_at=? WHERE jid=? AND sender=? AND id LIKE ? AND status IN ('queued','running')`).run(Date.now(), jid, sender, `${id}%`)
      : this.db.prepare(`UPDATE media_jobs SET status='cancelled', updated_at=? WHERE jid=? AND sender=? AND status IN ('queued','running')`).run(Date.now(), jid, sender)
    return Number(result.changes)
  }

  listMediaJobs(jid: string, limit = 8): MediaJobRecord[] {
    return this.db.prepare('SELECT * FROM media_jobs WHERE jid=? ORDER BY created_at DESC LIMIT ?').all(jid, limit).map(row => ({
      id: rowValue<string>(row, 'id'), jid: rowValue<string>(row, 'jid'), sender: rowValue<string>(row, 'sender'),
      tool: rowValue<string>(row, 'tool'), status: rowValue<MediaJobStatus>(row, 'status'),
      createdAt: Number(rowValue<number>(row, 'created_at')), updatedAt: Number(rowValue<number>(row, 'updated_at')),
      error: rowValue<string>(row, 'error') || undefined,
    }))
  }

  createReminder(jid: string, sender: string, task: string, dueAt: number, recurrence = '', mentions: string[] = []): ReminderRecord {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    const now = Date.now()
    const normalizedMentions = Array.from(new Set(mentions
      .map(value => String(value).trim())
      .filter(value => value.includes('@')))).slice(0, 20)
    this.db.prepare(`INSERT INTO reminders(id,jid,sender,task,due_at,recurrence,mentions,status,created_at) VALUES(?,?,?,?,?,?,?,'active',?)`)
      .run(id, jid, sender, task, dueAt, recurrence, JSON.stringify(normalizedMentions), now)
    return { id, jid, sender, task, dueAt, recurrence: recurrence || undefined, mentions: normalizedMentions, status: 'active', createdAt: now }
  }

  listReminders(jid: string, limit = 20): ReminderRecord[] {
    return this.db.prepare(`SELECT * FROM reminders WHERE jid=? AND status IN ('active','processing') ORDER BY due_at LIMIT ?`).all(jid, limit)
      .map(row => this.mapReminder(row))
  }

  dueReminders(now = Date.now(), limit = 20): ReminderRecord[] {
    return this.db.prepare(`SELECT * FROM reminders WHERE status='active' AND due_at<=? ORDER BY due_at LIMIT ?`).all(now, limit)
      .map(row => this.mapReminder(row))
  }

  claimReminder(id: string): boolean {
    const result = this.db.prepare(`UPDATE reminders SET status='processing' WHERE id=? AND status='active'`).run(id)
    return Number(result.changes) === 1
  }

  completeReminder(id: string, nextDueAt?: number): void {
    if (nextDueAt) {
      this.db.prepare(`UPDATE reminders SET status='active', due_at=?, last_sent_at=? WHERE id=?`).run(nextDueAt, Date.now(), id)
    } else {
      this.db.prepare(`UPDATE reminders SET status='done', last_sent_at=? WHERE id=?`).run(Date.now(), id)
    }
  }

  releaseReminder(id: string): void {
    this.db.prepare(`UPDATE reminders SET status='active' WHERE id=? AND status='processing'`).run(id)
  }

  cancelReminder(jid: string, sender: string, id: string): number {
    const result = this.db.prepare(`UPDATE reminders SET status='cancelled' WHERE jid=? AND sender=? AND id LIKE ? AND status IN ('active','processing')`).run(jid, sender, `${id}%`)
    return Number(result.changes)
  }

  claimOwnerGreeting(date: string, period: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO owner_greeting_runs(greeting_date,period,status,created_at)
      VALUES(?,?,'processing',?)
    `).run(date, period, Date.now())
    return Number(result.changes) > 0
  }

  completeOwnerGreeting(date: string, period: string): void {
    this.db.prepare(`
      UPDATE owner_greeting_runs SET status='sent', sent_at=?
      WHERE greeting_date=? AND period=? AND status='processing'
    `).run(Date.now(), date, period)
  }

  releaseOwnerGreeting(date: string, period: string): void {
    this.db.prepare(`
      DELETE FROM owner_greeting_runs
      WHERE greeting_date=? AND period=? AND status='processing'
    `).run(date, period)
  }

  setToolContext(jid: string, tool: string, payload: unknown): void {
    if (!jid || !tool) return
    this.db.prepare(`
      INSERT INTO tool_contexts(jid, tool, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(jid, tool) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `).run(jid, tool, JSON.stringify(payload), Date.now())
  }

  getToolContext<T>(jid: string, tool: string, maxAgeMs: number): T | null {
    if (!jid || !tool) return null
    const row = this.db.prepare('SELECT payload, updated_at FROM tool_contexts WHERE jid=? AND tool=?').get(jid, tool)
    if (!row) return null
    const updatedAt = Number(rowValue<number>(row, 'updated_at'))
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAgeMs) {
      this.db.prepare('DELETE FROM tool_contexts WHERE jid=? AND tool=?').run(jid, tool)
      return null
    }
    try {
      return JSON.parse(rowValue<string>(row, 'payload')) as T
    } catch {
      this.db.prepare('DELETE FROM tool_contexts WHERE jid=? AND tool=?').run(jid, tool)
      return null
    }
  }

  clearToolContext(tool: string, jid?: string): void {
    if (jid) this.db.prepare('DELETE FROM tool_contexts WHERE jid=? AND tool=?').run(jid, tool)
    else this.db.prepare('DELETE FROM tool_contexts WHERE tool=?').run(tool)
  }

  createFinanceTransaction(
    draft: FinanceTransactionDraft,
    status: FinanceTransactionStatus,
    duplicateOf?: string,
  ): FinanceTransactionRecord {
    const id = randomUUID().replace(/-/g, '').slice(0, 12)
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO finance_transactions(
        id,type,amount,currency,occurred_at,merchant,category,account,counterparty_account,
        note,source,status,confidence,duplicate_of,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, draft.type, Math.max(0, Math.round(draft.amount)), draft.currency, draft.occurredAt,
      draft.merchant, draft.category, draft.account, draft.counterpartyAccount, draft.note,
      draft.source, status, draft.confidence, duplicateOf || null, now, now,
    )
    return this.getFinanceTransaction(id)!
  }

  getFinanceTransaction(idOrPrefix: string): FinanceTransactionRecord | undefined {
    if (!idOrPrefix) return undefined
    const exact = this.db.prepare('SELECT * FROM finance_transactions WHERE id=?').get(idOrPrefix)
    if (exact) return this.mapFinanceTransaction(exact)
    const matches = this.db.prepare('SELECT * FROM finance_transactions WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2')
      .all(`${idOrPrefix}%`)
    return matches.length === 1 ? this.mapFinanceTransaction(matches[0]) : undefined
  }

  listFinanceTransactions(
    startAt: number,
    endAt: number,
    statuses: FinanceTransactionStatus[] = ['confirmed'],
    limit = 500,
  ): FinanceTransactionRecord[] {
    if (statuses.length === 0) return []
    const placeholders = statuses.map(() => '?').join(',')
    return this.db.prepare(`
      SELECT * FROM finance_transactions
      WHERE occurred_at>=? AND occurred_at<? AND status IN (${placeholders})
      ORDER BY occurred_at DESC LIMIT ?
    `).all(startAt, endAt, ...statuses, limit).map(row => this.mapFinanceTransaction(row))
  }

  listPendingFinanceTransactions(limit = 30): FinanceTransactionRecord[] {
    return this.db.prepare(`
      SELECT * FROM finance_transactions
      WHERE status IN ('pending','pending_duplicate')
      ORDER BY created_at DESC LIMIT ?
    `).all(limit).map(row => this.mapFinanceTransaction(row))
  }

  updateFinanceTransaction(idOrPrefix: string, patch: FinanceTransactionPatch): FinanceTransactionRecord | undefined {
    const current = this.getFinanceTransaction(idOrPrefix)
    if (!current) return undefined
    const next = {
      type: patch.type ?? current.type,
      amount: patch.amount ?? current.amount,
      currency: patch.currency ?? current.currency,
      occurredAt: patch.occurredAt ?? current.occurredAt,
      merchant: patch.merchant ?? current.merchant,
      category: patch.category ?? current.category,
      account: patch.account ?? current.account,
      counterpartyAccount: patch.counterpartyAccount ?? current.counterpartyAccount,
      note: patch.note ?? current.note,
      status: patch.status ?? current.status,
      confidence: patch.confidence ?? current.confidence,
      duplicateOf: patch.duplicateOf === null ? undefined : (patch.duplicateOf ?? current.duplicateOf),
    }
    this.db.prepare(`
      UPDATE finance_transactions SET
        type=?,amount=?,currency=?,occurred_at=?,merchant=?,category=?,account=?,counterparty_account=?,
        note=?,status=?,confidence=?,duplicate_of=?,updated_at=? WHERE id=?
    `).run(
      next.type, Math.max(0, Math.round(next.amount)), next.currency, next.occurredAt,
      next.merchant, next.category, next.account, next.counterpartyAccount, next.note,
      next.status, next.confidence, next.duplicateOf || null, Date.now(), current.id,
    )
    return this.getFinanceTransaction(current.id)
  }

  findFinanceCandidates(
    amount: number,
    currency: string,
    occurredAt: number,
    windowMs: number,
    excludeId?: string,
  ): FinanceTransactionRecord[] {
    return this.db.prepare(`
      SELECT * FROM finance_transactions
      WHERE amount=? AND currency=? AND occurred_at BETWEEN ? AND ?
        AND status IN ('confirmed','pending','pending_duplicate')
        AND (?='' OR id<>?)
      ORDER BY ABS(occurred_at-?) LIMIT 20
    `).all(
      Math.round(amount), currency, occurredAt - windowMs, occurredAt + windowMs,
      excludeId || '', excludeId || '', occurredAt,
    ).map(row => this.mapFinanceTransaction(row))
  }

  mergeFinanceTransaction(sourceId: string, targetId: string): boolean {
    const source = this.getFinanceTransaction(sourceId)
    const target = this.getFinanceTransaction(targetId)
    if (!source || !target || source.id === target.id) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE finance_imports SET transaction_id=? WHERE transaction_id=?').run(target.id, source.id)
      this.db.prepare(`UPDATE finance_transactions SET status='ignored', duplicate_of=?, updated_at=? WHERE id=?`)
        .run(target.id, Date.now(), source.id)
      this.db.exec('COMMIT')
      return true
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  getFinanceImport(source: FinanceImportSource, externalId: string): FinanceImportRecord | undefined {
    const row = this.db.prepare('SELECT * FROM finance_imports WHERE source=? AND external_id=?').get(source, externalId)
    return row ? this.mapFinanceImport(row) : undefined
  }

  claimFinanceImport(
    source: FinanceImportSource,
    externalId: string,
    contentHash: string,
    receivedAt: number,
    retryFailed = false,
  ): boolean {
    const existing = this.getFinanceImport(source, externalId)
    if (existing) {
      if (!retryFailed || existing.status !== 'failed') return false
      const result = this.db.prepare(`
        UPDATE finance_imports SET status='processing', error_code='', processed_at=NULL
        WHERE source=? AND external_id=? AND status='failed'
      `).run(source, externalId)
      return Number(result.changes) === 1
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO finance_imports(source,external_id,content_hash,status,received_at)
      VALUES(?,?,?,'processing',?)
    `).run(source, externalId, contentHash, receivedAt)
    return Number(result.changes) === 1
  }

  completeFinanceImport(
    source: FinanceImportSource,
    externalId: string,
    status: Exclude<FinanceImportStatus, 'processing'>,
    transactionId?: string,
    errorCode = '',
  ): void {
    this.db.prepare(`
      UPDATE finance_imports SET status=?, transaction_id=?, error_code=?, processed_at=?
      WHERE source=? AND external_id=?
    `).run(status, transactionId || null, errorCode.slice(0, 120), Date.now(), source, externalId)
  }

  setFinanceImportTransaction(sourceTransactionId: string, targetTransactionId: string): void {
    this.db.prepare('UPDATE finance_imports SET transaction_id=? WHERE transaction_id=?')
      .run(targetTransactionId, sourceTransactionId)
  }

  getFinanceSyncState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM finance_sync_state WHERE key=?').get(key)
    return row ? rowValue<string>(row, 'value') : undefined
  }

  setFinanceSyncState(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO finance_sync_state(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, value, Date.now())
  }

  claimFinanceReport(period: string): boolean {
    const row = this.db.prepare('SELECT status FROM finance_report_runs WHERE period=?').get(period)
    if (!row) {
      const result = this.db.prepare(`INSERT INTO finance_report_runs(period,status,created_at) VALUES(?,'processing',?)`)
        .run(period, Date.now())
      return Number(result.changes) === 1
    }
    if (rowValue<string>(row, 'status') !== 'failed') return false
    const result = this.db.prepare(`UPDATE finance_report_runs SET status='processing', delivered_at=NULL WHERE period=? AND status='failed'`)
      .run(period)
    return Number(result.changes) === 1
  }

  completeFinanceReport(period: string): void {
    this.db.prepare(`UPDATE finance_report_runs SET status='delivered', delivered_at=? WHERE period=?`)
      .run(Date.now(), period)
  }

  failFinanceReport(period: string): void {
    this.db.prepare(`UPDATE finance_report_runs SET status='failed' WHERE period=?`).run(period)
  }

  private mapReminder(row: unknown): ReminderRecord {
    let mentions: string[] = []
    try {
      const parsed = JSON.parse(rowValue<string>(row, 'mentions') || '[]')
      if (Array.isArray(parsed)) mentions = parsed.filter(value => typeof value === 'string')
    } catch {
      // Older/corrupt rows should remain usable without breaking the scheduler.
    }
    return {
      id: rowValue<string>(row, 'id'), jid: rowValue<string>(row, 'jid'), sender: rowValue<string>(row, 'sender'),
      task: rowValue<string>(row, 'task'), dueAt: Number(rowValue<number>(row, 'due_at')),
      recurrence: rowValue<string>(row, 'recurrence') || undefined,
      mentions,
      status: rowValue<ReminderRecord['status']>(row, 'status'), createdAt: Number(rowValue<number>(row, 'created_at')),
    }
  }

  private mapFinanceTransaction(row: unknown): FinanceTransactionRecord {
    return {
      id: rowValue<string>(row, 'id'),
      type: rowValue<FinanceTransactionRecord['type']>(row, 'type'),
      amount: Number(rowValue<number>(row, 'amount')),
      currency: rowValue<string>(row, 'currency'),
      occurredAt: Number(rowValue<number>(row, 'occurred_at')),
      merchant: rowValue<string>(row, 'merchant'),
      category: rowValue<string>(row, 'category'),
      account: rowValue<string>(row, 'account'),
      counterpartyAccount: rowValue<string>(row, 'counterparty_account'),
      note: rowValue<string>(row, 'note'),
      source: rowValue<FinanceTransactionRecord['source']>(row, 'source'),
      status: rowValue<FinanceTransactionStatus>(row, 'status'),
      confidence: Number(rowValue<number>(row, 'confidence')),
      duplicateOf: rowValue<string>(row, 'duplicate_of') || undefined,
      createdAt: Number(rowValue<number>(row, 'created_at')),
      updatedAt: Number(rowValue<number>(row, 'updated_at')),
    }
  }

  private mapFinanceImport(row: unknown): FinanceImportRecord {
    return {
      source: rowValue<FinanceImportSource>(row, 'source'),
      externalId: rowValue<string>(row, 'external_id'),
      contentHash: rowValue<string>(row, 'content_hash'),
      status: rowValue<FinanceImportStatus>(row, 'status'),
      transactionId: rowValue<string>(row, 'transaction_id') || undefined,
      errorCode: rowValue<string>(row, 'error_code') || undefined,
      receivedAt: Number(rowValue<number>(row, 'received_at')),
      processedAt: rowValue<number>(row, 'processed_at') ? Number(rowValue<number>(row, 'processed_at')) : undefined,
    }
  }

  close(): void {
    this.db.close()
  }
}

export const botDatabase = new BotDatabase()

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from '../system/config.js'

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
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);

      CREATE TABLE IF NOT EXISTS tool_contexts (
        jid TEXT NOT NULL,
        tool TEXT NOT NULL,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (jid, tool)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_contexts_updated ON tool_contexts(updated_at);
    `)
    const memberColumns = this.db.prepare('PRAGMA table_info(group_members)').all()
      .map(row => rowValue<string>(row, 'name'))
    if (!memberColumns.includes('custom_name')) {
      this.db.exec(`ALTER TABLE group_members ADD COLUMN custom_name TEXT NOT NULL DEFAULT ''`)
    }
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    this.db.prepare('DELETE FROM outgoing_messages WHERE created_at < ?').run(cutoff)
    this.db.prepare(`UPDATE media_jobs SET status='failed', error='Bot restart sebelum job selesai', updated_at=? WHERE status IN ('queued','running')`).run(Date.now())
    this.db.prepare(`UPDATE reminders SET status='active' WHERE status='processing'`).run()
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

  createReminder(jid: string, sender: string, task: string, dueAt: number, recurrence = ''): ReminderRecord {
    const id = randomUUID().replace(/-/g, '').slice(0, 8)
    const now = Date.now()
    this.db.prepare(`INSERT INTO reminders(id,jid,sender,task,due_at,recurrence,status,created_at) VALUES(?,?,?,?,?,?,'active',?)`)
      .run(id, jid, sender, task, dueAt, recurrence, now)
    return { id, jid, sender, task, dueAt, recurrence: recurrence || undefined, status: 'active', createdAt: now }
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

  private mapReminder(row: unknown): ReminderRecord {
    return {
      id: rowValue<string>(row, 'id'), jid: rowValue<string>(row, 'jid'), sender: rowValue<string>(row, 'sender'),
      task: rowValue<string>(row, 'task'), dueAt: Number(rowValue<number>(row, 'due_at')),
      recurrence: rowValue<string>(row, 'recurrence') || undefined,
      status: rowValue<ReminderRecord['status']>(row, 'status'), createdAt: Number(rowValue<number>(row, 'created_at')),
    }
  }

  close(): void {
    this.db.close()
  }
}

export const botDatabase = new BotDatabase()

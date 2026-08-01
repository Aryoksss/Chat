// ============================================================
// Memory Manager — R/W MEMORY.md + summarizer
// ============================================================

import { readFile, writeFile, appendFile, stat } from 'fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { aiBridge } from '../core/ai.js'
import type { MemoryEntry } from './types.js'

const MAX_MEMORY_CHARS = 2000

// ---- Filter agar memori tidak terpolusi respons generik/error bot ----
// Respons semacam ini kalau ikut tersimpan malah "mengajari" model untuk
// bersikap seperti asisten generik (contoh: "Oke, apa yang bisa saya bantu?").
const GENERIC_RESPONSE_PATTERNS: RegExp[] = [
  /^maaf,? (ada gangguan teknis|error|terjadi kesalahan)/i,
  /^terjadi gangguan teknis/i,
  /^no_reply\b/i,
  /^apa yang bisa (saya|aku) bantu/i,
  /^ada yang bisa (saya|aku) bantu/i,
  /^saya (akan|bisa) bantu/i,
  /^aku (akan|bisa) bantu/i,
  /^baik(la[hm])?, (akan )?saya/i,
  /^tentu,? (saya|aku)/i,
  /^terima kasih (telah|sudah) menghubungi/i,
]

// Pesan user yang terlalu sepele (ping/tes/balasan singkat) — tidak perlu diingat
const TRIVIAL_USER_PATTERNS: RegExp[] = [
  /^(hai+|hello+|halo+|hi+|hii+|yo+|yoo+|tes|test|testing|ok|oke|okay|ya|iya|y|p|test)$/i,
  /^[.!?.,]+$/,
]

export class MemoryManager {
  private states = new Map<string, { content: string; lastLoaded: number }>()

  private filePath(scope: string): string {
    const hash = createHash('sha256').update(scope).digest('hex').slice(0, 16)
    const suffix = scope.startsWith('owner:') ? 'owner' : `group-${hash}`
    return path.join(path.dirname(config.MEMORY_FILE), `MEMORY-${suffix}.md`)
  }

  private state(scope: string): { content: string; lastLoaded: number } {
    const existing = this.states.get(scope)
    if (existing) return existing
    const created = { content: '', lastLoaded: 0 }
    this.states.set(scope, created)
    return created
  }

  /** Load memory for one owner or group scope. */
  async load(scope: string): Promise<string> {
    const state = this.state(scope)
    const memoryFile = this.filePath(scope)
    try {
      const content = await readFile(memoryFile, 'utf-8')
      state.content = content
      state.lastLoaded = Date.now()
      return content
    } catch {
      // File doesn't exist yet — create it
      const initial = '# MEMORY\n\nIngatan jangka panjang bot.\n\n'
      await writeFile(memoryFile, initial, 'utf-8')
      state.content = initial
      state.lastLoaded = Date.now()
      return initial
    }
  }

  /** Get current memory content (cached, refreshes every 30s) */
  async getContent(scope: string): Promise<string> {
    const state = this.state(scope)
    const isStale = Date.now() - state.lastLoaded > 30_000
    if (!state.content || isStale) {
      return this.load(scope)
    }
    return state.content
  }

  /** Append a new memory entry */
  async append(scope: string, summary: string): Promise<void> {
    if (!summary || summary.trim().length === 0) return

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16)
    const entry = `## ${timestamp}\n- ${summary.trim()}\n\n`

    try {
      const state = this.state(scope)
      await appendFile(this.filePath(scope), entry, 'utf-8')
      state.content += entry
      state.lastLoaded = Date.now()
      logger.info('Memory appended')

      // Check if memory is getting too long — auto-summarize
      if (state.content.length > MAX_MEMORY_CHARS * 2) {
        await this.summarize(scope)
      }
    } catch (err) {
      logger.error({ err }, 'Failed to append memory')
    }
  }

  /**
   * Heuristik — apakah percakapan layak disimpan sebagai ingatan jangka panjang.
   * Mencegah memori terpolusi respons generik/error yang bikin AI tidak konsisten.
   */
  shouldRemember(userText: string, botResponse: string): boolean {
    const user = (userText || '').trim()
    const bot = (botResponse || '').trim()
    if (!user || !bot) return false
    if (GENERIC_RESPONSE_PATTERNS.some(p => p.test(bot))) return false
    if (TRIVIAL_USER_PATTERNS.some(p => p.test(user))) return false
    return true
  }

  /** Summarize memory when it gets too long — archive old content first so nothing is lost */
  async summarize(scope: string): Promise<void> {
    const state = this.state(scope)
    const memoryFile = this.filePath(scope)
    try {
      logger.info('Memory too long — archiving + summarizing...')

      // 1. Preserve the full history to an archive file before collapsing.
      const archivePath = memoryFile.replace(/\.md$/i, '-archive.md')
      const stamp = new Date().toISOString().replace('T', ' ').substring(0, 16)
      const oldContent = state.content
      let archive = ''
      try {
        archive = await readFile(archivePath, 'utf-8')
      } catch {
        archive = '# MEMORY ARCHIVE\n\nRiwayat memory lama (otomatis diarsipkan).\n\n'
      }
      archive += `\n---\n\n## Arsip ${stamp}\n\n${oldContent}\n`
      await writeFile(archivePath, archive, 'utf-8')
      logger.info({ archivePath }, 'Memory archived to file')

      // 2. Now collapse to a summary.
      const summary = await aiBridge.summarize(oldContent)
      const header = '# MEMORY\n\nIngatan jangka panjang bot (otomatis diringkas).\n\n'
      const newContent = header + `## Ringkasan\n${summary}\n\n`
      await writeFile(memoryFile, newContent, 'utf-8')
      state.content = newContent
      state.lastLoaded = Date.now()
      logger.info('Memory summarized successfully (history preserved in archive)')
    } catch (err) {
      logger.error({ err }, 'Failed to summarize memory')
    }
  }

  /** Clear memory for one owner or group scope. */
  async clear(scope: string): Promise<void> {
    const header = '# MEMORY\n\nIngatan jangka panjang bot.\n\n'
    const state = this.state(scope)
    await writeFile(this.filePath(scope), header, 'utf-8')
    state.content = header
    state.lastLoaded = Date.now()
    logger.info('Memory cleared')
  }
}

export const memoryManager = new MemoryManager()

export function memoryScope(jid: string, isGroup: boolean): string {
  return `${isGroup ? 'group' : 'owner'}:${jid}`
}

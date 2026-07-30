// ============================================================
// Memory Manager — R/W MEMORY.md + summarizer
// ============================================================

import { readFile, writeFile, appendFile, stat } from 'fs/promises'
import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { aiBridge } from '../core/ai.js'
import type { MemoryEntry } from './types.js'

const MAX_MEMORY_CHARS = 2000

export class MemoryManager {
  private memoryContent = ''
  private lastLoaded = 0

  /** Load memory from MEMORY.md */
  async load(): Promise<string> {
    try {
      const content = await readFile(config.MEMORY_FILE, 'utf-8')
      this.memoryContent = content
      this.lastLoaded = Date.now()
      return content
    } catch {
      // File doesn't exist yet — create it
      const initial = '# MEMORY\n\nIngatan jangka panjang bot.\n\n'
      await writeFile(config.MEMORY_FILE, initial, 'utf-8')
      this.memoryContent = initial
      return initial
    }
  }

  /** Get current memory content (cached, refreshes every 30s) */
  async getContent(): Promise<string> {
    const isStale = Date.now() - this.lastLoaded > 30_000
    if (!this.memoryContent || isStale) {
      return this.load()
    }
    return this.memoryContent
  }

  /** Append a new memory entry */
  async append(summary: string): Promise<void> {
    if (!summary || summary.trim().length === 0) return

    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 16)
    const entry = `## ${timestamp}\n- ${summary.trim()}\n\n`

    try {
      await appendFile(config.MEMORY_FILE, entry, 'utf-8')
      this.memoryContent += entry
      this.lastLoaded = Date.now()
      logger.info('Memory appended')

      // Check if memory is getting too long — auto-summarize
      if (this.memoryContent.length > MAX_MEMORY_CHARS * 2) {
        await this.summarize()
      }
    } catch (err) {
      logger.error({ err }, 'Failed to append memory')
    }
  }

  /** Summarize memory when it gets too long */
  async summarize(): Promise<void> {
    try {
      logger.info('Memory too long — summarizing...')
      const summary = await aiBridge.summarize(this.memoryContent)
      const header = '# MEMORY\n\nIngatan jangka panjang bot (otomatis diringkas).\n\n'
      const newContent = header + `## Ringkasan\n${summary}\n\n`
      await writeFile(config.MEMORY_FILE, newContent, 'utf-8')
      this.memoryContent = newContent
      this.lastLoaded = Date.now()
      logger.info('Memory summarized successfully')
    } catch (err) {
      logger.error({ err }, 'Failed to summarize memory')
    }
  }

  /** Clear all memory */
  async clear(): Promise<void> {
    const header = '# MEMORY\n\nIngatan jangka panjang bot.\n\n'
    await writeFile(config.MEMORY_FILE, header, 'utf-8')
    this.memoryContent = header
    this.lastLoaded = Date.now()
    logger.info('Memory cleared')
  }
}

export const memoryManager = new MemoryManager()

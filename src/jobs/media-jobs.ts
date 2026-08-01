import { botDatabase, type MediaJobRecord } from '../storage/database.js'
import type { ToolContext } from '../core/types.js'

const MEDIA_TOOLS = new Set([
  'img-gen', 'sticker', 'smeme', 'yt-dl', 'ig-dl', 'tt-dl', 'tw-dl',
  '4khd-detail', 'pap',
])

const STATUS_ICON: Record<MediaJobRecord['status'], string> = {
  queued: '🕓', running: '⏳', completed: '✅', failed: '❌', cancelled: '🚫',
}

export class MediaJobManager {
  isMediaTool(tool: string): boolean {
    return MEDIA_TOOLS.has(tool)
  }

  begin(tool: string, context: ToolContext): MediaJobRecord | null {
    if (!this.isMediaTool(tool)) return null
    const job = botDatabase.createMediaJob(context.jid, context.participant || context.jid, tool)
    context.mediaJobId = job.id
    return job
  }

  queue(tool: string, jid: string, sender: string): MediaJobRecord | null {
    if (!this.isMediaTool(tool)) return null
    return botDatabase.createMediaJob(jid, sender, tool, 'queued')
  }

  startQueued(context: ToolContext): void {
    if (context.mediaJobId && !this.isCancelled(context)) botDatabase.updateMediaJob(context.mediaJobId, 'running')
  }

  isCancelled(context: ToolContext): boolean {
    return Boolean(context.mediaJobId && botDatabase.isMediaJobCancelled(context.mediaJobId))
  }

  complete(context: ToolContext): void {
    if (context.mediaJobId && !this.isCancelled(context)) botDatabase.updateMediaJob(context.mediaJobId, 'completed')
  }

  fail(context: ToolContext, error: string): void {
    if (context.mediaJobId && !this.isCancelled(context)) botDatabase.updateMediaJob(context.mediaJobId, 'failed', error)
  }

  cancel(jid: string, sender: string, id?: string): number {
    return botDatabase.cancelMediaJobs(jid, sender, id)
  }

  format(jid: string): string {
    const jobs = botDatabase.listMediaJobs(jid, 8)
    if (jobs.length === 0) return 'Belum ada job media.'
    const lines = jobs.map(job => {
      const ageSeconds = Math.max(0, Math.floor((Date.now() - job.createdAt) / 1000))
      const detail = job.error ? ` — ${job.error.slice(0, 80)}` : ''
      return `${STATUS_ICON[job.status]} ${job.id} · ${job.tool} · ${job.status} · ${ageSeconds} dtk lalu${detail}`
    })
    return `🧰 *Job media*\n\n${lines.join('\n')}\n\nBatalkan: .cancel <id>`
  }

  async react(context: ToolContext, emoji: string): Promise<void> {
    const key = context.rawMessage?.key
    if (!key) return
    await context.sock.sendMessage(context.jid, { react: { key, text: emoji } }).catch(() => {})
  }
}

export const mediaJobManager = new MediaJobManager()

import { aiBridge } from '../core/ai.js'
import type { WhatsAppClient } from '../core/client.js'
import { botDatabase, type ReminderRecord } from '../storage/database.js'
import { logger } from '../system/logger.js'

const POLL_MS = 10_000

function nextOccurrence(reminder: ReminderRecord): number | undefined {
  if (!reminder.recurrence) return undefined
  const step = reminder.recurrence === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
  let next = reminder.dueAt + step
  while (next <= Date.now()) next += step
  return next
}

export class ReminderManager {
  private client: WhatsAppClient | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false

  start(client: WhatsAppClient): void {
    this.client = client
    if (this.timer) return
    this.timer = setInterval(() => this.poll().catch(err => logger.error({ err }, 'Reminder poll failed')), POLL_MS)
    this.poll().catch(err => logger.error({ err }, 'Initial reminder poll failed'))
    logger.info('Reminder scheduler started')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.client = null
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.client?.status.connected) return
    this.polling = true
    try {
      for (const reminder of botDatabase.dueReminders()) {
        if (!botDatabase.claimReminder(reminder.id)) continue
        try {
          const aiText = await aiBridge.composeReminderMessage(reminder.task, reminder.jid.endsWith('@g.us'))
          const senderDigits = reminder.sender.replace(/[^0-9]/g, '')
          const text = reminder.jid.endsWith('@g.us') && senderDigits
            ? `@${senderDigits} ${aiText}`
            : aiText
          const sent = await this.client.sendText(reminder.jid, text)
          if (!sent) throw new Error('WhatsApp sedang tidak dapat mengirim pesan')
          botDatabase.completeReminder(reminder.id, nextOccurrence(reminder))
          logger.info({ reminderId: reminder.id, jid: reminder.jid }, 'Reminder delivered')
        } catch (err: any) {
          botDatabase.releaseReminder(reminder.id)
          logger.warn({ reminderId: reminder.id, err: err.message }, 'Reminder delivery deferred')
        }
      }
    } finally {
      this.polling = false
    }
  }
}

export const reminderManager = new ReminderManager()

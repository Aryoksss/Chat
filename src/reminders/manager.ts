import { aiBridge } from '../core/ai.js'
import type { WhatsAppClient } from '../core/client.js'
import { botDatabase, type ReminderRecord } from '../storage/database.js'
import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import type { PersonaConfig } from '../core/types.js'

const POLL_MS = 10_000

function isAllowedReminder(reminder: ReminderRecord): boolean {
  if (reminder.jid.endsWith('@g.us')) return Boolean(reminder.sender.replace(/[^0-9]/g, ''))
  const jid = reminder.jid.replace(/[^0-9]/g, '')
  return [config.OWNER_NUMBER, config.OWNER_LID]
    .filter(Boolean)
    .map(value => value.replace(/[^0-9]/g, ''))
    .includes(jid)
}

function nextOccurrence(reminder: ReminderRecord): number | undefined {
  if (!reminder.recurrence) return undefined
  const step = reminder.recurrence === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
  let next = reminder.dueAt + step
  while (next <= Date.now()) next += step
  return next
}

export class ReminderManager {
  private client: WhatsAppClient | null = null
  private getGroupPersona: () => PersonaConfig | undefined = () => undefined
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false

  start(client: WhatsAppClient, getGroupPersona?: () => PersonaConfig | undefined): void {
    this.client = client
    this.getGroupPersona = getGroupPersona || (() => undefined)
    if (this.timer) return
    this.timer = setInterval(() => this.poll().catch(err => logger.error({ err }, 'Reminder poll failed')), POLL_MS)
    this.poll().catch(err => logger.error({ err }, 'Initial reminder poll failed'))
    logger.info('Reminder scheduler started')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.client = null
    this.getGroupPersona = () => undefined
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.client?.status.connected) return
    this.polling = true
    try {
      for (const reminder of botDatabase.dueReminders()) {
        if (!botDatabase.claimReminder(reminder.id)) continue
        if (!isAllowedReminder(reminder)) {
          botDatabase.completeReminder(reminder.id)
          logger.warn({ reminderId: reminder.id, jid: reminder.jid }, 'Unauthorized reminder discarded')
          continue
        }
        try {
          const isGroup = reminder.jid.endsWith('@g.us')
          const aiText = await aiBridge.composeReminderMessage(
            reminder.task,
            isGroup,
            isGroup ? this.getGroupPersona() : undefined,
          )
          const senderDigits = reminder.sender.replace(/[^0-9]/g, '')
          const mentions = isGroup ? (reminder.mentions || []) : []
          const targetLabels = mentions.map(jid => `@${jid.split('@')[0]}`)
          const text = isGroup
            ? targetLabels.length > 0
              ? `${targetLabels.join(' ')} ${aiText}`
              : senderDigits ? `@${senderDigits} ${aiText}` : aiText
            : aiText
          const sent = await this.client.sendText(reminder.jid, text, undefined, mentions)
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

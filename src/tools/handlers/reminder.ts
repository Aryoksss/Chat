import type { ToolContext } from '../../core/types.js'
import { normalizeMessageContent } from '@itsliaaa/baileys'
import { botDatabase } from '../../storage/database.js'
import { formatReminderTime, parseReminderRequest } from '../../reminders/parser.js'
import { config } from '../../system/config.js'

interface ReminderArgs {
  request?: string
  task?: string
  when?: string
}

function normalized(value: unknown): string {
  return String(value || '').replace(/[^0-9]/g, '')
}

/** Everyone may create reminders in groups; private reminders stay owner-only. */
export function isReminderAllowedContext(context: Pick<ToolContext, 'jid' | 'participant' | 'rawMessage'>): boolean {
  if (context.jid.endsWith('@g.us')) {
    return Boolean(normalized(context.participant || context.rawMessage?.key?.participant))
  }
  const id = normalized(context.jid)
  return [config.OWNER_NUMBER, config.OWNER_LID]
    .filter(Boolean)
    .map(normalized)
    .includes(id)
}

/** Read the actual WhatsApp mention metadata from the reminder message. */
export function extractReminderMentions(raw: any, excludedJids: string[] = []): string[] {
  const content = normalizeMessageContent(raw?.message) || raw?.message || {}
  const contexts = [
    content?.extendedTextMessage?.contextInfo,
    content?.conversationMessage?.contextInfo,
    content?.imageMessage?.contextInfo,
    content?.videoMessage?.contextInfo,
    raw?.message?.extendedTextMessage?.contextInfo,
  ]
  const excluded = excludedJids.map(normalized).filter(Boolean)
  return Array.from(new Set(contexts
    .flatMap(context => Array.isArray(context?.mentionedJid) ? context.mentionedJid : [])
    .filter((jid): jid is string => typeof jid === 'string' && jid.includes('@'))
    .filter(jid => !excluded.some(id => normalized(jid) === id || normalized(jid).endsWith(id) || id.endsWith(normalized(jid))))))
}

function mentionCountText(mentions: string[], isGroup: boolean): string {
  if (!isGroup) return ''
  if (mentions.length === 0) return '\nSaat jatuh tempo, pembuat reminder akan ditandai.'
  return `\nTarget mention: ${mentions.length} orang`
}

export async function handleReminder(args: ReminderArgs = {}, context: ToolContext): Promise<{
  success: boolean
  text?: string
  error?: string
}> {
  if (!isReminderAllowedContext(context)) {
    return { success: false, error: 'Reminder di grup bisa dipakai semua anggota, tetapi reminder chat pribadi hanya tersedia untuk owner.' }
  }
  const request = (args.request || [args.when, args.task].filter(Boolean).join(' ')).trim()
  const parsed = parseReminderRequest(request)
  if (!parsed) {
    return { success: false, text: 'Waktunya belum jelas. Contoh: "ingatkan saya besok jam 8 bayar listrik" atau "10 menit lagi minum obat".' }
  }
  if (parsed.dueAt <= Date.now()) return { success: false, text: 'Waktu pengingat harus di masa depan.' }
  const botJids = [
    config.BOT_LID,
    context.sock?.user?.id?.split(':')[0],
  ].filter(Boolean)
  const mentions = context.jid.endsWith('@g.us') ? extractReminderMentions(context.rawMessage, botJids) : []
  const reminder = botDatabase.createReminder(
    context.jid,
    context.participant || context.rawMessage?.key?.participant || context.jid,
    args.task?.trim() || parsed.task,
    parsed.dueAt,
    parsed.recurrence || '',
    mentions,
  )
  return {
    success: true,
    text: `⏰ Pengingat dibuat (${reminder.id})\n${reminder.task}\n${formatReminderTime(reminder.dueAt)}${reminder.recurrence ? '\nBerulang otomatis' : ''}${mentionCountText(mentions, context.jid.endsWith('@g.us'))}`,
  }
}

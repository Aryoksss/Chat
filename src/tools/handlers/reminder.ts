import type { ToolContext } from '../../core/types.js'
import { botDatabase } from '../../storage/database.js'
import { formatReminderTime, parseReminderRequest } from '../../reminders/parser.js'
import { config } from '../../system/config.js'

interface ReminderArgs {
  request?: string
  task?: string
  when?: string
}

function isOwnerContext(context: ToolContext): boolean {
  if (context.jid.endsWith('@g.us')) return false
  const id = context.jid.replace(/[^0-9]/g, '')
  return [config.OWNER_NUMBER, config.OWNER_LID]
    .filter(Boolean)
    .map(value => value.replace(/[^0-9]/g, ''))
    .includes(id)
}

export async function handleReminder(args: ReminderArgs = {}, context: ToolContext): Promise<{
  success: boolean
  text?: string
  error?: string
}> {
  if (!isOwnerContext(context)) {
    return { success: false, error: 'Fitur alarm/reminder hanya tersedia di chat pribadi owner.' }
  }
  const request = (args.request || [args.when, args.task].filter(Boolean).join(' ')).trim()
  const parsed = parseReminderRequest(request)
  if (!parsed) {
    return { success: false, text: 'Waktunya belum jelas. Contoh: "ingatkan saya besok jam 8 bayar listrik" atau "10 menit lagi minum obat".' }
  }
  if (parsed.dueAt <= Date.now()) return { success: false, text: 'Waktu pengingat harus di masa depan.' }
  const reminder = botDatabase.createReminder(
    context.jid,
    context.participant || context.jid,
    args.task?.trim() || parsed.task,
    parsed.dueAt,
    parsed.recurrence || '',
  )
  return {
    success: true,
    text: `⏰ Pengingat dibuat (${reminder.id})\n${reminder.task}\n${formatReminderTime(reminder.dueAt)}${reminder.recurrence ? '\nBerulang otomatis' : ''}`,
  }
}

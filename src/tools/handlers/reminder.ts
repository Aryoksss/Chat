import type { ToolContext } from '../../core/types.js'
import { botDatabase } from '../../storage/database.js'
import { formatReminderTime, parseReminderRequest } from '../../reminders/parser.js'

interface ReminderArgs {
  request?: string
  task?: string
  when?: string
}

export async function handleReminder(args: ReminderArgs = {}, context: ToolContext): Promise<{
  success: boolean
  text?: string
  error?: string
}> {
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

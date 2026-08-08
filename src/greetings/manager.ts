import { aiBridge } from '../core/ai.js'
import type { WhatsAppClient } from '../core/client.js'
import type { PersonaConfig } from '../core/types.js'
import { botDatabase } from '../storage/database.js'
import { config } from '../system/config.js'
import { logger } from '../system/logger.js'

const POLL_MS = 60_000
const TIME_ZONE = 'Asia/Jakarta'

export type GreetingPeriod = 'pagi' | 'siang' | 'sore' | 'apresiasi' | 'malam'

interface GreetingSlot {
  period: GreetingPeriod
  targetMinute: number
  closeMinute: number
}

export interface OwnerGreetingSchedule {
  date: string
  dayName: string
  isWeekend: boolean
  currentMinute: number
  slots: GreetingSlot[]
}

function deterministicOffset(key: string, range: number): number {
  let hash = 2166136261
  for (const char of key) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash) % Math.max(1, range)
}

function dateParts(now: Date): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
}

export function ownerGreetingSchedule(now = new Date()): OwnerGreetingSchedule {
  const parts = dateParts(now)
  const date = `${parts.year}-${parts.month}-${parts.day}`
  const isWeekend = parts.weekday === 'Sat' || parts.weekday === 'Sun'
  const currentMinute = Number(parts.hour) * 60 + Number(parts.minute)
  const dayName = new Intl.DateTimeFormat('id-ID', { timeZone: TIME_ZONE, weekday: 'long' }).format(now)
  const windows: Array<[GreetingPeriod, number, number, number]> = isWeekend
    ? [
        ['pagi', 7 * 60 + 30, 8 * 60 + 15, 9 * 60],
        ['siang', 12 * 60, 12 * 60 + 40, 13 * 60 + 15],
        ['sore', 16 * 60 + 30, 17 * 60 + 10, 18 * 60],
        ['apresiasi', 19 * 60, 20 * 60, 20 * 60 + 30],
        ['malam', 21 * 60 + 50, 22 * 60 + 15, 22 * 60 + 50],
      ]
    : [
        ['pagi', 6 * 60 + 30, 7 * 60, 7 * 60 + 45],
        ['siang', 11 * 60 + 45, 12 * 60 + 20, 13 * 60],
        ['sore', 16 * 60 + 45, 17 * 60 + 20, 18 * 60],
        ['apresiasi', 19 * 60, 20 * 60, 20 * 60 + 30],
        ['malam', 21 * 60 + 50, 22 * 60 + 10, 22 * 60 + 45],
      ]
  const slots = windows.map(([period, startMinute, targetEndMinute, closeMinute]) => ({
    period,
    targetMinute: startMinute + deterministicOffset(`${date}:${period}`, targetEndMinute - startMinute + 1),
    closeMinute,
  }))
  return { date, dayName, isWeekend, currentMinute, slots }
}

function ownerJid(): string {
  return `${config.OWNER_NUMBER.replace(/[^0-9]/g, '')}@s.whatsapp.net`
}

export class OwnerGreetingManager {
  private client: WhatsAppClient | null = null
  private persona: PersonaConfig | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false

  start(client: WhatsAppClient, persona?: PersonaConfig): void {
    this.client = client
    this.persona = persona || null
    if (!config.OWNER_GREETING_ENABLED) {
      logger.info('Automatic owner greetings disabled')
      return
    }
    if (!config.OWNER_NUMBER || !this.persona) {
      logger.warn('Automatic owner greetings unavailable: owner number or persona missing')
      return
    }
    if (this.timer) return
    this.timer = setInterval(() => this.poll().catch(err => logger.error({ err }, 'Owner greeting poll failed')), POLL_MS)
    this.poll().catch(err => logger.error({ err }, 'Initial owner greeting poll failed'))
    logger.info('Automatic owner greeting scheduler started')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.client = null
    this.persona = null
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.client?.status.connected || !this.persona) return
    const schedule = ownerGreetingSchedule()
    const slot = schedule.slots.find(item =>
      schedule.currentMinute >= item.targetMinute && schedule.currentMinute <= item.closeMinute,
    )
    if (!slot || !botDatabase.claimOwnerGreeting(schedule.date, slot.period)) return

    this.polling = true
    try {
      const text = await aiBridge.composeOwnerGreeting(slot.period, schedule.dayName, schedule.isWeekend, this.persona)
      const sent = await this.client.sendText(ownerJid(), text)
      if (!sent) throw new Error('WhatsApp sedang tidak dapat mengirim sapaan owner')
      botDatabase.completeOwnerGreeting(schedule.date, slot.period)
      logger.info({ date: schedule.date, period: slot.period }, 'Automatic owner greeting delivered')
    } catch (err: any) {
      botDatabase.releaseOwnerGreeting(schedule.date, slot.period)
      logger.warn({ err: err.message, date: schedule.date, period: slot.period }, 'Automatic owner greeting deferred')
    } finally {
      this.polling = false
    }
  }
}

export const ownerGreetingManager = new OwnerGreetingManager()

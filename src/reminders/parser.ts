const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS: Record<string, number> = {
  minggu: 0, ahad: 0, senin: 1, selasa: 2, rabu: 3,
  kamis: 4, jumat: 5, sabtu: 6,
}

export interface ParsedReminder {
  task: string
  dueAt: number
  recurrence?: string
}

function jakartaParts(date: Date): { year: number; month: number; day: number; weekday: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date)
  const get = (type: string) => parts.find(part => part.type === type)?.value || '0'
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), weekday: weekdays[get('weekday')] ?? 0,
  }
}

function localTimestamp(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.parse(`${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00+07:00`)
}

function addCalendarDays(parts: ReturnType<typeof jakartaParts>, days: number): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function extractTime(text: string): { hour: number; minute: number; matched: string } | null {
  const match = text.match(/\b(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{1,2}))?\b/i)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] || 0)
  if (hour > 23 || minute > 59) return null
  return { hour, minute, matched: match[0] }
}

function cleanTask(request: string, timingFragments: string[]): string {
  let task = request.replace(/@\d{6,20}\b/g, ' ')
  for (const fragment of timingFragments.filter(Boolean)) task = task.replace(fragment, ' ')
  task = task
    .replace(/^\s*[.!/]?(?:ingatkan|reminder(?:kan)?|jangan\s+lupa(?:kan)?)\s*/i, '')
    .replace(/^\s*(?:aku|saya|gue|gua|kami|kita|grup|group)\s*/i, '')
    .replace(/^\s*(?:untuk|buat|agar|supaya|tuk)\s*/i, '')
    .replace(/\s+/g, ' ').replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, '').trim()
  return task || 'pengingat yang kamu minta'
}

export function parseReminderRequest(request: string, now = new Date()): ParsedReminder | null {
  const text = request.trim()
  if (!text) return null
  const nowMs = now.getTime()
  const parts = jakartaParts(now)
  const timingFragments: string[] = []

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)\b/i)
  if (iso) {
    const dueAt = Date.parse(iso[1])
    if (Number.isFinite(dueAt) && dueAt > nowMs) {
      timingFragments.push(iso[0])
      return { task: cleanTask(text, timingFragments), dueAt }
    }
  }

  const relative = text.match(/\b(\d+)\s*(menit|jam|hari)\s*(?:lagi|ke\s*depan)\b/i)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const multiplier = unit === 'menit' ? 60_000 : unit === 'jam' ? 3_600_000 : DAY_MS
    timingFragments.push(relative[0])
    return { task: cleanTask(text, timingFragments), dueAt: nowMs + amount * multiplier }
  }

  const time = extractTime(text)
  if (time) timingFragments.push(time.matched)
  const hour = time?.hour ?? 9
  const minute = time?.minute ?? 0

  const daily = text.match(/\b(?:setiap|tiap)\s+hari\b/i)
  if (daily) {
    timingFragments.push(daily[0])
    let date = { year: parts.year, month: parts.month, day: parts.day }
    let dueAt = localTimestamp(date.year, date.month, date.day, hour, minute)
    if (dueAt <= nowMs) {
      date = addCalendarDays(parts, 1)
      dueAt = localTimestamp(date.year, date.month, date.day, hour, minute)
    }
    return { task: cleanTask(text, timingFragments), dueAt, recurrence: 'daily' }
  }

  const weekly = text.match(/\b(?:setiap|tiap)\s+(?:hari\s+)?(minggu|ahad|senin|selasa|rabu|kamis|jumat|sabtu)\b/i)
  if (weekly) {
    timingFragments.push(weekly[0])
    const target = WEEKDAYS[weekly[1].toLowerCase()]
    let delta = (target - parts.weekday + 7) % 7
    if (delta === 0 && localTimestamp(parts.year, parts.month, parts.day, hour, minute) <= nowMs) delta = 7
    const date = addCalendarDays(parts, delta)
    return {
      task: cleanTask(text, timingFragments),
      dueAt: localTimestamp(date.year, date.month, date.day, hour, minute),
      recurrence: `weekly:${target}`,
    }
  }

  const relativeDay = text.match(/\b(hari\s+ini|besok|lusa)\b/i)
  if (relativeDay) {
    timingFragments.push(relativeDay[0])
    const key = relativeDay[1].toLowerCase().replace(/\s+/g, ' ')
    let delta = key === 'besok' ? 1 : key === 'lusa' ? 2 : 0
    let date = addCalendarDays(parts, delta)
    let dueAt = localTimestamp(date.year, date.month, date.day, hour, minute)
    if (dueAt <= nowMs && delta === 0) {
      date = addCalendarDays(parts, 1)
      dueAt = localTimestamp(date.year, date.month, date.day, hour, minute)
    }
    return { task: cleanTask(text, timingFragments), dueAt }
  }

  const weekday = text.match(/\b(?:hari\s+)?(minggu|ahad|senin|selasa|rabu|kamis|jumat|sabtu)\b/i)
  if (weekday) {
    timingFragments.push(weekday[0])
    const target = WEEKDAYS[weekday[1].toLowerCase()]
    let delta = (target - parts.weekday + 7) % 7
    if (delta === 0 && localTimestamp(parts.year, parts.month, parts.day, hour, minute) <= nowMs) delta = 7
    const date = addCalendarDays(parts, delta)
    return { task: cleanTask(text, timingFragments), dueAt: localTimestamp(date.year, date.month, date.day, hour, minute) }
  }

  const dateMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b/)
  if (dateMatch) {
    timingFragments.push(dateMatch[0])
    let year = Number(dateMatch[3] || parts.year)
    const month = Number(dateMatch[2])
    const day = Number(dateMatch[1])
    let dueAt = localTimestamp(year, month, day, hour, minute)
    if (!dateMatch[3] && dueAt <= nowMs) dueAt = localTimestamp(++year, month, day, hour, minute)
    if (Number.isFinite(dueAt) && dueAt > nowMs) return { task: cleanTask(text, timingFragments), dueAt }
  }

  if (time) {
    let date = { year: parts.year, month: parts.month, day: parts.day }
    let dueAt = localTimestamp(date.year, date.month, date.day, hour, minute)
    if (dueAt <= nowMs) {
      date = addCalendarDays(parts, 1)
      dueAt = localTimestamp(date.year, date.month, date.day, hour, minute)
    }
    return { task: cleanTask(text, timingFragments), dueAt }
  }
  return null
}

export function formatReminderTime(timestamp: number): string {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', weekday: 'short', day: '2-digit', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp)) + ' WIB'
}

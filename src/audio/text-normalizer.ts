const SMALL_NUMBERS = [
  'nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan',
  'sepuluh', 'sebelas',
]

const MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
]

function underThousand(value: number): string {
  if (value < 12) return SMALL_NUMBERS[value]
  if (value < 20) return `${SMALL_NUMBERS[value - 10]} belas`
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const rest = value % 10
    return `${SMALL_NUMBERS[tens]} puluh${rest ? ` ${SMALL_NUMBERS[rest]}` : ''}`
  }
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  const prefix = hundreds === 1 ? 'seratus' : `${SMALL_NUMBERS[hundreds]} ratus`
  return `${prefix}${rest ? ` ${underThousand(rest)}` : ''}`
}

export function numberToIndonesian(value: number): string {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 999_999_999_999) {
    return String(value)
  }
  if (value === 0) return 'nol'
  if (value < 1000) return underThousand(value)

  const groups = [
    { divisor: 1_000_000_000, label: 'miliar' },
    { divisor: 1_000_000, label: 'juta' },
    { divisor: 1000, label: 'ribu' },
  ]
  let remaining = value
  const parts: string[] = []
  for (const group of groups) {
    const count = Math.floor(remaining / group.divisor)
    if (count > 0) {
      parts.push(group.divisor === 1000 && count === 1 ? 'seribu' : `${underThousand(count)} ${group.label}`)
      remaining %= group.divisor
    }
  }
  if (remaining > 0) parts.push(underThousand(remaining))
  return parts.join(' ')
}

function numberTokenToWords(token: string): string {
  const compact = token.replace(/\./g, '')
  if (/^\d+$/.test(compact)) return numberToIndonesian(Number(compact))
  const decimal = token.match(/^(\d+)[,.](\d+)$/)
  if (decimal) {
    return `${numberToIndonesian(Number(decimal[1]))} koma ${decimal[2].split('').map(digit => SMALL_NUMBERS[Number(digit)]).join(' ')}`
  }
  return token
}

function normalizeDates(text: string): string {
  return text
    .replace(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (_, year, month, day) =>
      `${numberToIndonesian(Number(day))} ${MONTHS[Number(month) - 1] || month} ${numberToIndonesian(Number(year))}`)
    .replace(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/g, (_, day, month, year) =>
      `${numberToIndonesian(Number(day))} ${MONTHS[Number(month) - 1] || month} ${numberToIndonesian(Number(year))}`)
}

/** Convert common Indonesian numeric notation into words before Edge-TTS. */
export function normalizeForHuTaoVoice(input: string): string {
  let text = input || ''
  text = normalizeDates(text)

  text = text.replace(/\bRp\.?\s*([\d.]+)(?:,\d+)?\b/gi, (_, amount) =>
    `${numberToIndonesian(Number(amount.replace(/\./g, '')))} rupiah`)
  text = text.replace(/\b(?:jam\s+)?(\d{1,2}):(\d{2})\b/gi, (_, hour, minute) => {
    const hourWords = numberToIndonesian(Number(hour))
    return Number(minute) === 0
      ? `jam ${hourWords}`
      : `jam ${hourWords} lewat ${numberToIndonesian(Number(minute))} menit`
  })
  text = text.replace(/\b(\d+(?:[,.]\d+)?)%/g, (_, value) => `${numberTokenToWords(value)} persen`)
  text = text.replace(/\bke[- ](\d+)\b/gi, (_, value) => `ke ${numberToIndonesian(Number(value))}`)
  text = text.replace(/\b(\d+)\s*[-–]\s*(\d+)\b/g, (_, start, end) =>
    `${numberToIndonesian(Number(start))} sampai ${numberToIndonesian(Number(end))}`)
  text = text.replace(/\b\d{1,3}(?:\.\d{3})+\b/g, token => numberTokenToWords(token))
  text = text.replace(/\b\d+[,.]\d+\b/g, token => numberTokenToWords(token))
  text = text.replace(/\b\d+\b/g, token => numberTokenToWords(token))
  return text.replace(/\s+/g, ' ').trim()
}

export interface AutoVoiceDecisionInput {
  enabled: boolean
  messageType: string
  messageText: string
  response: string
  autoStickerSent: boolean
  isCommand: boolean
  chance: number
  cooldownMs: number
  maxChars: number
  lastVoiceAt?: number
  now?: number
  random?: () => number
}

export interface AutoVoiceDecision {
  send: boolean
  reason: 'audio-reply' | 'explicit-request' | 'automatic' | 'disabled' | 'ineligible'
  voiceText: string
}

const EXPLICIT_VOICE_REQUEST = /\b(vn|voice\s*note|pesan\s+suara|balas(?:in)?\s+(?:pakai|pake)\s+suara|(?:pakai|pake)\s+suara|bacain|baca(?:kan)?\s+(?:pakai|pake)\s+suara)\b/i

const CASUAL_SIGNAL = /\b(wkwk|haha|hehe|hihi|lol|anjir|buset|yah|lah|dong|kok|iya|iyah|nggak|enggak|ga|gak|makasih|thanks|halo|hai|pagi|siang|malam|kangen|rindu|sayang|cinta|sedih|nangis|marah|kesel|capek|lelah|kaget|serius|mantap|lucu|ngakak|cerita|gimana|apa kabar)\b|[😂🤣😭🥺😅😆😢😡❤]/iu

const TASK_SIGNAL = /https?:\/\/|```|\b(download|unduh|edit|buatkan|bikinin|generate|carikan|cariin|jelaskan|analisis|analisa|translate|terjemahkan|reminder|ingatkan|daftar|list|kode|coding|error|bug|deploy|install|setup|debug|hitung|rangkum)\b/i

export function isExplicitVoiceRequest(text: string): boolean {
  return EXPLICIT_VOICE_REQUEST.test(text || '')
}

/** Make model output pleasant for speech without changing its meaning. */
export function prepareVoiceText(text: string): string {
  const ttsMatch = (text || '').match(/\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/i)
  return (ttsMatch ? ttsMatch[1] : text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, 'link')
    .replace(/[*_~`>#]/g, '')
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Remove internal voice protocol markers before a response reaches WhatsApp. */
export function prepareUserFacingResponse(text: string): string {
  const ttsMatch = (text || '').match(/\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/i)
  return (ttsMatch ? ttsMatch[1] : text || '')
    .replace(/\[\[audio_as_voice\]\]/gi, '')
    .replace(/\[\[tts:text\]\]|\[\[\/tts:text\]\]/gi, '')
    .replace(/^\s*`([\s\S]*?)`\s*$/, '$1')
    .trim()
}

/** Enforce the persona's forbidden Indonesian pronouns at the final boundary. */
export function normalizePersonaPronouns(text: string): string {
  return (text || '')
    .replace(/\b(?:lu|loe|elo)\b/gi, 'kamu')
    .replace(/\b(?:gw|gue|gua)\b/gi, 'aku')
}

/**
 * Decide whether a normal AI response should be delivered as a Hu Tao VN.
 * Audio replies and explicit voice requests are deterministic. Automatic VNs
 * are limited to short casual exchanges, use a probability, and respect a
 * per-chat cooldown so an active group does not get flooded with voice notes.
 */
export function decideAutoVoice(input: AutoVoiceDecisionInput): AutoVoiceDecision {
  const voiceText = prepareVoiceText(input.response)
  if (!voiceText) return { send: false, reason: 'ineligible', voiceText }

  const explicit = isExplicitVoiceRequest(input.messageText)
  const forced = input.messageType === 'audio' || explicit
  const forcedMaxChars = Math.max(input.maxChars * 3, 600)
  if (forced) {
    if (voiceText.length > forcedMaxChars) {
      return { send: false, reason: 'ineligible', voiceText }
    }
    return {
      send: true,
      reason: input.messageType === 'audio' ? 'audio-reply' : 'explicit-request',
      voiceText,
    }
  }

  if (!input.enabled) return { send: false, reason: 'disabled', voiceText }
  if (input.messageType !== 'text' || input.isCommand || input.autoStickerSent) {
    return { send: false, reason: 'ineligible', voiceText }
  }
  if (voiceText.length > input.maxChars || TASK_SIGNAL.test(input.messageText)) {
    return { send: false, reason: 'ineligible', voiceText }
  }

  const message = input.messageText.trim()
  const shortMessage = message.split(/\s+/).filter(Boolean).length <= 8
  if (!shortMessage && !CASUAL_SIGNAL.test(`${message} ${voiceText}`)) {
    return { send: false, reason: 'ineligible', voiceText }
  }

  const now = input.now ?? Date.now()
  if (input.lastVoiceAt && now - input.lastVoiceAt < input.cooldownMs) {
    return { send: false, reason: 'ineligible', voiceText }
  }

  const chance = Math.max(0, Math.min(1, input.chance))
  const random = input.random ?? Math.random
  return random() < chance
    ? { send: true, reason: 'automatic', voiceText }
    : { send: false, reason: 'ineligible', voiceText }
}

// ============================================================
// Configuration — loads from .env with sensible defaults
// ============================================================

import 'dotenv/config'
import path from 'path'

const ROOT = process.cwd()

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim()
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) return fallback
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  return fallback
}

export const config = {
  // === 9router AI ===
  NINE_ROUTER_API_KEY: process.env.NINE_ROUTER_API_KEY || '',
  NINE_ROUTER_BASE_URL: process.env.NINE_ROUTER_BASE_URL || 'https://9router.aryoks.tech/v1',
  AI_MODEL: process.env.AI_MODEL || 'OpenClawStable',
  AI_FALLBACK_MODEL: process.env.AI_FALLBACK_MODEL || process.env.AI_MODEL || 'OpenClawStable',
  // Lower = lebih konsisten mengikuti persona; higher = lebih kreatif tapi gampang melantur
  AI_TEMPERATURE: Number(process.env.AI_TEMPERATURE || 0.6),
  // Timeout per request AI (ms). Model yang lambat sering lewat 30s dan memicu
  // abort — naikkan kalau masih sering timeout.
  AI_TIMEOUT_MS: Number(process.env.AI_TIMEOUT_MS || 60000),

  // === Cloudflare AI (image generate/edit — Workers AI API langsung) ===
  // Dipakai tool img-gen. Edit gambar HANYA jalan lewat jalur ini (multipart
  // `input_image_N`), bukan lewat /v1/images/generations 9router.
  //
  // Banyak akun: isi CF_ACCOUNTS sebagai JSON array (bot rotasi acak + fallback
  // otomatis kalau satu akun gagal/kena limit):
  //   CF_ACCOUNTS=[{"accountId":"...","apiKey":"..."},{"accountId":"...","apiKey":"..."}]
  // Satu akun: pakai CF_ACCOUNT_ID + CF_API_KEY (dianggap akun tambahan juga).
  CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID || '',
  CF_API_KEY: process.env.CF_API_KEY || '',
  CF_ACCOUNTS_JSON: process.env.CF_ACCOUNTS || '',
  CF_IMAGE_MODEL: process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-2-klein-9b',
  CF_IMAGE_TIMEOUT_MS: Number(process.env.CF_IMAGE_TIMEOUT_MS || 60000),

  // === WhatsApp ===
  OWNER_NUMBER: process.env.OWNER_NUMBER || '',       // e.g. "6281234567890"
  // Owner's Linked-ID (LID). WhatsApp reports senders by their LID (e.g.
  // "93210101727329@lid"), NOT by their phone number — so the owner must also be
  // matched by LID or their DMs will be ignored ("Router returned null").
  OWNER_LID: process.env.OWNER_LID || '',
  // Optional: the bot's Linked-ID (LID), the internal WA id that may appear in
  // mentionedJid as "<lid>@lid". Needed to detect mentions made via the LID format.
  BOT_LID: process.env.BOT_LID || '',
  GROUP_JID: process.env.GROUP_JID || '',              // e.g. "1234567890-123456@g.us"
  SESSION_DIR: path.resolve(ROOT, process.env.SESSION_DIR || 'data/sessions'),

  // === Audio & Voice (STT) ===
  WHISPER_API_URL: process.env.WHISPER_API_URL || '',      // Endpoint for STT

  // === Hu Tao TTS (Edge-TTS + RVC bash script) ===
  // Path ke script bash hutao-voice-note. Default cek ~/.openclaw/tools/.
  HUTAO_VOICE_SCRIPT: process.env.HUTAO_VOICE_SCRIPT || '',
  HUTAO_AUTO_VOICE_ENABLED: booleanEnv('HUTAO_AUTO_VOICE_ENABLED', true),
  HUTAO_AUTO_VOICE_CHANCE: Math.max(0, Math.min(1, numberEnv('HUTAO_AUTO_VOICE_CHANCE', 0.18))),
  HUTAO_AUTO_VOICE_COOLDOWN_MS: Math.max(0, numberEnv('HUTAO_AUTO_VOICE_COOLDOWN_MS', 10 * 60 * 1000)),
  HUTAO_AUTO_VOICE_MAX_CHARS: Math.max(40, numberEnv('HUTAO_AUTO_VOICE_MAX_CHARS', 240)),

  PREFIX: process.env.PREFIX || '.',                   // Command prefix
  // Accept the configured prefix plus common WhatsApp-style alternatives.
  PREFIXES: Array.from(new Set([process.env.PREFIX || '.', '.', '/', '!'])),
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // === Scraper domains (opsional, default dipakai di tiap handler) ===
  KUSONIME_DOMAIN: process.env.KUSONIME_DOMAIN || '',

  // === Paths ===
  PERSONAS_DIR: path.resolve(ROOT, 'personas'),
  MEMORY_FILE: path.resolve(ROOT, 'memory', 'MEMORY.md'),
  DOWNLOADS_DIR: path.resolve(ROOT, 'data', 'downloads'),
  STICKER_POOL_DIR: path.resolve(ROOT, process.env.STICKER_POOL_DIR || 'data/stickers/pool'),
  STICKER_ARCHIVE_DIR: path.resolve(ROOT, process.env.STICKER_ARCHIVE_DIR || 'data/stickers/inbox'),
  GROUP_REGISTRY_FILE: path.resolve(ROOT, process.env.GROUP_REGISTRY_FILE || 'data/groups.json'),
  GROUP_ACCESS_FILE: path.resolve(ROOT, process.env.GROUP_ACCESS_FILE || 'data/group-access.json'),
  DATABASE_FILE: path.resolve(ROOT, process.env.DATABASE_FILE || 'data/bot.db'),
  TEMP_DIR: path.resolve(ROOT, 'data', 'temp'),
  COOKIES_DIR: path.resolve(ROOT, 'data', 'cookies'),
} as const

/** Validate required config at startup */
export function validateConfig(): string[] {
  const errors: string[] = []
  if (!config.NINE_ROUTER_API_KEY) errors.push('NINE_ROUTER_API_KEY is required')
  if (!config.NINE_ROUTER_BASE_URL) errors.push('NINE_ROUTER_BASE_URL is required')
  if (!config.OWNER_NUMBER) errors.push('OWNER_NUMBER is required')
  return errors
}

/** Validate and exit on error - call explicitly at startup */
export function validateConfigOrExit(): void {
  const errors = validateConfig()
  if (errors.length > 0) {
    console.error('❌ Configuration errors detected:')
    errors.forEach(err => console.error(`  - ${err}`))
    process.exit(1)
  }
}

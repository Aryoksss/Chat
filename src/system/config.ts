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

function idListEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map(value => value.replace(/[^0-9]/g, ''))
    .filter(Boolean)
}

function stringListEnv(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
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
  // Nomor/LID bot lain yang harus selalu diabaikan agar tidak terjadi loop
  // balas-membalas atau adu sticker di grup.
  IGNORED_BOT_IDS: idListEnv('IGNORED_BOT_IDS'),
  GROUP_JID: process.env.GROUP_JID || '',              // e.g. "1234567890-123456@g.us"
  SESSION_DIR: path.resolve(ROOT, process.env.SESSION_DIR || 'data/sessions'),

  // === Audio & Voice (STT) ===
  WHISPER_API_URL: process.env.WHISPER_API_URL || '',      // Endpoint for STT

  // === Hu Tao TTS (Edge-TTS + RVC bash script) ===
  // Path ke script bash hutao-voice-note. Default: scripts/hutao-voice-note.
  HUTAO_VOICE_SCRIPT: process.env.HUTAO_VOICE_SCRIPT || '',
  HUTAO_VOICE_LANGUAGE: process.env.HUTAO_VOICE_LANGUAGE || 'ja',
  HUTAO_AUTO_VOICE_ENABLED: booleanEnv('HUTAO_AUTO_VOICE_ENABLED', true),
  HUTAO_AUTO_VOICE_CHANCE: Math.max(0, Math.min(1, numberEnv('HUTAO_AUTO_VOICE_CHANCE', 0.18))),
  HUTAO_AUTO_VOICE_COOLDOWN_MS: Math.max(0, numberEnv('HUTAO_AUTO_VOICE_COOLDOWN_MS', 10 * 60 * 1000)),
  HUTAO_AUTO_VOICE_MAX_CHARS: Math.max(40, numberEnv('HUTAO_AUTO_VOICE_MAX_CHARS', 240)),

  // === Owner finance ledger + Gmail transaction import ===
  FINANCE_ENABLED: booleanEnv('FINANCE_ENABLED', false),
  FINANCE_GMAIL_CLIENT_FILE: path.resolve(ROOT, process.env.FINANCE_GMAIL_CLIENT_FILE || 'data/secrets/gmail-oauth-client.json'),
  FINANCE_GMAIL_TOKEN_FILE: path.resolve(ROOT, process.env.FINANCE_GMAIL_TOKEN_FILE || 'data/secrets/gmail-token.json'),
  FINANCE_GMAIL_LABEL: process.env.FINANCE_GMAIL_LABEL || 'FinanceBot',
  FINANCE_GMAIL_ALLOWED_SENDERS: stringListEnv('FINANCE_GMAIL_ALLOWED_SENDERS'),
  FINANCE_EMAIL_POLL_MS: Math.max(30_000, numberEnv('FINANCE_EMAIL_POLL_MS', 120_000)),
  FINANCE_EMAIL_AUTO_CONFIRM: booleanEnv('FINANCE_EMAIL_AUTO_CONFIRM', false),
  // Manual/historical Gmail syncs are trusted after label + sender filtering;
  // background polling stays pending unless FINANCE_EMAIL_AUTO_CONFIRM=true.
  FINANCE_EMAIL_SYNC_AUTO_CONFIRM: booleanEnv('FINANCE_EMAIL_SYNC_AUTO_CONFIRM', true),
  FINANCE_EMAIL_START_DATE: process.env.FINANCE_EMAIL_START_DATE || '',
  FINANCE_REPORT_TIME: /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.FINANCE_REPORT_TIME || '')
    ? process.env.FINANCE_REPORT_TIME!
    : '08:00',
  FINANCE_SHEETS_ENABLED: booleanEnv('FINANCE_SHEETS_ENABLED', false),
  FINANCE_GOOGLE_SPREADSHEET_ID: process.env.FINANCE_GOOGLE_SPREADSHEET_ID || '',
  FINANCE_GOOGLE_SHEET_NAME: process.env.FINANCE_GOOGLE_SHEET_NAME || 'Transactions',
  FINANCE_SHEETS_SYNC_MS: Math.max(60_000, numberEnv('FINANCE_SHEETS_SYNC_MS', 120_000)),

  // === Automatic owner greetings (WIB, owner DM only) ===
  OWNER_GREETING_ENABLED: booleanEnv('OWNER_GREETING_ENABLED', true),

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

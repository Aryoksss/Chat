// ============================================================
// Configuration — loads from .env with sensible defaults
// ============================================================

import 'dotenv/config'
import path from 'path'

const ROOT = process.cwd()

export const config = {
  // === 9router AI ===
  NINE_ROUTER_API_KEY: process.env.NINE_ROUTER_API_KEY || '',
  NINE_ROUTER_BASE_URL: process.env.NINE_ROUTER_BASE_URL || 'https://9router.aryoks.tech/v1',
  AI_MODEL: process.env.AI_MODEL || 'OpenClawStable',
  AI_FALLBACK_MODEL: process.env.AI_FALLBACK_MODEL || process.env.AI_MODEL || 'OpenClawStable',

  // === WhatsApp ===
  OWNER_NUMBER: process.env.OWNER_NUMBER || '',       // e.g. "6281234567890"
  GROUP_JID: process.env.GROUP_JID || '',              // e.g. "1234567890-123456@g.us"
  SESSION_DIR: path.resolve(ROOT, process.env.SESSION_DIR || 'data/sessions'),

  // === Audio & Voice (STT) ===
  WHISPER_API_URL: process.env.WHISPER_API_URL || '',      // Endpoint for STT

  PREFIX: process.env.PREFIX || '.',                   // Command prefix
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // === Paths ===
  PERSONAS_DIR: path.resolve(ROOT, 'personas'),
  MEMORY_FILE: path.resolve(ROOT, 'memory', 'MEMORY.md'),
  DOWNLOADS_DIR: path.resolve(ROOT, 'data', 'downloads'),
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

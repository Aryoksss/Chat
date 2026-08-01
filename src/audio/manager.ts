// ============================================================
// Audio Manager — Pipeline for STT and Local Edge-TTS + RVC Python
// ============================================================

import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { spawn } from 'child_process'
import { tmpdir, homedir } from 'os'
import { join, resolve } from 'path'
import { access, readFile, unlink } from 'fs/promises'

/** Resolve lokasi script bash hutao-voice-note. Prioritas: config → ~/.openclaw/tools/hutao-voice-note → VPS hutao-rvc. */
async function resolveHutaoScript(): Promise<string | null> {
  const candidates = [
    config.HUTAO_VOICE_SCRIPT,
    `${homedir()}/.openclaw/tools/hutao-voice-note`,
    `${homedir()}/.openclaw/tools/hutao-rvc/hutao-voice-note`,
  ].filter(Boolean)

  for (const c of candidates) {
    try {
      await access(c)
      return resolve(c)
    } catch {
      // not found/executable — coba kandidat berikutnya
    }
  }
  return null
}

export class AudioManager {
  /**
   * 1. Speech-to-Text: Convert user's Voice Note to text
   * using a local/remote Whisper API
   */
  async transcribe(audioBuffer: Buffer): Promise<string | null> {
    if (!config.WHISPER_API_URL) {
      logger.warn('WHISPER_API_URL not configured')
      return null
    }

    try {
      const formData = new FormData()
      formData.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/ogg' }), 'audio.ogg')

      const res = await fetch(config.WHISPER_API_URL, {
        method: 'POST',
        body: formData
      })

      const data = await res.json() as any
      return data?.text || data?.transcription || null
    } catch (err: any) {
      logger.error({ err }, 'Whisper STT failed')
      return null
    }
  }

  /**
   * 2. Text -> Edge-TTS -> RVC (Hu Tao).
   * Menjalankan script bash hutao-voice-note (VPS): --text "..." --output out.ogg
   */
  async generateHuTaoVoice(text: string): Promise<Buffer | null> {
    logger.info('Generating Voice Note (Edge-TTS + RVC Local)...')

    const scriptPath = await resolveHutaoScript()
    if (!scriptPath) {
      logger.error('hutao-voice-note script not found (set HUTAO_VOICE_SCRIPT or place at ~/.openclaw/tools/)')
      return null
    }

    const tempOutPath = join(tmpdir(), `hutao_out_${Date.now()}.ogg`)

    try {
      // Script bash VPS menerima --text (teks langsung) + --output.
      // Gunakan spawn array (tanpa shell) untuk mencegah injection.
      const child = spawn('bash', [
        scriptPath,
        '--text', text,
        '--output', tempOutPath,
      ])

      // Collect stdout/stderr for debugging
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (data) => { stdout += data })
      child.stderr?.on('data', (data) => { stderr += data })

      // Wait for process to complete
      const exitCode = await new Promise<number>((resolve2, reject) => {
        child.on('close', resolve2)
        child.on('error', reject)
      })

      if (stderr && !stderr.includes('INFO')) {
        logger.warn({ stderr }, 'RVC Script stderr (might not be an error)')
      }

      if (exitCode !== 0) {
        throw new Error(`hutao-voice-note exited with code ${exitCode}: ${stderr}`)
      }

      const audioBuffer = await readFile(tempOutPath)

      // Cleanup temp file
      unlink(tempOutPath).catch(() => {})

      return audioBuffer
    } catch (err: any) {
      logger.error({ err }, 'Local RVC execution failed')
      // Cleanup temp file on failure
      unlink(tempOutPath).catch(() => {})
      return null
    }
  }
}

export const audioManager = new AudioManager()


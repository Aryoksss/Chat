// ============================================================
// Audio Manager — Pipeline for STT and Local Edge-TTS + RVC Python
// ============================================================

import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { spawn } from 'child_process'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { writeFile, readFile, unlink } from 'fs/promises'

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
   * 2. Full Pipeline: Text -> Edge-TTS -> RVC Python (Hu Tao)
   * Executes the local Python script that handles the Edge-TTS + RVC conversion
   */
  async generateHuTaoVoice(text: string): Promise<Buffer | null> {
    logger.info('Generating Voice Note (Edge-TTS + RVC Local)...')

    // We create a temporary text file because passing long strings via CLI arguments can cause issues
    const tempTextPath = join(tmpdir(), `hutao_text_${Date.now()}.txt`)
    const tempOutPath = join(tmpdir(), `hutao_out_${Date.now()}.ogg`)

    try {
      await writeFile(tempTextPath, text)

      // Use spawn with array arguments to prevent shell injection
      // Don't use shell: true to avoid injection vulnerabilities
      const scriptPath = homedir() + '/.openclaw/tools/hutao-voice-note'
      
      const child = spawn('python3', [
        scriptPath,
        '--text-file', tempTextPath,
        '--output', tempOutPath
      ])

      // Collect stdout/stderr for debugging
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (data) => { stdout += data })
      child.stderr?.on('data', (data) => { stderr += data })

      // Wait for process to complete
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('close', resolve)
        child.on('error', reject)
      })

      if (stderr && !stderr.includes('INFO')) {
        logger.warn({ stderr }, 'RVC Script stderr (might not be an error)')
      }

      if (exitCode !== 0) {
        throw new Error(`Python script exited with code ${exitCode}: ${stderr}`)
      }

      const audioBuffer = await readFile(tempOutPath)

      // Cleanup temp files
      Promise.all([
          unlink(tempTextPath).catch(() => {}),
          unlink(tempOutPath).catch(() => {})
      ])

      return audioBuffer
    } catch (err: any) {
      logger.error({ err }, 'Local RVC execution failed')
      // Cleanup temp files on failure
      Promise.all([
          unlink(tempTextPath).catch(() => {}),
          unlink(tempOutPath).catch(() => {})
      ])
      return null
    }
  }
}

export const audioManager = new AudioManager()


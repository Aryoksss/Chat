// ============================================================
// Message Handler — main pipeline: WA → AI → response
// With Message Queue + Rate Limiter (Anti-Spam)
// ============================================================

import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { router } from '../core/router.js'
import { aiBridge } from '../core/ai.js'
import { memoryManager } from '../memory/manager.js'
import { cmdHandler } from '../system/cmd-handler.js'
import { toolExecutor } from '../tools/executor.js'
import { audioManager } from '../audio/manager.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import type { IncomingMessage, PersonaConfig } from '../core/types.js'
import type { WhatsAppClient } from '../core/client.js'

// ---- Rate Limiter Config ----
const RATE_LIMIT_WINDOW_MS = 10_000       // 10 detik
const RATE_LIMIT_MAX_MSG = 5               // max 5 pesan per window
const RATE_LIMIT_MUTE_MS = 30_000          // mute 30 detik kalau kena limit
const QUEUE_INTERVAL_MS = 1_500            // jeda antar proses pesan (1.5s)

// ---- Queue Item ----
interface QueueItem {
  msg: IncomingMessage
  client: WhatsAppClient
  timestamp: number
}

// ---- Per-JID state ----
interface JidState {
  queue: QueueItem[]
  timestamps: number[]
  mutedUntil: number
  processing: boolean
}

export class MessageHandler {
  private personas = new Map<'owner' | 'group', PersonaConfig>()
  private jidStates = new Map<string, JidState>()

  setPersonas(personas: Map<'owner' | 'group', PersonaConfig>): void {
    this.personas = personas
    logger.info('Personas updated in message handler')
  }

  getPersonas(): Map<'owner' | 'group', PersonaConfig> {
    return this.personas
  }

  /** Get or create state for a JID */
  private getJidState(jid: string): JidState {
    let state = this.jidStates.get(jid)
    if (!state) {
      state = { queue: [], timestamps: [], mutedUntil: 0, processing: false }
      this.jidStates.set(jid, state)
    }
    return state
  }

  /** Rate limiter — cek apakah user kena spam limit */
  private isRateLimited(jid: string): { limited: boolean; reason?: string } {
    const state = this.getJidState(jid)
    const now = Date.now()

    // Cek mute
    if (state.mutedUntil > now) {
      const remaining = Math.ceil((state.mutedUntil - now) / 1000)
      return { limited: true, reason: `Spam detection: mute ${remaining}s` }
    }

    // Bersihin timestamp expired
    state.timestamps = state.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS)

    // Cek jumlah pesan dalam window
    if (state.timestamps.length >= RATE_LIMIT_MAX_MSG) {
      state.mutedUntil = now + RATE_LIMIT_MUTE_MS
      logger.warn({ jid, msgCount: state.timestamps.length }, 'Rate limit triggered — muting')
      return { limited: true, reason: `Slow down! Muted ${RATE_LIMIT_MUTE_MS / 1000}s` }
    }

    return { limited: false }
  }

  /** Push pesan ke queue per-JID */
  private enqueue(msg: IncomingMessage, client: WhatsAppClient): void {
    const state = this.getJidState(msg.jid)
    state.queue.push({ msg, client, timestamp: Date.now() })

    if (!state.processing) {
      state.processing = true
      this.processQueue(msg.jid)
    }
  }

  /** Process queue untuk satu JID — satu per satu dengan jeda */
  private async processQueue(jid: string): Promise<void> {
    const state = this.getJidState(jid)

    while (state.queue.length > 0) {
      const item = state.queue.shift()!
      try {
        await this.processMessage(item.msg, item.client)
      } catch (err: any) {
        logger.error({ err, jid }, 'Queue processing error')
      }

      // Jeda antar pesan biar gak kelihatan spam
      if (state.queue.length > 0) {
        await this.sleep(QUEUE_INTERVAL_MS)
      }
    }

    state.processing = false
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }

  /** Public entry — called from client.ts */
  async handle(msg: IncomingMessage, client: WhatsAppClient): Promise<void> {
    // Debug log before routing
    logger.info({ sender: msg.sender, ownerEnv: config.OWNER_NUMBER }, 'DEBUG: Entering router')

    // 1. Route dulu
    const personaType = router.route(msg.jid, msg.sender, msg.isGroup)
    if (!personaType) {
      logger.info('DEBUG: Router returned null (ignored message)')
      return
    }

    // 2. Rate limit check
    const { limited, reason } = this.isRateLimited(msg.jid)
    if (limited && personaType !== 'owner') {
      logger.warn({ jid: msg.jid, reason }, 'Message rate limited')
      if (msg.text) {
        // Kasih tau user kalau kena limit
        await client.sendText(msg.jid, `⏱ ${reason}`)
      }
      return
    }

    // 3. Catat timestamp buat rate limiter
    const state = this.getJidState(msg.jid)
    state.timestamps.push(Date.now())

    // 4. Queue pesannya (diproses urut)
    this.enqueue(msg, client)
  }

  /** Proses satu pesan — queue worker */
  private async processMessage(msg: IncomingMessage, client: WhatsAppClient): Promise<void> {
    const personaType = router.route(msg.jid, msg.sender, msg.isGroup)!
    const logPrefix = `[${personaType}] ${msg.sender}`

    logger.info({ persona: personaType, text: msg.text?.slice(0, 60) }, `${logPrefix} processing`)

    // Quick local menu command before routing to AI/persona flow
    if (msg.text === '.menu' || msg.text === '.help' || msg.text === '.commands' || msg.text === '/menu') {
      const handled = await cmdHandler.handle({ ...msg, text: '/menu' }, client)
      if (handled) return
    }

    // System command (owner only)
    if (personaType === 'owner' && msg.text.startsWith('/')) {
      const handled = await cmdHandler.handle(msg, client)
      if (handled) return
    }

    // Prefix command fallback (.st, .yt, dll)
    if (msg.text?.startsWith(config.PREFIX)) {
      const handled = await this.handlePrefixCommand(msg, client)
      if (handled) return
    }

    // Ambil persona config
    const persona = this.personas.get(personaType)
    if (!persona) {
      logger.warn({ personaType }, 'No persona config')
      return
    }

    // Load memory
    const memory = await memoryManager.getContent()

    // Build system prompt
    const systemPrompt = aiBridge.buildSystemPrompt(persona.agent, persona.soul, memory)

    // Prepare user text or multi-modal content
    let userContent: any = msg.text || ''
    if (msg.quotedText) {
      userContent = `${msg.text}\n\n(Membalas: "${msg.quotedText}")`
    }

    // If message is an image, process it for Vision AI
    if (msg.messageType === 'image') {
      try {
        const buffer = await client.downloadMedia(msg.raw)
        if (buffer) {
          const base64 = buffer.toString('base64')
          const mimeType = 'image/jpeg'
          userContent = [
            { type: 'text', text: msg.text ? `${msg.text}\n\n[Terdapat lampiran gambar]` : '[User mengirimkan gambar]' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
          ]
        }
      } catch (err) {
        logger.error('Failed to process image for Vision')
      }
    }

    // If message is an audio/voice note, transcribe it
    if (msg.messageType === 'audio') {
      try {
        const buffer = await client.downloadMedia(msg.raw)
        if (buffer) {
          const transcript = await audioManager.transcribe(buffer)
          if (transcript) {
            userContent = `[Voice Note dari User]: "${transcript}"\n\n(Catatan untuk AI: User berbicara menggunakan Voice Note. Kamu bisa merespons santai seolah ini percakapan suara!)`
          } else {
            userContent = `[User mengirimkan Voice Note tetapi transkripsi gagal/belum disetting]`
          }
        }
      } catch (err) {
        logger.error('Failed to process audio for STT')
      }
    }

    // AI call (no react/presence — they cause "Waiting for this message" on some clients)
    try {
      const toolContext = {
        sock: client.sock,
        jid: msg.jid,
        participant: msg.participant,
        downloadMedia: async (m: any) => client.downloadMedia(m),
        rawMessage: msg.raw // Allow tools (like sticker maker) to access the raw message directly
      }
      const handlerMap = toolExecutor.createHandlerMap(toolContext)

      const response = await aiBridge.chatWithTools(
        systemPrompt, userContent, persona.tools, handlerMap,
      )

      // Debug log dulu sebelum dikirim
      logger.info({ response }, 'RESPONSE-before-send')

      if (response?.trim()) {
        // Generate Hu Tao Voice Note if user sent an audio message
        if (msg.messageType === 'audio') {
          try {
            await client.sendPresence(msg.jid, 'recording')
            const voiceBuffer = await audioManager.generateHuTaoVoice(response)

            if (voiceBuffer) {
              const outPath = join(tmpdir(), `hutao_vn_${Date.now()}.ogg`)
              await writeFile(outPath, voiceBuffer)
              await client.sendFile(msg.jid, outPath, 'audio')
              // Return after sending VN to avoid double sending (text + VN).
              // Alternatively, remove return to send both. We'll only send VN here.
              return
            }
          } catch (err) {
            logger.error({ err }, 'Failed to send VN response, falling back to text')
          }
        }

        // Send standard text if not a Voice Note or if Voice Note generation failed
        await client.sendText(msg.jid, response)

        // Save ke memory (ringkasan)
        if (msg.text) {
          await memoryManager.append(
            `${msg.sender}: ${msg.text.slice(0, 120)}\nBot: ${response.slice(0, 120)}`
          )
        }
      }
    } catch (err: any) {
      logger.error({ err }, 'AI processing failed')
      await client.sendText(msg.jid, `Maaf, error: ${err.message || 'gagal proses'}`)
    }
  }

  /** Handle prefix commands (.st, .yt, etc) — direct execution without AI */
  private async handlePrefixCommand(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const prefix = config.PREFIX
    if (!msg.text.startsWith(prefix)) return false

    const withoutPrefix = msg.text.slice(prefix.length).trim()
    const parts = withoutPrefix.split(/\s+/)
    const command = parts[0]?.toLowerCase()
    const args = parts.slice(1)

    // Map prefix → tool name
    const toolName = PREFIX_MAP[command]
    if (!toolName) return false

    const toolContext = {
      sock: client.sock,
      jid: msg.jid,
      participant: msg.participant,
      downloadMedia: async (m: any) => client.downloadMedia(m)
    }

    const parsedArgs = this.parseCommandArgs(command, args, msg)

    logger.info({ command, toolName, args: parsedArgs }, 'Prefix command executed')

    try {
      const result = await toolExecutor.executeToolCall(toolName, parsedArgs, toolContext)
      if (result.startsWith('✅') || result.startsWith('❌')) {
        await client.sendText(msg.jid, result)
      }
    } catch (err: any) {
      await client.sendText(msg.jid, `❌ Error: ${err.message}`)
    }

    return true
  }

  private parseCommandArgs(command: string, args: string[], msg: IncomingMessage): Record<string, unknown> {
    const parsed: Record<string, unknown> = {}
    switch (command) {
      case 's': case 'st': case 'sticker': parsed.imageType = 'reply'; break
      case 'yt': case 'youtube': parsed.url = args[0] || ''; parsed.format = args.includes('--audio') || args.includes('-a') ? 'audio' : 'video'; break
      case 'ig': case 'instagram': parsed.url = args[0] || ''; break
      case 'tt': case 'tiktok': parsed.url = args[0] || ''; break
      case 'tw': case 'twitter': parsed.url = args[0] || ''; break
      case 'brainly': parsed.query = args.join(' '); break
      case 'qr': parsed.text = args.join(' '); break
      case 'translate': case 'tr': parsed.text = args.slice(1).join(' '); parsed.to = args[0] || 'id'; break
      case 'shortlink': case 'short': parsed.url = args[0] || ''; break
      case 'weather': parsed.city = args.join(' '); break
    }
    return parsed
  }
}

const PREFIX_MAP: Record<string, string> = {
  'st': 'sticker', 'sticker': 'sticker',
  'yt': 'yt-dl', 'youtube': 'yt-dl',
  'ig': 'ig-dl', 'instagram': 'ig-dl',
  'tt': 'tt-dl', 'tiktok': 'tt-dl',
  'tw': 'tw-dl', 'twitter': 'tw-dl',
  'brainly': 'brainly', 'qr': 'qr',
  'translate': 'translate', 'tr': 'translate',
  'shortlink': 'shortlink', 'short': 'shortlink',
  'weather': 'weather', 'anime': 'anime',
  'to-pdf': 'to-pdf', 'pdf': 'to-pdf',
}

export const messageHandler = new MessageHandler()

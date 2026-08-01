// ============================================================
// Message Handler — main pipeline: WA → AI → response
// With Message Queue + Rate Limiter (Anti-Spam)
// ============================================================

import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { router } from '../core/router.js'
import { aiBridge } from '../core/ai.js'
import { memoryManager, memoryScope } from '../memory/manager.js'
import { cmdHandler } from '../system/cmd-handler.js'
import { toolExecutor } from '../tools/executor.js'
import { audioManager } from '../audio/manager.js'
import { get4khdContext } from '../tools/handlers/fourkhd.js'
import { getAnimeContext } from '../tools/handlers/anime-dl.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, unlink } from 'fs/promises'
import type { AIMessage, IncomingMessage, PersonaConfig } from '../core/types.js'
import type { WhatsAppClient } from '../core/client.js'

// ---- Rate Limiter Config ----
const RATE_LIMIT_WINDOW_MS = 10_000       // 10 detik
const RATE_LIMIT_MAX_MSG = 5               // max 5 pesan per window
const RATE_LIMIT_MUTE_MS = 30_000          // mute 30 detik kalau kena limit
const QUEUE_INTERVAL_MS = 1_500            // jeda antar proses pesan (1.5s)
const MAX_HISTORY_MESSAGES = 12             // 6 percakapan terakhir per chat
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000
const MAX_HISTORY_ENTRY_CHARS = 2000

interface ConversationState {
  messages: AIMessage[]
  lastUsedAt: number
}

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
  // Command yang menunggu argumen berikutnya (dari ketukan row menu, mis.
  // ".shortlink <url>" → pending { command:'shortlink', ask:'URL-nya apa?' }).
  pendingCommand?: { command: string; ask: string } | null
}

function hasCommandPrefix(text: string): boolean {
  const normalized = (text || '').trim()
  return config.PREFIXES.some(prefix => normalized.startsWith(prefix))
}

function getCommandParts(text: string): { prefix: string; rest: string } | null {
  const normalized = (text || '').trim()
  const prefix = config.PREFIXES.find(candidate => normalized.startsWith(candidate))
  if (!prefix) return null
  return { prefix, rest: normalized.slice(prefix.length).trim() }
}

export class MessageHandler {
  private personas = new Map<'owner' | 'group', PersonaConfig>()
  private jidStates = new Map<string, JidState>()
  private conversationHistory = new Map<string, ConversationState>()
  private acceptingMessages = true

  setPersonas(personas: Map<'owner' | 'group', PersonaConfig>): void {
    this.personas = personas
    logger.info('Personas updated in message handler')
  }

  getPersonas(): Map<'owner' | 'group', PersonaConfig> {
    return this.personas
  }

  /** Stop accepting new work and let active message handlers finish briefly. */
  async shutdown(): Promise<void> {
    this.acceptingMessages = false
    for (const state of this.jidStates.values()) state.queue.length = 0

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && [...this.jidStates.values()].some(state => state.processing)) {
      await this.sleep(100)
    }
  }

  private getConversationHistory(scope: string): AIMessage[] {
    const existing = this.conversationHistory.get(scope)
    if (!existing || Date.now() - existing.lastUsedAt > HISTORY_TTL_MS) {
      this.conversationHistory.delete(scope)
      return []
    }
    existing.lastUsedAt = Date.now()
    return existing.messages.map(message => ({ ...message }))
  }

  private rememberConversation(scope: string, userContent: string | any[], response: string): void {
    const userText = typeof userContent === 'string'
      ? userContent
      : userContent.find((part: any) => part?.type === 'text')?.text || '[User mengirim media]'
    const state = this.conversationHistory.get(scope) || { messages: [], lastUsedAt: Date.now() }
    state.messages.push(
      { role: 'user', content: String(userText).slice(0, MAX_HISTORY_ENTRY_CHARS) },
      { role: 'assistant', content: response.slice(0, MAX_HISTORY_ENTRY_CHARS) },
    )
    if (state.messages.length > MAX_HISTORY_MESSAGES) {
      state.messages.splice(0, state.messages.length - MAX_HISTORY_MESSAGES)
    }
    state.lastUsedAt = Date.now()
    this.conversationHistory.set(scope, state)
  }

  /** Get or create state for a JID */
  private getJidState(jid: string): JidState {
    let state = this.jidStates.get(jid)
    if (!state) {
      state = { queue: [], timestamps: [], mutedUntil: 0, processing: false, pendingCommand: null }
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
    if (!this.acceptingMessages) return
    // Debug log before routing
    logger.info({ sender: msg.sender, ownerEnv: config.OWNER_NUMBER }, 'DEBUG: Entering router')

    // 1. Route dulu
    const personaType = router.route(msg.jid, msg.sender, msg.isGroup)
    if (!personaType) {
      logger.info('DEBUG: Router returned null (ignored message)')
      return
    }

    // 1b. Ignore empty messages (no text, no media, not a sticker/audio)
    const hasContent = Boolean(
      (msg.text && msg.text.trim().length > 0) ||
      msg.hasMedia || msg.messageType === 'audio' || msg.messageType === 'sticker'
    )
    if (!hasContent) {
      logger.info({ jid: msg.jid, type: msg.messageType }, 'Ignored empty message (no text/media)')
      return
    }

    // 1c. In groups, only respond when the bot is explicitly addressed.
    // This prevents the bot from auto-replying to every group message
    // (which both annoys members and overloads Baileys' USync → "Waiting for this message").
    if (msg.isGroup) {
      const isCommand = hasCommandPrefix(msg.text || '')
      // STRICT: bot only replies when actually addressed — mentioned, replied
      // to, a command, or an image. The owner no longer talks freely here; they
      // must @mention the bot (mentioning the owner counts) or use a command.
      const isAddressed =
        msg.isBotMentioned ||
        msg.isReplyToBot ||
        isCommand ||
        msg.messageType === 'image'   // forwarded media for processing
      if (!isAddressed) {
        logger.info({
          jid: msg.jid,
          sender: msg.sender,
          text: msg.text?.slice(0, 40),
          isBotMentioned: msg.isBotMentioned,
          isReplyToBot: msg.isReplyToBot,
          isCommand,
          ownerNumber: config.OWNER_NUMBER,
          botMentionSource: msg.raw?.message?.extendedTextMessage?.contextInfo?.mentionedJid,
        }, 'Group message ignored (not addressed to bot)')
        return
      }
    }

    // 2. Rate limit check
    const { limited, reason } = this.isRateLimited(msg.jid)
    if (limited && personaType !== 'owner') {
      logger.warn({ jid: msg.jid, reason }, 'Message rate limited')
      if (msg.text) {
        // Kasih tau user kalau kena limit (di-quote pesannya)
        await client.sendText(msg.jid, `⏱ ${reason}`, msg.raw)
      }
      return
    }

    const state = this.getJidState(msg.jid)
    const normalizedText = (msg.text || '').trim().toLowerCase()
    const isExplicitCommand = hasCommandPrefix(normalizedText)

    // A new command always cancels a prompt left by a menu row. Without this,
    // a later command can be processed while the old row context remains active.
    if (state.pendingCommand && isExplicitCommand) {
      state.pendingCommand = null
    }

    // 3b. Kalau ada command yang menunggu argumen (dari ketukan row menu),
    // dan pesan ini bukan command baru, pakai teks pesan ini sebagai argumennya.
    if (state.pendingCommand && msg.text && !isExplicitCommand) {
      const pending = state.pendingCommand
      state.pendingCommand = null
      const newMsg: IncomingMessage = {
        ...msg,
        text: `${config.PREFIX}${pending.command} ${msg.text.trim()}`,
      }
      logger.info({ command: pending.command, arg: msg.text.slice(0, 60) }, 'Pending command resolved')

      // 4. Queue pesan yang sudah dilengkapi argumen.
      this.enqueue(newMsg, client)
      return
    }

    // 3c. Kalau pesan ini adalah ketukan row menu ber-placeholder (mis. ".shortlink <url>"),
    // jangan eksekusi langsung — simpan sebagai pending lalu tanya argumennya.
    const placeholder = this.extractPlaceholderCommand(msg.text)
    if (placeholder) {
      state.pendingCommand = { command: placeholder.command, ask: placeholder.ask }
      await client.sendText(msg.jid, placeholder.ask, msg.raw)
      return
    }

    // 3. Catat timestamp buat rate limiter
    state.timestamps.push(Date.now())

    // 4. Queue pesannya (diproses urut)
    this.enqueue(msg, client)
  }

  /** Proses satu pesan — queue worker */
  private async processMessage(msg: IncomingMessage, client: WhatsAppClient): Promise<void> {
    const personaType = router.route(msg.jid, msg.sender, msg.isGroup)!
    const logPrefix = `[${personaType}] ${msg.sender}`
    const commandText = (msg.text || '').trim().toLowerCase()

    logger.info({ persona: personaType, text: msg.text?.slice(0, 60) }, `${logPrefix} processing`)

    // Quick local menu command before routing to AI/persona flow
    const localCommandParts = getCommandParts(commandText)
    const localCommand = localCommandParts?.rest.split(/\s+/)[0]
    if (localCommand === 'menu' || localCommand === 'help' || localCommand === 'commands' || localCommand === 'helper') {
      const systemCommand = localCommand === 'helper' ? '/helper' : '/menu'
      const handled = await cmdHandler.handle({ ...msg, text: systemCommand }, client)
      if (handled) return
    }

    // System command (owner only)
    if (personaType === 'owner' && hasCommandPrefix(msg.text || '')) {
      const handled = await cmdHandler.handle(msg, client)
      if (handled) return
    }

    // Prefix command fallback (.st, .yt, dll)
    if (hasCommandPrefix(msg.text || '')) {
      const handled = await this.handlePrefixCommand(msg, client)
      if (handled) return
    }

    // Auto-route image edit/generate requests straight to img-gen. Only active
    // when CF creds exist — without them edits would silently become a fresh
    // generation (misleading), so we let the AI handle it instead.
    const hasCfImage = Boolean(config.CF_ACCOUNTS_JSON || (config.CF_ACCOUNT_ID && config.CF_API_KEY))
    if (hasCfImage && this.isImageEditRequest(msg)) {
      logger.info({ jid: msg.jid, text: msg.text?.slice(0, 60) }, 'Auto-routing to img-gen')
      await client.sendPresence(msg.jid, 'composing')
      const toolContext = {
        sock: client.sock,
        jid: msg.jid,
        participant: msg.participant,
        downloadMedia: async (m: any) => client.downloadMedia(m),
        rawMessage: msg.raw,
      }
      const result = await toolExecutor.executeToolCall('img-gen', { prompt: msg.text || '' }, toolContext)
      if (result.startsWith('✅') || result.startsWith('❌')) {
        await client.sendText(msg.jid, result, msg.raw)
      }
      return
    }

    // Ambil persona config
    const persona = this.personas.get(personaType)
    if (!persona) {
      logger.warn({ personaType }, 'No persona config')
      return
    }

    // Load memory
    const scope = memoryScope(msg.jid, msg.isGroup)
    const memory = await memoryManager.getContent(scope)

    // Build system prompt
    let systemPrompt = aiBridge.buildSystemPrompt(
      persona.agent,
      persona.soul,
      memory,
      persona.identity,
      persona.user,
      personaType === 'owner',
    )

    // Inject 4KHD active results (if any) so the AI remembers the last search
    // across turns (e.g. user: "kirim no 2" after a 4khd-search result list).
    const fourkhdCtx = get4khdContext(msg.jid)
    if (fourkhdCtx) {
      systemPrompt += `\n## KONTEKS AKTIF — 4KHD\n${fourkhdCtx}\n`
    }

    // Inject active anime results so the AI can continue with anime-links (index)
    // from the last anime-search result across turns.
    const animeCtx = getAnimeContext(msg.jid)
    if (animeCtx) {
      systemPrompt += `\n## KONTEKS AKTIF — ANIME\n${animeCtx}\n`
    }

    // Sender identity so the AI knows who it's talking to (name from pushName if
    // available, otherwise the phone number).
    const senderName = msg.raw?.pushName?.trim() || msg.sender
    const senderInfo = `${senderName} (${msg.sender})`

    // Sender identity is injected into the SYSTEM prompt (not the user message),
    // so the AI addresses the sender by name without echoing it back as content.
    systemPrompt += `\n## PENGIRIM PESAN\nPesan ini dikirim oleh: ${senderInfo}.\nIni metadata, BUKAN bagian dari pesan yang harus dibalas. Jangan ulangi baris ini, jangan echo nama/nomor ke balasan.\n`

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
          const imageNote = msg.text
            ? `${msg.text}\n\n[Ada lampiran gambar di pesan ini. Amati gambarnya dan balas dalam konteks teks di atas.]`
            : '[User mengirimkan sebuah gambar. AMATI dan ANALISIS gambar ini: jelaskan apa isinya, objek, suasana, dan detail yang terlihat, lalu respons natural sesuai konteks/personamu.]'
          userContent = [
            { type: 'text', text: imageNote },
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

    // Show a typing ("composing") indicator while the AI is thinking so the user
    // knows the bot is still there. WhatsApp expires presence after ~10s, so we
    // keep re-sending it on an interval until the reply is done.
    let typingTimer: ReturnType<typeof setInterval> | null = null
    // Timestamp when typing started — used to hold the reply briefly so the
    // "typing…" bubble is actually visible (AI often finishes in ~1s otherwise).
    const typingStartedAt = Date.now()
    const MIN_TYPING_VISIBLE_MS = 2500
    const startTyping = (): void => {
      logger.info({ jid: msg.jid }, 'TYPING: startTyping called')
      client.sendPresence(msg.jid, 'composing').catch(() => {})
      typingTimer = setInterval(() => {
        client.sendPresence(msg.jid, 'composing').catch(() => {})
      }, 8000)
    }
    const stopTyping = (): void => {
      if (typingTimer) {
        clearInterval(typingTimer)
        typingTimer = null
      }
    }
    /** Ensure the typing bubble has been visible for at least MIN_TYPING_VISIBLE_MS */
    const waitForTypingVisible = async (): Promise<void> => {
      const elapsed = Date.now() - typingStartedAt
      const remaining = MIN_TYPING_VISIBLE_MS - elapsed
      if (remaining > 0) {
        await new Promise(r => setTimeout(r, remaining))
      }
    }
    startTyping()

    try {
      const toolContext = {
        sock: client.sock,
        jid: msg.jid,
        participant: msg.participant,
        downloadMedia: async (m: any) => client.downloadMedia(m),
        rawMessage: msg.raw // Allow tools (like sticker maker) to access the raw message directly
      }
      const handlerMap = toolExecutor.createHandlerMap(toolContext)
      const history = this.getConversationHistory(scope)

      const response = await aiBridge.chatWithTools(
        systemPrompt, userContent, persona.tools, handlerMap, history,
      )

      // Debug log dulu sebelum dikirim
      logger.info({ response }, 'RESPONSE-before-send')

      if (response?.trim()) {
        if (!response.startsWith('Maaf, ada gangguan teknis')) {
          this.rememberConversation(scope, userContent, response)
        }
        // Generate Hu Tao Voice Note if user sent an audio message
        if (msg.messageType === 'audio') {
          try {
            await client.sendPresence(msg.jid, 'recording')
            const voiceBuffer = await audioManager.generateHuTaoVoice(response)

            if (voiceBuffer) {
              const outPath = join(tmpdir(), `hutao_vn_${Date.now()}.ogg`)
              try {
                await writeFile(outPath, voiceBuffer)
                await client.sendFile(msg.jid, outPath, 'audio', undefined, msg.raw)
              } finally {
                await unlink(outPath).catch(() => {})
              }
              // Return after sending VN to avoid double sending (text + VN).
              // Alternatively, remove return to send both. We'll only send VN here.
              return
            }
          } catch (err) {
            logger.error({ err }, 'Failed to send VN response, falling back to text')
          }
        }

        // Send standard text if not a Voice Note or if Voice Note generation failed.
        // Hold briefly so the "typing…" bubble stays visible before the reply.
        await waitForTypingVisible()
        // Reply to the user's message (quoted) instead of a fresh chat bubble.
        await client.sendText(msg.jid, response, msg.raw)

        // Save ke memory (ringkasan) — hanya percakapan yang bermakna,
        // jangan simpan ping/tes atau respons generik/error bot.
        if (msg.text) {
          if (memoryManager.shouldRemember(msg.text, response)) {
            await memoryManager.append(
              scope,
              `${msg.sender}: ${msg.text.slice(0, 120)}\nBot: ${response.slice(0, 120)}`
            )
          } else {
            logger.info('Memory skipped (generic/trivial exchange)')
          }
        }
      } else {
        // AI returned nothing (empty content, no tool call) even after retries —
        // don't leave the user hanging with zero reply.
        logger.warn({ jid: msg.jid, text: msg.text?.slice(0, 60) }, 'AI returned empty response — sending fallback')
        await waitForTypingVisible()
        await client.sendText(
          msg.jid,
          'Hmm, sepertinya aku nggak dapet respons yang bener dari model tadi. Coba ulangi atau perjelas permintaannya ya 🙏',
          msg.raw
        )
      }
    } catch (err: any) {
      logger.error({ err }, 'AI processing failed')
      await client.sendText(msg.jid, `Maaf, error: ${err.message || 'gagal proses'}`, msg.raw)
    } finally {
      stopTyping()
    }
  }

  /**
   * Detect an image edit/generate request (photo attached or replied + an
   * edit/generate caption). Routes straight to img-gen instead of relying on
   * the model to call the tool (which it sometimes skips).
   */
  private isImageEditRequest(msg: IncomingMessage): boolean {
    const hasImage = msg.messageType === 'image'
    const repliedToImage = Boolean(msg.raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage)
    if (!hasImage && !repliedToImage) return false

    const t = (msg.text || '').trim().toLowerCase()
    if (!t) return false

    // Explicit vision Q&A — NOT an edit request.
    const visionQuestion = /\b(apa|siapa|kenapa|gimana|bagaimana|deskripsi|promptnya|prompt apa|baca|scan|analisis|analisa|cek|lihat|jelaskan)\b/
    // Clear edit/generate verbs.
    const editVerb = /\b(edit|ubah|ganti|jadikan|jadiin|buat|bikin|generate)\b/
    // "…jadi <target>" pattern, e.g. "buat yang dikalungkan jadi emas", "ubah jadi kartun".
    const jadiTarget = /\bjadi\s+[a-z0-9\s]{1,20}$/

    const isEdit = editVerb.test(t) || jadiTarget.test(t)
    if (!isEdit) return false
    // Don't auto-edit on pure identification questions unless an explicit edit verb is present.
    if (!editVerb.test(t) && visionQuestion.test(t)) return false
    return true
  }

  /** Pertanyaan yang diajukan bot saat user menekan row menu ber-argumen. */
  private placeholderAsk(command: string): string | null {
    switch (command) {
      case 'yt': case 'youtube': return 'Mau download video YouTube apa? Kasih linknya.'
      case 'ig': case 'instagram': return 'Mau download IG apa? Kasih linknya.'
      case 'tt': case 'tiktok': return 'Mau download TikTok apa? Kasih linknya.'
      case 'tw': case 'twitter': return 'Mau download Twitter/X apa? Kasih linknya.'
      case 'brainly': return 'Soal apa yang mau dicari di Brainly? Tulis soalnya.'
      case 'qr': return 'Mau bikin QR code dari apa? Tulis teks/linknya.'
      case 'gambar': case 'img': case 'image': return 'Mau bikin/edit gambar apa? Tulis prompt-nya (atau reply foto + tulis instruksinya).'
      case 'translate': case 'tr': return 'Mau translate apa? Ketik: `.translate <bahasa> <teks>` — misal `.translate en halo dunia`.'
      case 'shortlink': case 'short': return 'Mau pendekin URL apa? Kasih linknya.'
      case 'weather': return 'Cuaca kota mana yang mau dicek? Tulis nama kotanya.'
      case 'anime': return 'Mau cari anime apa? Tulis judulnya.'
      case 'web-search': return 'Mau cari info apa di internet? Tulis kata kuncinya.'
      case '4khd-detail': return 'Kasih URL galeri 4KHD yang mau dibuka.'
      case 'anime-links': return 'Kasih URL anime atau nomor dari hasil anime-search.'
      default: return null
    }
  }

  /**
   * Deteksi perintah ber-placeholder dari ketukan row menu (mis. ".shortlink <url>").
   * Returns null kalau bukan, atau { command, ask } kalau iya.
   */
  private extractPlaceholderCommand(text: string): { command: string; ask: string } | null {
    const t = (text || '').trim()
    const commandParts = getCommandParts(t)
    if (!commandParts) return null

    // Ambil nama command (kata pertama setelah prefix)
    const rest = commandParts.rest
    const parts = rest.split(/\s+/)
    if (parts.length < 2) return null // butuh argumen, misal ".shortlink <url>"

    // Sisa harus placeholder seperti <url>, <teks>, dsb.
    const argPart = parts.slice(1).join(' ')
    if (!/^<[^>]+>$/.test(argPart.trim())) return null

    const ask = this.placeholderAsk(parts[0].toLowerCase())
    if (!ask) return null
    return { command: parts[0].toLowerCase(), ask }
  }

  /** Handle prefix commands (.st, .yt, etc) — direct execution without AI */
  private async handlePrefixCommand(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const commandParts = getCommandParts(msg.text)
    if (!commandParts) return false

    const withoutPrefix = commandParts.rest
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
      downloadMedia: async (m: any) => client.downloadMedia(m),
      rawMessage: msg.raw // Allow tools (like sticker maker) to read the replied image
    }

    const parsedArgs = this.parseCommandArgs(command, args, msg)

    logger.info({ command, toolName, args: parsedArgs }, 'Prefix command executed')

    // Show typing while a prefix command runs too (e.g. .st processing can take
    // a moment), so the user knows the bot is alive.
    await client.sendPresence(msg.jid, 'composing')

    try {
      const result = await toolExecutor.executeToolCall(toolName, parsedArgs, toolContext)
      // Kirim teks hasil apa pun (file tools = "✅ ...", text tools = hasil list,
      // gagal = "❌ ..."). Skip kalau kosong (besar kemungkinan file sudah terkirim
      // via socket oleh executor).
      if (result && result.trim()) {
        await client.sendText(msg.jid, result, msg.raw)
      }
    } catch (err: any) {
      await client.sendText(msg.jid, `❌ Error: ${err.message}`, msg.raw)
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
      case 'img': case 'image': case 'gambar': parsed.prompt = args.join(' '); break
      case 'translate': case 'tr': parsed.text = args.slice(1).join(' '); parsed.to = args[0] || 'id'; break
      case 'shortlink': case 'short': parsed.url = args[0] || ''; break
      case 'weather': parsed.city = args.join(' '); break
      case 'anime': parsed.query = args.join(' '); break
      case '4khd': case '4khd-search': parsed.query = args.join(' '); break
      case '4khd-latest': break // no args
      case '4khd-detail': parsed.url = args[0] || ''; parsed.download = true; parsed.index = parseInt(args[1] as string, 10) || 1; break
      case 'anime-search': parsed.query = args.join(' '); break
      case 'anime-links': parsed.index = parseInt(args[0] as string, 10) || 0; parsed.url = (args[0] && !/^\d+$/.test(args[0])) ? args[0] : ''; break
    }
    return parsed
  }
}

const PREFIX_MAP: Record<string, string> = {
  's': 'sticker', 'st': 'sticker', 'sticker': 'sticker',
  'yt': 'yt-dl', 'youtube': 'yt-dl',
  'ig': 'ig-dl', 'instagram': 'ig-dl',
  'tt': 'tt-dl', 'tiktok': 'tt-dl',
  'tw': 'tw-dl', 'twitter': 'tw-dl',
  'brainly': 'brainly', 'qr': 'qr',
  'img': 'img-gen', 'image': 'img-gen', 'gambar': 'img-gen',
  'translate': 'translate', 'tr': 'translate',
  'shortlink': 'shortlink', 'short': 'shortlink',
  'weather': 'weather', 'anime': 'anime',
  '4khd': '4khd-search', '4khd-search': '4khd-search',
  '4khd-latest': '4khd-latest',
  '4khd-detail': '4khd-detail',
  'anime-search': 'anime-search',
  'anime-links': 'anime-links',
}

export const messageHandler = new MessageHandler()

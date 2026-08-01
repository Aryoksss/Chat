// ============================================================
// WhatsApp Client — Baileys connection manager
// ============================================================
// Handles: connect, reconnect, QR login, session persist, events

import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, makeCacheableSignalKeyStore, makeInMemoryStore } from '@itsliaaa/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import QRCode from 'qrcode'
import NodeCache from 'node-cache'
import { readdir } from 'fs/promises'
import { join } from 'path'
import { config } from '../system/config.js'
import type { IncomingMessage, MessageContentType } from './types.js'

// @itsliaaa/baileys (v7 fork) does not re-export WAMessage/WASocket as named types
// at the top level. The runtime API is identical, so we type them loosely here.
type WAMessage = any
type WASocket = any

const logger = pino({ transport: { target: 'pino-pretty' }, level: config.LOG_LEVEL })

export type MessageHandlerFn = (msg: IncomingMessage) => Promise<void>

export class WhatsAppClient {
  public sock!: WASocket
  private messageHandler?: MessageHandlerFn
  private connected = false
  private reconnectAttempts = 0
  private isConnecting = false // Prevent concurrent connections
  private shuttingDown = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // In-memory store: lets Baileys retry failed messages (needs getMessage) and
  // answer group metadata without hammering the server every send.
  private store: ReturnType<typeof makeInMemoryStore> | null = null
  // Whether we've ensured the bot's presence privacy allows the owner to see
  // the typing indicator (set once on the first successful connect).
  private presencePrivacyEnsured = false
  // All Linked-IDs (LID) owned by this bot, so @mentions in groups are detected
  // even when WA reports them as <lid>@lid. Loaded from tctoken-*@lid.json.
  private botLids: string[] = []
  // Message IDs already processed — prevents duplicate replies when Baileys
  // re-emits history/backfill messages on reconnect. Capped to bound memory.
  private processedIds = new Set<string>()
  private static readonly PROCESSED_MAX = 2000
  // Pesan yang lebih tua dari batas ini dianggap backfill/history (bukan pesan
  // real-time), jadi tidak dibalas agar tidak "dibales lagi" pesan lama.
  private static readonly OLD_MSG_MS = 5 * 60 * 1000 // 5 menit

  /** Load all bot LIDs from tctoken files in the session dir (best-effort). */
  private async loadBotLids(): Promise<string[]> {
    const lids = new Set<string>([config.BOT_LID].filter(Boolean))
    try {
      const files = await readdir(config.SESSION_DIR)
      for (const f of files) {
        const m = /^tctoken-(\d+)@lid\.json$/.exec(f)
        if (m) lids.add(m[1])
      }
    } catch {
      // session dir unavailable — fall back to config/socket ids
    }
    if (this.sock?.user?.id) lids.add(this.sock.user.id.split(':')[0])
    return [...lids].filter(Boolean)
  }

  /** Start connection with Baileys */
  async start(): Promise<void> {
    if (this.shuttingDown) {
      logger.warn('Connection start skipped during shutdown')
      return
    }
    // Prevent multiple concurrent connection attempts
    if (this.isConnecting) {
      logger.warn('Connection already in progress, skipping...')
      return
    }
    
    this.isConnecting = true
    
    try {
      // Cleanup existing socket if any
      if (this.sock) {
        try {
          this.sock.end(undefined)
        } catch (e) {
          // Ignore cleanup errors
        }
      }

      const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR)

      // Wrap the disk-backed key store with a cache. useMultiFileAuthState writes
      // every session update to disk (slow); a cache keeps session state in memory
      // and flushes in the background. Without it, session writes can lag and Baileys
      // keeps rebuilding Signal sessions ("Closing stale open session…") — which
      // correlates with messages getting stuck PENDING / "Waiting for this message".
      const cachedState = {
        creds: state.creds,
        // Third arg (_cache) is optional at runtime; v7 types require it.
        keys: makeCacheableSignalKeyStore(state.keys, logger as any, undefined),
      }

      this.store = makeInMemoryStore({ logger: pino({ level: 'silent' }) as any })
      // Cache device lists so Baileys doesn't re-run USync device enumeration on
      // every single send (earlier logs showed getUSyncDevices timing out — caching
      // this is what makes group sends reliable).
      const userDevicesCache = new NodeCache({ stdTTL: 5 * 60, useClones: false })

      this.sock = makeWASocket({
        auth: cachedState as any,
        printQRInTerminal: true,
        // Silent all Baileys internal logging
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: pino({ level: 'silent' }) as any,
        // Use a neutral, human-looking browser profile. Avoid names containing "Bot"
        // or a varying identifier — WA flags automation when the device string looks
        // robotic or keeps changing across restarts, which can cause instant 401 kicks.
        browser: ['Chrome', 'Windows', '1.0.0'],
        syncFullHistory: false,
        // markOnlineOnConnect MUST be true: Baileys needs to announce presence to the
        // WhatsApp server so outbound messages get delivered + ACKed. Setting this false
        // makes the server treat the session as inactive and messages stay stuck PENDING
        // ("Waiting for this message").
        markOnlineOnConnect: true,
        // Required for reliable sending: lets Baileys look up a message by key so it
        // can retry messages that fail to deliver (instead of them staying PENDING).
        getMessage: async (key: any) => {
          const msg = await this.store?.loadMessage(key.remoteJid, key.id)
          return msg?.message || undefined
        },
        // Cache the per-user device list used when routing messages (see above).
        userDevicesCache,
        // Add connection timeout
        connectTimeoutMs: 60000,
      })

      // Save credentials after login (so next start doesn't need QR)
      this.sock.ev.on('creds.update', saveCreds)

      // Bind the in-memory store so messages it sees are recorded — this is what
      // lets getMessage() find a message for retries.
      this.store?.bind(this.sock.ev)

      // Handle connection updates
      this.sock.ev.on('connection.update', this.onConnectionUpdate.bind(this))

      // Handle incoming messages
      this.sock.ev.on('messages.upsert', this.onMessagesUpsert.bind(this))

      // Track outbound delivery status (PENDING → server/error) to distinguish
      // "just slow" from "actually stuck". Useful for debugging 'Waiting for this message'.
      this.sock.ev.on('messages.update', (updates: any[]) => {
        for (const u of updates) {
          if (u?.status !== undefined) {
            const st = ['PENDING', 'SERVER_ACK', 'DELIVERY_ACK', 'READ', 'PLAYED', 'ERROR'][u.status] || u.status
            logger.info({ jid: u.key?.remoteJid, id: u.key?.id, status: st }, 'Outbound delivery status update')
            if (u?.receipt?.error) {
              logger.error({ error: u.receipt.error, jid: u.key?.remoteJid }, 'Message delivery error')
            }
          }
        }
      })

      logger.info('🤖 WhatsApp Bot starting...')
    } finally {
      this.isConnecting = false
    }
  }

  /** Stop the socket and prevent reconnect handlers from starting it again. */
  async stop(): Promise<void> {
    this.shuttingDown = true
    this.connected = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sock) {
      try {
        this.sock.end(undefined)
      } catch (err) {
        logger.warn({ err }, 'Failed to close WhatsApp socket cleanly')
      }
    }
  }

  /** Set the handler for every incoming message */
  onMessage(handler: MessageHandlerFn): void {
    this.messageHandler = handler
  }

  /** Send a text message — with a single retry in case the socket was mid-reconnect.
   *  Pass `quoted` (the user's raw WAMessage) to reply to that message instead of
   *  sending a fresh chat bubble. */
  async sendText(jid: string, text: string, quoted?: any): Promise<void> {
    const doSend = async (): Promise<boolean> => {
      try {
        logger.info({ jid, textLength: text?.length, textPreview: text?.substring(0, 50), isReply: Boolean(quoted) }, 'sendText: sending')
        const result = await this.sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined)
        logger.info({ result }, 'sendText: sent')
        return true
      } catch (err: any) {
        logger.error({ err, jid, textLength: text?.length }, 'Failed to send text message')
        return false
      }
    }

    let ok = await doSend()
    // Retry once if it failed — often the socket is just finishing a reconnect.
    if (!ok) {
      logger.warn('sendText failed, retrying once after short delay...')
      await this.sleep(1500)
      ok = await doSend()
    }
    if (!ok) {
      logger.error({ jid }, 'sendText failed after retry — connection may be down')
    }
  }

  /** Send a file (sticker, image, video, document, audio) */
  async sendFile(
    jid: string,
    filePath: string,
    fileType: 'sticker' | 'image' | 'video' | 'document' | 'audio',
    caption?: string,
    quoted?: any
  ): Promise<void> {
    try {
      const payload: Record<string, any> = {}

      if (fileType === 'sticker') {
        payload.sticker = { url: filePath }
      } else if (fileType === 'image') {
        // Show typing for media
        await this.sock.sendPresenceUpdate('composing', jid)
        payload.image = { url: filePath }
        if (caption) payload.caption = caption
      } else if (fileType === 'video') {
        await this.sock.sendPresenceUpdate('composing', jid)
        payload.video = { url: filePath }
        if (caption) payload.caption = caption
      } else if (fileType === 'audio') {
        // Voice note — no presence typing indicator
        payload.audio = { url: filePath }
        payload.ptt = true              // Send as voice note
      } else {
        await this.sock.sendPresenceUpdate('composing', jid)
        payload.document = { url: filePath }
        if (caption) payload.caption = caption
      }

      await this.sock.sendMessage(jid, payload as any, quoted ? { quoted } : undefined)
    } catch (err) {
      logger.error({ err, filePath, fileType }, 'Failed to send file')
    }
  }

  /** React to a message */
  async react(jid: string, messageKey: any, emoji: string): Promise<void> {
    try {
      await this.sock.sendMessage(jid, { react: { key: messageKey, text: emoji } } as any)
    } catch (err) {
      logger.error({ err }, 'Failed to react')
    }
  }

  /** Send an interactive list menu (dropdown-style command list) */
  async sendListMenu(
    jid: string,
    title: string,
    text: string,
    footer: string,
    buttonText: string,
    sections: Array<{
      title: string
      rows: Array<{ title: string; description?: string; rowId: string }>
    }>
  ): Promise<boolean> {
    try {
      await this.sock.sendMessage(jid, {
        text,
        footer,
        title,
        buttonText,
        sections,
      } as any)
      return true
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send list menu')
      return false
    }
  }

  /** Send quick reply buttons for fast actions */
  async sendQuickButtons(
    jid: string,
    text: string,
    footer: string,
    buttons: Array<{ id: string; text: string }>
  ): Promise<boolean> {
    try {
      await this.sock.sendMessage(jid, {
        text,
        footer,
        buttons: buttons.map(button => ({
          buttonId: button.id,
          buttonText: { displayText: button.text },
          type: 1,
        })),
        headerType: 1,
      } as any)
      return true
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send quick buttons')
      return false
    }
  }

  /**
   * Send interactive quick-reply buttons (the modern "button list" that renders
   * as tappable buttons under the message, like WA Business quick replies).
   * Works on Baileys 6.4.0+.
   */
  async sendInteractiveButtons(
    jid: string,
    text: string,
    footer: string,
    buttons: Array<{ id: string; text: string }>
  ): Promise<boolean> {
    try {
      await this.sock.sendMessage(jid, {
        text,
        footer,
        interactiveButtons: buttons.map(button => ({
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({
            display_text: button.text,
            id: button.id,
          }),
        })),
      } as any)
      return true
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send interactive buttons')
      return false
    }
  }

  /** Set presence status (typing, recording, etc) */
  async sendPresence(jid: string, presence: 'composing' | 'recording'): Promise<void> {
    try {
      // Fire-and-forget the subscribe so it can never block the actual presence
      // send (a slow/hanging subscribe was preventing 'composing' from going out).
      this.sock.presenceSubscribe(jid).catch(() => {})
      await this.sock.sendPresenceUpdate(presence, jid)

      // For @lid JIDs, WhatsApp sometimes only shows the typing bubble when the
      // presence is addressed by the phone-number (@s.whatsapp.net) form. If the
      // lid belongs to the owner, also send presence to the owner's PN JID.
      if (jid.endsWith('@lid') && config.OWNER_LID && config.OWNER_NUMBER) {
        const lidDigits = jid.replace(/[^0-9]/g, '')
        if (lidDigits === config.OWNER_LID) {
          const pnJid = `${config.OWNER_NUMBER}@s.whatsapp.net`
          this.sock.presenceSubscribe(pnJid).catch(() => {})
          await this.sock.sendPresenceUpdate(presence, pnJid).catch(() => {})
        }
      }

      logger.info({ jid, presence }, 'Presence update sent')
    } catch (err) {
      logger.error({ err, jid, presence }, 'Failed to send presence')
    }
  }

  /**
   * WhatsApp only shows a contact's "typing…" indicator when that contact's
   * "Last seen & online" privacy setting permits it. A fresh bot account often
   * defaults to "My contacts" (and the bot has no contacts), so the owner never
   * sees the typing bubble even though the chatstate node is sent correctly.
   * Setting online + last-seen to "everyone" makes the typing indicator visible.
   */
  private async ensurePresencePrivacy(): Promise<void> {
    if (this.presencePrivacyEnsured) return
    try {
      const current = await this.sock.fetchPrivacySettings()
      logger.info({ privacy: current }, 'Current privacy settings')
      const online = current?.online
      const last = current?.last
      if (online !== 'all' || last !== 'all') {
        await this.sock.updateOnlinePrivacy('all')
        await this.sock.updateLastSeenPrivacy('all')
        // Re-fetch (force) to confirm the server actually applied the change —
        // some accounts reject setting `online` independently (e.g. it stays
        // "match_last_seen"), in which case we know it's a server limitation.
        await this.sleep(1500)
        const after = await this.sock.fetchPrivacySettings(true)
        logger.info(
          { beforeOnline: online, beforeLast: last, afterOnline: after?.online, afterLast: after?.last },
          'Presence privacy update verification'
        )
        if (after?.online === 'all' || after?.last === 'all') {
          logger.info('✅ Presence privacy is now "everyone" — typing indicator should be visible')
        } else {
          logger.warn('⚠️ WhatsApp did NOT apply the online privacy change — typing bubble may stay hidden (server limitation)')
        }
        this.presencePrivacyEnsured = true
      } else {
        logger.info('Presence privacy already "everyone" — typing indicator should be visible')
        this.presencePrivacyEnsured = true
      }
    } catch (err) {
      logger.error({ err }, 'Failed to ensure presence privacy (will retry on next connect)')
    }
  }

  /** Download media from a message */
  async downloadMedia(msg: WAMessage): Promise<Buffer | null> {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger: pino({ level: 'silent' }) as any,
        reuploadRequest: this.sock.updateMediaMessage
      })
      return buffer as Buffer
    } catch (err) {
      logger.error({ err }, 'Failed to download media')
      return null
    }
  }

  /** Get connection status */
  get status(): { connected: boolean } {
    return { connected: this.connected }
  }

  /** Exponential backoff with jitter, capped to avoid hammering the server */
  private reconnectBackoffMs(attempt: number): number {
    return Math.min(attempt * 3000 + Math.floor(Math.random() * 1500), 20000)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  private async onConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect } = update

    if (this.shuttingDown) return

    if (connection === 'close') {
      this.connected = false
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const statusMessage = (lastDisconnect?.error as Boom)?.output?.payload?.message
      const isLoggedOut = statusCode === DisconnectReason.loggedOut

      // 403/503 = banned/restricted server-side — DO NOT reconnect automatically
      const RESTRICTIVE_STATUSES = [403, 503]
      const isRestricted = RESTRICTIVE_STATUSES.includes(statusCode)

      logger.warn({ statusCode, statusMessage, isLoggedOut, isRestricted }, 'Connection closed.')

      if (isRestricted) {
        logger.error(
          { statusCode },
          '⚠️ WhatsApp is restricting this account (403/503/banned). STOPPING auto-reconnect to avoid worsening the restriction. Restart the bot manually later (after the review is resolved).'
        )
        return // Do NOT auto-reconnect — wait for manual intervention
      }

      // Baileys often reports this when the server simply wants us to restart the socket
      // (e.g. after a long idle or a credential refresh), NOT when the session is truly gone.
      // We must NOT delete the session folder here — that would cause a permanent 401 loop
      // and force the user to re-scan the QR code on every transient disconnect.
      if (statusCode === DisconnectReason.restartRequired) {
        this.reconnectAttempts++
        logger.warn({ reconnectAttempt: this.reconnectAttempts }, 'Server requested restart — reconnecting with existing session')
        await this.sleep(this.reconnectBackoffMs(this.reconnectAttempts))
        this.start()
        return
      }

      // True logout (401) — but Baileys often reports loggedOut on *transient* errors too,
      // especially right after sending a message. Deleting the folder immediately would
      // cause a permanent 401 loop and force a fresh QR scan for nothing.
      // We NEVER delete the session automatically here: wiping a still-valid session is
      // destructive and forces the user to re-scan. Instead we retry with the existing
      // session a few times, then stop and ask for manual inspection if it keeps failing.
      if (isLoggedOut) {
        this.reconnectAttempts++

        if (this.reconnectAttempts < 4) {
          logger.warn(
            { reconnectAttempt: this.reconnectAttempts },
            'Connection closed (401). Retrying with existing session (session NOT deleted)'
          )
          await this.sleep(this.reconnectBackoffMs(this.reconnectAttempts))
          this.start()
          return
        }

        // Give up after several attempts, but keep the session folder intact so the user
        // can investigate (and maybe just restart) without losing their login.
        logger.error(
          { reconnectAttempt: this.reconnectAttempts },
          'Repeated 401 disconnects. NOT deleting session — check account/session manually, then restart the bot.'
        )
        return
      }

      // Normal transient disconnect (network drop etc.) — reconnect with a bounded backoff.
      this.reconnectAttempts++
      const delay = this.reconnectBackoffMs(this.reconnectAttempts)
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        logger.info({ reconnectAttempt: this.reconnectAttempts, delay }, 'Attempting reconnect...')
        this.start()
      }, delay)
    } else if (connection === 'open') {
      this.connected = true
      // Reset reconnect attempts on successful connect
      this.reconnectAttempts = 0
      // Clear any pending reconnect timer now that we're open
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      logger.info('✅ WhatsApp connected successfully!')
      // Refresh the set of bot LIDs (needed to detect @mentions in groups).
      this.botLids = await this.loadBotLids()
      logger.info({ botLids: this.botLids }, 'Loaded bot LIDs for group mention detection')
      // Ensure the bot's presence privacy lets others see the typing indicator.
      this.ensurePresencePrivacy()
    }

    if (update.qr) {
      // Print QR manually since Baileys logger is silenced
      // @ts-ignore — qrcode package provides toString but bundled @types is broken
      QRCode.toString(update.qr, { type: 'terminal', small: true }, (err: any, qrCodeString: string) => {
        if (!err) {
          console.log(qrCodeString)
        } else {
          logger.error({ err }, 'Failed to print QR code')
        }
      })
      logger.info('📱 Scan the QR code above with WhatsApp!')
    }
  }

  private async onMessagesUpsert({ messages }: { messages: WAMessage[] }): Promise<void> {
    if (!this.messageHandler) return

    const now = Date.now()
    for (const msg of messages) {
      // Skip status broadcast, own messages, ephemeral events
      if (!msg.key || msg.key.fromMe) continue
      if (msg.key.remoteJid === 'status@broadcast') continue

      // Dedup: skip if this exact message was already processed (Baileys can
      // re-emit the same message on reconnect/backfill → caused duplicate replies).
      const msgId = msg.key.id
      if (msgId) {
        if (this.processedIds.has(msgId)) continue
        this.processedIds.add(msgId)
        // Keep the set bounded.
        if (this.processedIds.size > WhatsAppClient.PROCESSED_MAX) {
          const oldest = this.processedIds.values().next().value
          if (oldest) this.processedIds.delete(oldest)
        }
      }

      // Skip stale/backfill messages that are too old to be a live conversation.
      // Without this, the bot re-replies to old messages after a reconnect.
      const tsSec = msg.messageTimestamp
      const tsMs = typeof tsSec === 'number' ? tsSec * 1000
        : (tsSec && typeof (tsSec as any).low === 'number') ? (tsSec as any).low * 1000
        : now
      if (now - tsMs > WhatsAppClient.OLD_MSG_MS) continue

      const parsed = this.parseMessage(msg)
      if (!parsed) continue

      // Fire async (don't block the event loop)
      this.messageHandler(parsed).catch(err => {
        logger.error({ err, jid: parsed.jid }, 'Error handling message')
      })
    }
  }

  private parseMessage(msg: WAMessage): IncomingMessage | null {
    const jid = msg.key.remoteJid!
    const isGroup = jid.endsWith('@g.us')
    // key.participant is null for some group messages (protocol messages,
    // system notifications, device-list updates, sender-key distribution, …),
    // so fall back to the group jid instead of crashing on .replace().
    const sender = isGroup ? (msg.key.participant || jid) : jid
    const participant = isGroup ? (msg.key.participant || undefined) : undefined

    // Extract text content
    const fullMsg = msg.message
    if (!fullMsg) return null

    let text = ''
    let messageType: MessageContentType = 'text'
    let hasMedia = false

    // Button / List / Interactive / Template responses — when a user taps a menu
    // button or list row, WhatsApp does NOT send plain text; it sends a response
    // message containing the selected ID. We map that back to the command text so
    // the bot can execute it (e.g. tapping a row with rowId ".menu" → ".menu").
    const btn = fullMsg.buttonsResponseMessage
    const list = fullMsg.listResponseMessage
    const inter = fullMsg.interactiveResponseMessage
    const tpl = fullMsg.templateButtonReplyMessage

    if (list?.singleSelectReply?.selectedRowId) {
      text = list.singleSelectReply.selectedRowId
    } else if (btn?.selectedButtonId) {
      text = btn.selectedButtonId
    } else if (tpl?.selectedId) {
      text = tpl.selectedId
    } else if (inter) {
      // Native-flow / interactive responses carry the picked id inside paramsJson.
      try {
        const params = JSON.parse(inter.nativeFlowResponseMessage?.paramsJson || '{}')
        text = params?.id || ''
      } catch {
        text = ''
      }
    }

    // ExtendedTextMessage (only if not already filled by a button/list response)
    if (!text && fullMsg.extendedTextMessage?.text) {
      text = fullMsg.extendedTextMessage.text
    }
    // Conversation
    else if (!text && fullMsg.conversation) {
      text = fullMsg.conversation
    }
    // Image with caption
    else if (!text && fullMsg.imageMessage?.caption) {
      text = fullMsg.imageMessage.caption
      messageType = 'image'
      hasMedia = true
    }
    // Image without caption
    else if (fullMsg.imageMessage) {
      messageType = 'image'
      hasMedia = true
    }
    // Video
    else if (fullMsg.videoMessage?.caption) {
      text = fullMsg.videoMessage.caption
      messageType = 'video'
      hasMedia = true
    }
    else if (fullMsg.videoMessage) {
      messageType = 'video'
      hasMedia = true
    }
    // Document
    else if (fullMsg.documentMessage?.caption) {
      text = fullMsg.documentMessage.caption
      messageType = 'document'
      hasMedia = true
    }
    // Audio / voice note
    else if (fullMsg.audioMessage) {
      messageType = 'audio'
      hasMedia = true
    }
    else if (fullMsg.stickerMessage) {
      messageType = 'sticker'
      hasMedia = true
    }

    // Extract quoted text if replying to a message
    const quotedMsg = fullMsg.extendedTextMessage?.contextInfo?.quotedMessage
    let quotedText: string | undefined
    if (quotedMsg) {
      quotedText =
        quotedMsg.conversation ||
        quotedMsg.extendedTextMessage?.text ||
        quotedMsg.extendedTextMessage?.matchedText ||
        quotedMsg.extendedTextMessage?.canonicalUrl ||
        quotedMsg.extendedTextMessage?.contextInfo?.externalAdReply?.sourceUrl ||
        quotedMsg.imageMessage?.caption ||
        quotedMsg.videoMessage?.caption ||
        undefined
    }

    // Clean the phone number — strip @s.whatsapp.net etc.
    const phoneNumber = sender.replace(/[^0-9]/g, '')

    const botId = this.sock?.user?.id?.split(':')[0] || ''
    const contextInfo = fullMsg.extendedTextMessage?.contextInfo

    // A message is "addressed to the bot" if it mentions:
    //  - the bot's phone number (6282265468133…), or
    //  - the bot's Linked-ID / LID (17119840362715…), which is how WA reports @mentions
    //    internally (e.g. "17119840362715@lid"), or
    //  - the configured owner number (for convenience).
    const ownerNumber = config.OWNER_NUMBER
    const ownerLid = config.OWNER_LID
    const botLid = config.BOT_LID
    // Include the socket's own id, owner number + owner LID, configured BOT_LID,
    // and every bot LID loaded from tctoken files — so group @mentions are
    // recognized even when WA reports them as an LID (owner or bot).
    const knownIds = [botId, ownerNumber, ownerLid, botLid, ...this.botLids].filter(Boolean)
    const normalize = (s: string) => s.replace(/[^0-9]/g, '')
    const isMentioningBot = (jid?: string | null) => {
      if (!jid) return false
      const n = normalize(jid)
      if (!n) return false
      return knownIds.some(id => n.includes(normalize(id)))
    }

    const isBotMentioned = contextInfo?.mentionedJid?.some((j: string) => isMentioningBot(j)) || false
    const isReplyToBot = isMentioningBot(contextInfo?.participant) || false

    return {
      jid,
      sender: phoneNumber,
      text,
      messageType,
      hasMedia,
      quotedText,
      isGroup,
      participant,
      isBotMentioned,
      isReplyToBot,
      raw: msg,
    }
  }
}

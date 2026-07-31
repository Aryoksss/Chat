// ============================================================
// WhatsApp Client — Baileys connection manager
// ============================================================
// Handles: connect, reconnect, QR login, session persist, events

import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
import QRCode from 'qrcode'
import { config } from '../system/config.js'
import type { IncomingMessage, MessageContentType } from './types.js'
import type { WAMessage, WASocket } from '@whiskeysockets/baileys'

const logger = pino({ transport: { target: 'pino-pretty' }, level: config.LOG_LEVEL })

export type MessageHandlerFn = (msg: IncomingMessage) => Promise<void>

export class WhatsAppClient {
  public sock!: WASocket
  private messageHandler?: MessageHandlerFn
  private connected = false
  private reconnectAttempts = 0
  private isConnecting = false // Prevent concurrent connections
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  /** Start connection with Baileys */
  async start(): Promise<void> {
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

      this.sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        // Silent all Baileys internal logging
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        logger: pino({ level: 'silent' }) as any,
        browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: true,
        // Add connection timeout
        connectTimeoutMs: 60000,
      })

      // Save credentials after login (so next start doesn't need QR)
      this.sock.ev.on('creds.update', saveCreds)

      // Handle connection updates
      this.sock.ev.on('connection.update', this.onConnectionUpdate.bind(this))

      // Handle incoming messages
      this.sock.ev.on('messages.upsert', this.onMessagesUpsert.bind(this))

      logger.info('🤖 WhatsApp Bot starting...')
    } finally {
      this.isConnecting = false
    }
  }

  /** Set the handler for every incoming message */
  onMessage(handler: MessageHandlerFn): void {
    this.messageHandler = handler
  }

  /** Send a text message — using quoted message for delivery reliability */
  async sendText(jid: string, text: string): Promise<void> {
    try {
      logger.info({ jid, textLength: text?.length, textPreview: text?.substring(0, 50) }, 'sendText: sending')

      // Send presence (typing) to improve delivery reliability
      await this.sock.sendPresenceUpdate('composing', jid)

      const result = await this.sock.sendMessage(jid, { text })
      logger.info({ result }, 'sendText: sent')
    } catch (err: any) {
      // Log full error details — don't hide them
      logger.error({ err, jid, textLength: text?.length }, 'Failed to send text message')
      // Don't throw — let caller continue
    }
  }

  /** Send a file (sticker, image, video, document, audio) */
  async sendFile(
    jid: string,
    filePath: string,
    fileType: 'sticker' | 'image' | 'video' | 'document' | 'audio',
    caption?: string
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

      await this.sock.sendMessage(jid, payload as any)
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

  /** Set presence status (typing, recording, etc) */
  async sendPresence(jid: string, presence: 'composing' | 'recording'): Promise<void> {
    try {
      await this.sock.sendPresenceUpdate(presence, jid)
    } catch (err) {
      logger.error({ err }, 'Failed to send presence')
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

  private async onConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
      this.connected = false
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
      const isLoggedOut = statusCode === DisconnectReason.loggedOut

      // 403/503 = banned/restricted server-side — DO NOT reconnect automatically
      // 401 = session expired, auth invalid — try to reconnect (credentials may still be valid after refresh)
      const RESTRICTIVE_STATUSES = [403, 503]
      const isRestricted = RESTRICTIVE_STATUSES.includes(statusCode)

      logger.warn({ statusCode, isLoggedOut, isRestricted }, 'Connection closed.')

      if (isRestricted) {
        logger.error(
          { statusCode },
          '⚠️ WhatsApp is restricting this account (403/503/banned). STOPPING auto-reconnect to avoid worsening the restriction. Restart the bot manually later (after the review is resolved).'
        )
        return // Do NOT auto-reconnect — wait for manual intervention
      }

      // 401 = loggedOut (session expired). Session is invalid — delete and require re-auth.
      // Same behavior as Knightbot-MD: no retry, just clean up and stop.
      if (statusCode === 401 || isLoggedOut) {
        // Clear any previously scheduled reconnect
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
        }

        try {
          fs.rmSync(config.SESSION_DIR, { recursive: true, force: true })
          logger.error('Session logged out (401). Session folder deleted. Please re-authenticate (scan QR).')
        } catch (err) {
          logger.error({ err }, 'Failed to remove session folder after loggedOut')
        }

        return // Do NOT auto-reconnect — session is invalid
      }

      // Normal transient disconnect — reconnect after 5 seconds (same as Knightbot-MD)
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        logger.info('Attempting reconnect...')
        this.start()
      }, 5000)
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

    for (const msg of messages) {
      // Skip status broadcast, own messages, ephemeral events
      if (!msg.key || msg.key.fromMe) continue
      if (msg.key.remoteJid === 'status@broadcast') continue

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
    const sender = isGroup ? msg.key.participant! : jid
    const participant = isGroup ? (msg.key.participant || undefined) : undefined

    // Extract text content
    const fullMsg = msg.message
    if (!fullMsg) return null

    let text = ''
    let messageType: MessageContentType = 'text'
    let hasMedia = false

    // ExtendedTextMessage
    if (fullMsg.extendedTextMessage?.text) {
      text = fullMsg.extendedTextMessage.text
    }
    // Conversation
    else if (fullMsg.conversation) {
      text = fullMsg.conversation
    }
    // Image with caption
    else if (fullMsg.imageMessage?.caption) {
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
    // Sticker
    else if (fullMsg.stickerMessage) {
      messageType = 'sticker'
      hasMedia = true
    }
    // Document
    else if (fullMsg.documentMessage?.caption) {
      text = fullMsg.documentMessage.caption
      messageType = 'document'
      hasMedia = true
    }

    // Extract quoted text if replying to a message
    const quotedMsg = fullMsg.extendedTextMessage?.contextInfo?.quotedMessage
    let quotedText: string | undefined
    if (quotedMsg) {
      quotedText =
        quotedMsg.conversation ||
        quotedMsg.extendedTextMessage?.text ||
        quotedMsg.imageMessage?.caption ||
        quotedMsg.videoMessage?.caption ||
        undefined
    }

    // Clean the phone number — strip @s.whatsapp.net etc.
    const phoneNumber = sender.replace(/[^0-9]/g, '')

    const botId = this.sock?.user?.id?.split(':')[0] || ''
    const contextInfo = fullMsg.extendedTextMessage?.contextInfo
    const isBotMentioned = contextInfo?.mentionedJid?.some((j: string) => j.includes(botId)) || false
    const isReplyToBot = contextInfo?.participant?.includes(botId) || false

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

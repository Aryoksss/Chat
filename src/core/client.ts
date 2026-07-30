// ============================================================
// WhatsApp Client — Baileys connection manager
// ============================================================
// Handles: connect, reconnect, QR login, session persist, events

import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { config } from '../system/config.js'
import type { IncomingMessage } from './types.js'
import type { WAMessage, WASocket } from '@whiskeysockets/baileys'

const logger = pino({ transport: { target: 'pino-pretty' }, level: config.LOG_LEVEL })

export type MessageHandlerFn = (msg: IncomingMessage) => Promise<void>

export class WhatsAppClient {
  public sock!: WASocket
  private messageHandler?: MessageHandlerFn
  private connected = false

  /** Start connection with Baileys */
  async start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(config.SESSION_DIR)

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }), // Baileys internal pino — we use our own
      browser: ['WhatsApp Bot', 'Chrome', '1.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,     // Don't spam online status
    })

    // Save credentials after login (so next start doesn't need QR)
    this.sock.ev.on('creds.update', saveCreds)

    // Handle connection updates
    this.sock.ev.on('connection.update', this.onConnectionUpdate.bind(this))

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', this.onMessagesUpsert.bind(this))

    logger.info('🤖 WhatsApp Bot starting...')
  }

  /** Set the handler for every incoming message */
  onMessage(handler: MessageHandlerFn): void {
    this.messageHandler = handler
  }

  /** Send a text message */
  async sendText(jid: string, text: string): Promise<void> {
    try {
      await this.sock.sendMessage(jid, { text })
    } catch (err) {
      logger.error({ err }, 'Failed to send text message')
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
        payload.image = { url: filePath }
        if (caption) payload.caption = caption
      } else if (fileType === 'video') {
        payload.video = { url: filePath }
        if (caption) payload.caption = caption
      } else if (fileType === 'audio') {
        payload.audio = { url: filePath }
        payload.ptt = true              // Send as voice note
      } else {
        payload.document = { url: filePath }
        if (caption) payload.caption = caption
      }

      await this.sock.sendMessage(jid, payload)
    } catch (err) {
      logger.error({ err, filePath, fileType }, 'Failed to send file')
    }
  }

  /** React to a message */
  async react(jid: string, messageKey: any, emoji: string): Promise<void> {
    try {
      await this.sock.sendMessage(jid, { react: { key: messageKey, text: emoji } })
    } catch (err) {
      logger.error({ err }, 'Failed to react')
    }
  }

  /** Get connection status */
  get status(): { connected: boolean } {
    return { connected: this.connected }
  }

  private async onConnectionUpdate(update: any): Promise<void> {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut

      logger.warn('Connection closed. Reconnecting:', shouldReconnect)

      if (shouldReconnect) {
        this.start() // Auto-reconnect
      } else {
        logger.error('Logged out. Delete session folder and re-login.')
      }
    } else if (connection === 'open') {
      this.connected = true
      logger.info('✅ WhatsApp connected successfully!')
    }

    if (update.qr) {
      // QR will be printed by Baileys printQRInTerminal
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
    const participant = isGroup ? msg.key.participant : undefined

    // Extract text content
    const fullMsg = msg.message
    if (!fullMsg) return null

    let text = ''
    let messageType: any = 'text'
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
        quotedMsg.videoMessage?.caption
    }

    // Clean the phone number — strip @s.whatsapp.net etc.
    const phoneNumber = sender.replace(/[^0-9]/g, '')

    return {
      jid,
      sender: phoneNumber,
      text,
      messageType,
      hasMedia,
      quotedText,
      isGroup,
      participant,
      raw: msg,
    }
  }
}

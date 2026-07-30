// ============================================================
// Message Handler — main pipeline: WA → AI → response
// ============================================================

import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { router } from '../core/router.js'
import { aiBridge } from '../core/ai.js'
import { memoryManager } from '../memory/manager.js'
import { cmdHandler } from '../system/cmd-handler.js'
import { toolExecutor } from '../tools/executor.js'
import type { IncomingMessage, PersonaConfig, PersonaType } from '../core/types.js'
import type { WhatsAppClient } from '../core/client.js'

export class MessageHandler {
  private personas = new Map<'owner' | 'group', PersonaConfig>()

  /** Set current persona configs (called after load/reload) */
  setPersonas(personas: Map<'owner' | 'group', PersonaConfig>): void {
    this.personas = personas
    logger.info('Personas updated in message handler')
  }

  /** Get current persona map */
  getPersonas(): Map<'owner' | 'group', PersonaConfig> {
    return this.personas
  }

  /** Handle one incoming message — the main pipeline */
  async handle(msg: IncomingMessage, client: WhatsAppClient): Promise<void> {
    // 1. Route the message
    const personaType = router.route(msg.jid, msg.sender, msg.isGroup)
    if (!personaType) return // Ignore unknown chats

    logger.info({ persona: personaType, text: msg.text.slice(0, 50) }, 'Incoming message')

    // 2. Check for system command (owner only)
    if (personaType === 'owner' && msg.text.startsWith('/')) {
      const handled = await cmdHandler.handle(msg, client)
      if (handled) return
      // If not a recognized command, continue to AI
    }

    // 3. Check for prefix command (.st, .yt, .ig etc) — fallback direct execution
    if (msg.text.startsWith(config.PREFIX)) {
      const handled = await this.handlePrefixCommand(msg, client)
      if (handled) return
    }

    // 4. Get persona config
    const persona = this.personas.get(personaType)
    if (!persona) {
      logger.warn({ personaType }, 'No persona config found')
      return
    }

    // 5. Load memory
    const memory = await memoryManager.getContent()

    // 6. Build system prompt
    const systemPrompt = aiBridge.buildSystemPrompt(persona.agent, persona.soul, memory)

    // 7. Prepare user message text
    let userText = msg.text
    if (msg.quotedText) {
      userText = `${msg.text}\n\n(Membalas pesan: "${msg.quotedText}")`
    }

    // 8. Send typing indicator (reaction)
    await client.react(msg.jid, msg.raw.key, '🤔')

    // 9. Call AI with tool calling loop
    try {
      // Create context for tool handlers
      const toolContext = {
        sock: client.sock,
        jid: msg.jid,
        participant: msg.participant,
      }

      // Wrap tool handlers with context
      const handlerMap = toolExecutor.createHandlerMap(toolContext)

      const response = await aiBridge.chatWithTools(
        systemPrompt,
        userText,
        persona.tools,
        handlerMap,
      )

      // 10. Send response back to WhatsApp
      if (response && response.trim()) {
        await client.sendText(msg.jid, response)

        // 11. Save to memory
        await memoryManager.append(
          `${msg.sender}: ${msg.text.slice(0, 100)}\nBot: ${response.slice(0, 100)}`
        )
      }
    } catch (err: any) {
      logger.error({ err }, 'AI processing failed')
      await client.sendText(
        msg.jid,
        `Maaf, ada error: ${err.message || 'gagal proses pesan'}`
      )
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

    // Check if tool exists
    if (!toolExecutor.executeToolCall(toolName, {}, {
      sock: client.sock,
      jid: msg.jid,
      participant: msg.participant,
    })) return false

    // Execute
    const toolContext = {
      sock: client.sock,
      jid: msg.jid,
      participant: msg.participant,
    }

    // Parse args
    const parsedArgs = this.parseCommandArgs(command, args, msg)

    logger.info({ command, toolName, args: parsedArgs }, 'Prefix command executed')

    try {
      const result = await toolExecutor.executeToolCall(toolName, parsedArgs, toolContext)

      // If tool sent a file (sticker, download), don't send text
      if (!result.startsWith('✅') && !result.startsWith('❌')) {
        // Result is probably already handled by tool
      } else {
        await client.sendText(msg.jid, result)
      }
    } catch (err: any) {
      await client.sendText(msg.jid, `❌ Error: ${err.message}`)
    }

    return true
  }

  /** Parse command arguments based on command type */
  private parseCommandArgs(
    command: string,
    args: string[],
    msg: IncomingMessage
  ): Record<string, unknown> {
    const parsed: Record<string, unknown> = {}

    switch (command) {
      case 'st':
      case 'sticker':
        // Sticker: reply gambar atau kirim gambar
        parsed.imageType = 'reply'
        break

      case 'yt':
      case 'youtube':
        parsed.url = args[0] || ''
        parsed.format = args.includes('--audio') || args.includes('-a') ? 'audio' : 'video'
        break

      case 'ig':
      case 'instagram':
        parsed.url = args[0] || ''
        break

      case 'tt':
      case 'tiktok':
        parsed.url = args[0] || ''
        break

      case 'tw':
      case 'twitter':
        parsed.url = args[0] || ''
        break

      case 'brainly':
        parsed.query = args.join(' ')
        break

      case 'qr':
        parsed.text = args.join(' ')
        break

      case 'translate':
      case 'tr':
        parsed.text = args.slice(1).join(' ')
        parsed.to = args[0] || 'id'
        break

      case 'shortlink':
      case 'short':
        parsed.url = args[0] || ''
        break

      case 'weather':
        parsed.city = args.join(' ')
        break
    }

    return parsed
  }
}

/** Map command prefix to internal tool name */
const PREFIX_MAP: Record<string, string> = {
  'st': 'sticker',
  'sticker': 'sticker',
  'yt': 'yt-dl',
  'youtube': 'yt-dl',
  'ig': 'ig-dl',
  'instagram': 'ig-dl',
  'tt': 'tt-dl',
  'tiktok': 'tt-dl',
  'tw': 'tw-dl',
  'twitter': 'tw-dl',
  'brainly': 'brainly',
  'qr': 'qr',
  'translate': 'translate',
  'tr': 'translate',
  'shortlink': 'shortlink',
  'short': 'shortlink',
  'weather': 'weather',
  'anime': 'anime',
  'to-pdf': 'to-pdf',
  'pdf': 'to-pdf',
}

export const messageHandler = new MessageHandler()

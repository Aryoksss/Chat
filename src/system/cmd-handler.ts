// ============================================================
// System Command Handler — /reload, /status, /model, /log, dll
// ============================================================

import { logger } from './logger.js'
import { memoryManager } from '../memory/manager.js'
import { personaLoader } from '../persona/loader.js'
import { messageHandler } from '../message/handler.js'
import { toolsRegistry } from '../tools/registry.js'
import { config } from './config.js'
import type { IncomingMessage } from '../core/types.js'
import type { WhatsAppClient } from '../core/client.js'
import type { PersonaConfig } from '../persona/types.js'

export class CommandHandler {
  /** Handle system command — returns true if command was recognized */
  async handle(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const cmd = msg.text.slice(1).trim().toLowerCase().split(/\s+/)
    const command = cmd[0]
    const args = cmd.slice(1)

    switch (command) {
      case 'reload':
        return this.cmdReload(msg, client)
      case 'status':
        return this.cmdStatus(msg, client)
      case 'model':
        return this.cmdModel(args, msg, client)
      case 'log':
        return this.cmdLog(msg, client)
      case 'memory':
        return this.cmdMemory(msg, client)
      case 'clear':
        return this.cmdClear(msg, client)
      default:
        return false // Not a system command
    }
  }

  /** /reload — reload all personas without restarting bot */
  private async cmdReload(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    await client.sendText(msg.jid, '🔄 Reloading personas...')
    try {
      const personas = await personaLoader.loadAll()
      messageHandler.setPersonas(personas)
      await client.sendText(msg.jid, `✅ Reload berhasil! ${personas.size} persona dimuat.`)
      logger.info('Personas reloaded via command')
    } catch (err: any) {
      await client.sendText(msg.jid, `❌ Reload gagal: ${err.message}`)
    }
    return true
  }

  /** /status — show bot connection status */
  private async cmdStatus(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const status = client.status
    const toolCount = toolsRegistry.listTools().length
    const uptime = process.uptime()
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`

    const statusText = `🤖 *Bot Status*
📡 Koneksi: ${status.connected ? '✅ Tersambung' : '❌ Terputus'}
🛠 Tools: ${toolCount} terdaftar
⏱ Uptime: ${uptimeStr}
🧠 Model: ${config.AI_MODEL}
📱 Owner: ${config.OWNER_NUMBER.slice(0, 5)}...`

    await client.sendText(msg.jid, statusText)
    return true
  }

  /** /model <name> — change AI model on the fly */
  private async cmdModel(args: string[], msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    if (args.length === 0) {
      await client.sendText(msg.jid, `Model saat ini: ${config.AI_MODEL}\nGunakan /model <nama-model> untuk ganti.`)
      return true
    }

    const newModel = args[0]
    process.env.AI_MODEL = newModel
    // Update the config object too
    ;(config as any).AI_MODEL = newModel

    await client.sendText(msg.jid, `✅ Model diganti ke: ${newModel}`)
    logger.info({ model: newModel }, 'Model changed via command')
    return true
  }

  /** /log — show recent log lines */
  private async cmdLog(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    // Simple: just send current log level info
    await client.sendText(msg.jid, `📋 Log level: ${config.LOG_LEVEL}\nCek terminal untuk log lengkap.`)
    return true
  }

  /** /memory — show current memory content */
  private async cmdMemory(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    try {
      const content = await memoryManager.getContent()
      const truncated = content.length > 1000 ? content.slice(0, 1000) + '\n\n... (truncated)' : content
      await client.sendText(msg.jid, `🧠 *Memory Bot*\n\n${truncated}`)
    } catch (err: any) {
      await client.sendText(msg.jid, `❌ Gagal baca memory: ${err.message}`)
    }
    return true
  }

  /** /clear — clear memory and temp files */
  private async cmdClear(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    await memoryManager.clear()
    await client.sendText(msg.jid, '🧹 Memory dibersihkan!')
    return true
  }
}

export const cmdHandler = new CommandHandler()

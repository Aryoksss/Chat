// ============================================================
// System Command Handler — /reload, /status, /model, /log, dll
// ============================================================

import { logger } from './logger.js'
import { memoryManager } from '../memory/manager.js'
import { personaLoader } from '../persona/loader.js'
import { messageHandler } from '../message/handler.js'
import { toolsRegistry } from '../tools/registry.js'
import { config } from './config.js'
import type { IncomingMessage, PersonaConfig } from '../core/types.js'
import type { WhatsAppClient } from '../core/client.js'

export class CommandHandler {
  /** Handle system command — returns true if command was recognized */
  async handle(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const cmd = msg.text.slice(1).trim().toLowerCase().split(/\s+/)
    const command = cmd[0]
    const args = cmd.slice(1)

    switch (command) {
      case 'menu':
      case 'help':
      case 'commands':
        return this.cmdMenu(msg, client)
      case 'helper':
      case 'ai':
        return this.cmdHelper(msg, client)
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

  /** /menu — send an interactive dropdown-style command list */
  private async cmdMenu(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const prefix = '.'
    const toolDefinitions = toolsRegistry.getDefinitions()
    const sections = this.buildMenuSections(toolDefinitions, prefix)

    const text = 'Pilih command dari dropdown di bawah. Kalau list tidak muncul, bot akan kirim teks cadangan.'
    const footer = `Prefix utama: ${prefix} | Command list otomatis dari tools yang aktif`

    const menuSent = await client.sendListMenu(
      msg.jid,
      '📋 Command List',
      text,
      footer,
      'Lihat Command',
      sections
    )

    await client.sendQuickButtons(
      msg.jid,
      'Pilih aksi cepat di bawah atau pakai dropdown command list.',
      'Quick actions',
      [
        { id: `${prefix}menu`, text: 'Menu' },
        { id: `${prefix}helper`, text: 'Helper' },
        { id: `${prefix}status`, text: 'Status' },
        { id: `${prefix}anime naruto`, text: 'Anime' },
        { id: `${prefix}weather Jakarta`, text: 'Weather' },
      ]
    )

    if (!menuSent) {
      await client.sendText(
        msg.jid,
        this.buildMenuFallback(prefix, toolDefinitions)
      )
    }

    return true
  }

  /** /helper — show AI helper guide and quick suggestions */
  private async cmdHelper(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const helperText = [
      '🤖 *AI Helper*',
      '',
      'Aku bisa bantu jawab pertanyaan, cari info, bantu nulis, translate, cari anime, atau bikin command tertentu.',
      '',
      'Contoh pakai:',
      '• Tulis pesan biasa untuk ngobrol langsung',
      '• .anime naruto',
      '• .translate en halo dunia',
      '• .brainly apa itu fotosintesis',
      '• .weather Jakarta',
      '',
      'Ketik .menu untuk lihat daftar command.',
    ].join('\n')

    await client.sendText(msg.jid, helperText)
    await client.sendQuickButtons(msg.jid, 'Pilih salah satu aksi cepat:', 'AI Helper', [
      { id: '.menu', text: 'Menu' },
      { id: '.anime naruto', text: 'Cari Anime' },
      { id: '.translate id hello', text: 'Translate' },
      { id: '.brainly fotosintesis', text: 'Brainly' },
    ])

    return true
  }

  private buildMenuSections(
    toolDefinitions: Array<{ name: string; description: string }>,
    prefix: string
  ): Array<{ title: string; rows: Array<{ title: string; description?: string; rowId: string }> }> {
    const sections = new Map<string, Array<{ title: string; description?: string; rowId: string }>>()

    for (const tool of toolDefinitions) {
      const meta = this.getToolMenuMeta(tool.name)
      if (!meta) continue

      const rows = sections.get(meta.section) || []
      rows.push({
        title: meta.title,
        description: tool.description,
        rowId: meta.command,
      })
      sections.set(meta.section, rows)
    }

    const output = Array.from(sections.entries()).map(([title, rows]) => ({ title, rows }))

    output.unshift({
      title: 'AI Helper',
      rows: [
        { title: 'Helper Mode', description: 'Panduan pakai AI bot', rowId: '.helper' },
      ],
    })

    // Append owner commands as a fixed section.
    output.push({
      title: 'Owner Commands',
      rows: [
        { title: 'Status', description: 'Cek status bot', rowId: '/status' },
        { title: 'Reload', description: 'Reload persona', rowId: '/reload' },
        { title: 'Model', description: 'Ganti model AI', rowId: '/model gpt-4o-mini' },
        { title: 'Memory', description: 'Lihat memory bot', rowId: '/memory' },
        { title: 'Clear Memory', description: 'Hapus memory bot', rowId: '/clear' },
      ],
    })

    // Keep a predictable order.
    const order = ['AI Helper', 'AI & Search', 'Media Tools', 'Utility', 'Owner Commands']
    output.sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title))

    // Add a quick help entry at the top if no tools were categorized.
    if (output.length === 1) {
      output.unshift({
        title: 'Quick Start',
        rows: [
          { title: 'Helper', description: 'Mode bantuan AI', rowId: '.helper' },
          { title: 'Menu', description: 'Tampilkan menu lagi', rowId: `${prefix}menu` },
          { title: 'Help', description: 'Lihat bantuan', rowId: `${prefix}help` },
        ],
      })
    }

    return output
  }

  private buildMenuFallback(prefix: string, toolDefinitions: Array<{ name: string }>): string {
    const commands = toolDefinitions
      .map(tool => this.getToolMenuMeta(tool.name))
      .filter((meta): meta is NonNullable<ReturnType<CommandHandler['getToolMenuMeta']>> => Boolean(meta))
      .map(meta => `• ${meta.command}`)

    const uniqueCommands = Array.from(new Set([
      '.helper',
      `${prefix}menu`,
      `${prefix}help`,
      ...commands,
      '/status',
      '/reload',
      '/model <nama>',
      '/memory',
      '/clear',
    ]))

    return `📋 *Command List*\n\nGunakan command langsung:\n${uniqueCommands.join('\n')}`
  }

  private getToolMenuMeta(toolName: string): { section: string; title: string; command: string } | null {
    switch (toolName) {
      case 'sticker':
        return { section: 'Media Tools', title: 'Sticker', command: '.sticker' }
      case 'yt-dl':
        return { section: 'Media Tools', title: 'YouTube Download', command: '.yt <url>' }
      case 'ig-dl':
        return { section: 'Media Tools', title: 'Instagram Download', command: '.ig <url>' }
      case 'tt-dl':
        return { section: 'Media Tools', title: 'TikTok Download', command: '.tt <url>' }
      case 'tw-dl':
        return { section: 'Media Tools', title: 'Twitter Download', command: '.tw <url>' }
      case 'brainly':
        return { section: 'AI & Search', title: 'Brainly', command: '.brainly <pertanyaan>' }
      case 'qr':
        return { section: 'Utility', title: 'QR Generator', command: '.qr <teks>' }
      case 'translate':
        return { section: 'Utility', title: 'Translate', command: '.translate <to> <teks>' }
      case 'shortlink':
        return { section: 'Utility', title: 'Shortlink', command: '.shortlink <url>' }
      case 'weather':
        return { section: 'Utility', title: 'Weather', command: '.weather <kota>' }
      case 'anime':
        return { section: 'AI & Search', title: 'Anime Search', command: '.anime <query>' }
      default:
        return null
    }
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

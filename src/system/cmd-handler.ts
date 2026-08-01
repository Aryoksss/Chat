// ============================================================
// System Command Handler — /reload, /status, /log, dll
// ============================================================

import { logger } from './logger.js'
import { memoryManager, memoryScope } from '../memory/manager.js'
import { personaLoader } from '../persona/loader.js'
import { messageHandler } from '../message/handler.js'
import { toolsRegistry } from '../tools/registry.js'
import { config } from './config.js'
import type { IncomingMessage, PersonaConfig } from '../core/types.js'
import type { WhatsAppClient } from '../core/client.js'

export class CommandHandler {
  /** Handle system command — returns true if command was recognized */
  async handle(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const prefix = config.PREFIXES.find(candidate => msg.text.trim().startsWith(candidate))
    if (!prefix) return false

    const cmd = msg.text.trim().slice(prefix.length).trim().toLowerCase().split(/\s+/)
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
    await client.sendText(msg.jid, '🔄 Reloading personas...', msg.raw)
    try {
      const personas = await personaLoader.loadAll()
      messageHandler.setPersonas(personas)
      await client.sendText(msg.jid, `✅ Reload berhasil! ${personas.size} persona dimuat.`, msg.raw)
      logger.info('Personas reloaded via command')
    } catch (err: any) {
      await client.sendText(msg.jid, `❌ Reload gagal: ${err.message}`, msg.raw)
    }
    return true
  }

  /** /menu — send ONLY the interactive dropdown list (WA developer style) */
  private async cmdMenu(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const prefix = config.PREFIX
    const toolDefinitions = toolsRegistry.getDefinitions()
    const sections = this.buildMenuSections(toolDefinitions, prefix, !msg.isGroup)

    const sent = await client.sendListMenu(
      msg.jid,
      '📋 Menu Bot',
      msg.isGroup ? 'Pilih fitur yang tersedia di grup ini.' : 'Pilih command yang ingin digunakan.',
      `Prefix: ${config.PREFIXES.join('  ')}`,
      'Buka Menu',
      sections
    )

    if (!sent) {
      await client.sendText(msg.jid, this.buildMenuFallback(prefix, toolDefinitions, !msg.isGroup), msg.raw)
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
      `Ketik ${config.PREFIX}menu untuk lihat daftar command.`,
    ].join('\n')

    await client.sendText(msg.jid, helperText, msg.raw)
    await client.sendInteractiveButtons(msg.jid, 'Pilih salah satu aksi cepat:', 'AI Helper', [
      { id: `${config.PREFIX}menu`, text: 'Menu' },
      { id: `${config.PREFIX}anime naruto`, text: 'Cari Anime' },
      { id: `${config.PREFIX}translate id hello`, text: 'Translate' },
      { id: `${config.PREFIX}brainly fotosintesis`, text: 'Brainly' },
    ])

    return true
  }

  private buildMenuSections(
    toolDefinitions: Array<{ name: string; description: string }>,
    prefix: string,
    includeOwnerCommands: boolean
  ): Array<{ title: string; rows: Array<{ title: string; description?: string; rowId: string }> }> {
    const sections = new Map<string, Array<{ title: string; description?: string; rowId: string }>>()

    for (const tool of toolDefinitions) {
      const meta = this.getToolMenuMeta(tool.name, prefix)
      if (!meta) continue

      const rows = sections.get(meta.section) || []
      rows.push({
        title: meta.title,
        description: this.compactDescription(tool.description),
        rowId: meta.command,
      })
      sections.set(meta.section, rows)
    }

    const output = Array.from(sections.entries()).map(([title, rows]) => ({ title, rows }))

    output.unshift({
      title: 'AI Helper',
      rows: [
        { title: 'Helper Mode', description: 'Panduan pakai AI bot', rowId: `${prefix}helper` },
      ],
    })

    if (includeOwnerCommands) {
      output.push({
        title: 'Owner',
        rows: [
          { title: 'Status Bot', description: 'Cek koneksi dan uptime', rowId: '/status' },
          { title: 'Reload Persona', description: 'Muat ulang persona bot', rowId: '/reload' },
          { title: 'Lihat Memory', description: 'Lihat memory chat ini', rowId: '/memory' },
          { title: 'Bersihkan Memory', description: 'Hapus memory chat ini', rowId: '/clear' },
        ],
      })
    }

    // Keep a predictable order.
    const order = ['AI Helper', 'AI & Search', 'Media', 'Utility', 'Owner']
    output.sort((a, b) => {
      const aIndex = order.indexOf(a.title)
      const bIndex = order.indexOf(b.title)
      return (aIndex === -1 ? order.length : aIndex) - (bIndex === -1 ? order.length : bIndex)
    })

    // Add a quick help entry at the top if no tools were categorized.
    if (output.length === 1) {
      output.unshift({
          title: 'Quick Start',
          rows: [
          { title: 'Helper', description: 'Mode bantuan AI', rowId: `${prefix}helper` },
          { title: 'Menu', description: 'Tampilkan menu lagi', rowId: `${prefix}menu` },
          { title: 'Help', description: 'Lihat bantuan', rowId: `${prefix}help` },
        ],
      })
    }

    return output
  }

  private buildMenuFallback(prefix: string, toolDefinitions: Array<{ name: string }>, includeOwnerCommands: boolean): string {
    const commands = toolDefinitions
      .map(tool => this.getToolMenuMeta(tool.name, prefix))
      .filter((meta): meta is NonNullable<ReturnType<CommandHandler['getToolMenuMeta']>> => Boolean(meta))
      .map(meta => `• ${meta.command}`)

    const commonCommands = [
      `${prefix}helper`,
      `${prefix}menu`,
      `${prefix}help`,
      ...commands,
    ]
    const ownerCommands = includeOwnerCommands ? ['/status', '/reload', '/memory', '/clear'] : []
    const uniqueCommands = Array.from(new Set([...commonCommands, ...ownerCommands]))

    return `📋 *Menu Bot*\n\nGunakan command langsung:\n${uniqueCommands.join('\n')}`
  }

  private compactDescription(description: string): string {
    const clean = description.replace(/\s+/g, ' ').trim()
    return clean.length > 72 ? `${clean.slice(0, 69)}...` : clean
  }

  private getToolMenuMeta(toolName: string, prefix: string): { section: string; title: string; command: string } | null {
    switch (toolName) {
      case 'sticker':
        return { section: 'Media', title: 'Sticker', command: `${prefix}sticker` }
      case 'yt-dl':
        return { section: 'Media', title: 'YouTube', command: `${prefix}yt <url>` }
      case 'ig-dl':
        return { section: 'Media', title: 'Instagram', command: `${prefix}ig <url>` }
      case 'tt-dl':
        return { section: 'Media', title: 'TikTok', command: `${prefix}tt <url>` }
      case 'tw-dl':
        return { section: 'Media', title: 'Twitter/X', command: `${prefix}tw <url>` }
      case 'brainly':
        return { section: 'AI & Search', title: 'Brainly', command: `${prefix}brainly <soal>` }
      case 'web-search':
        return { section: 'AI & Search', title: 'Cari di Web', command: `${prefix}web-search <query>` }
      case 'qr':
        return { section: 'Utility', title: 'QR Code', command: `${prefix}qr <teks>` }
      case 'img-gen':
        return { section: 'AI & Search', title: 'Buat/Edit Gambar', command: `${prefix}gambar <prompt>` }
      case 'translate':
        return { section: 'Utility', title: 'Translate', command: `${prefix}translate <bahasa> <teks>` }
      case 'shortlink':
        return { section: 'Utility', title: 'Shortlink', command: `${prefix}shortlink <url>` }
      case 'weather':
        return { section: 'Utility', title: 'Cuaca', command: `${prefix}weather <kota>` }
      case 'anime':
        return { section: 'AI & Search', title: 'Cari Anime', command: `${prefix}anime <judul>` }
      case 'anime-search':
        return { section: 'Media', title: 'Cari Anime Download', command: `${prefix}anime-search <judul>` }
      case 'anime-links':
        return { section: 'Media', title: 'Buka Link Hasil Cari', command: `${prefix}anime-links <url|nomor>` }
      case '4khd-search':
        return { section: 'AI & Search', title: 'Cari 4KHD', command: `${prefix}4khd-search <kata kunci>` }
      case '4khd-latest':
        return { section: 'Media', title: '4KHD Terbaru', command: `${prefix}4khd-latest` }
      case '4khd-detail':
        return { section: 'Media', title: 'Galeri 4KHD', command: `${prefix}4khd-detail <url>` }
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

    await client.sendText(msg.jid, statusText, msg.raw)
    return true
  }

  /** /log — show recent log lines */
  private async cmdLog(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    // Simple: just send current log level info
    await client.sendText(msg.jid, `📋 Log level: ${config.LOG_LEVEL}\nCek terminal untuk log lengkap.`, msg.raw)
    return true
  }

  /** /memory — show current memory content */
  private async cmdMemory(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    try {
      const content = await memoryManager.getContent(memoryScope(msg.jid, msg.isGroup))
      const truncated = content.length > 1000 ? content.slice(0, 1000) + '\n\n... (truncated)' : content
      await client.sendText(msg.jid, `🧠 *Memory Bot*\n\n${truncated}`, msg.raw)
    } catch (err: any) {
      await client.sendText(msg.jid, `❌ Gagal baca memory: ${err.message}`, msg.raw)
    }
    return true
  }

  /** /clear — clear memory for the current chat */
  private async cmdClear(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    await memoryManager.clear(memoryScope(msg.jid, msg.isGroup))
    await client.sendText(msg.jid, '🧹 Memory dibersihkan!', msg.raw)
    return true
  }
}

export const cmdHandler = new CommandHandler()

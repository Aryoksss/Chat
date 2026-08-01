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
import { findKnownGroups, getGroupAccess, setGroupAccess } from './group-access.js'
import { deleteStickerFromPool, listStickerMetadata, retagSticker } from '../stickers/archive.js'

type MenuCategory = 'ai' | 'media' | 'utility' | 'group' | 'owner'

export class CommandHandler {
  /** Handle system command — returns true if command was recognized */
  async handle(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const prefix = config.PREFIXES.find(candidate => msg.text.trim().startsWith(candidate))
    if (!prefix) return false

    const cmd = msg.text.trim().slice(prefix.length).trim().split(/\s+/)
    const command = cmd[0]?.toLowerCase()
    const args = cmd.slice(1)

    switch (command) {
      case 'menu':
      case 'help':
      case 'commands':
        return this.cmdMenu(msg, client)
      case 'menu-ai':
        return this.cmdMenuCategory(msg, client, 'ai')
      case 'menu-media':
        return this.cmdMenuCategory(msg, client, 'media')
      case 'menu-utility':
        return this.cmdMenuCategory(msg, client, 'utility')
      case 'menu-group':
        return this.cmdMenuCategory(msg, client, 'group')
      case 'menu-owner':
        return this.cmdMenuCategory(msg, client, 'owner')
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
      case 'group-allow':
        return this.cmdGroupAccess(msg, client, args, true)
      case 'group-block':
        return this.cmdGroupAccess(msg, client, args, false)
      case 'groups':
        return this.cmdGroups(msg, client)
      case 'stickers':
        return this.cmdStickers(msg, client)
      case 'retag':
        return this.cmdRetagSticker(msg, client, args)
      case 'hapus-sticker':
      case 'delete-sticker':
        return this.cmdDeleteSticker(msg, client, args)
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
    const sections = this.buildMenuCategorySections(prefix, !msg.isGroup, msg.isGroup)

    const sent = await client.sendListMenu(
      msg.jid,
      '📋 Menu Bot',
      'Pilih kategori untuk melihat fitur di dalamnya.',
      `Prefix: ${config.PREFIXES.join('  ')}`,
      'Pilih Kategori',
      sections
    )

    if (!sent) {
      await client.sendText(msg.jid, this.buildCategoryFallback(prefix, !msg.isGroup, msg.isGroup), msg.raw)
    }

    return true
  }

  /** Second-level menu containing the commands for one selected category. */
  private async cmdMenuCategory(
    msg: IncomingMessage,
    client: WhatsAppClient,
    category: MenuCategory,
  ): Promise<boolean> {
    if (category === 'group' && !msg.isGroup) {
      await client.sendText(msg.jid, 'Menu Group hanya tersedia di dalam grup.', msg.raw)
      return true
    }
    if (category === 'owner' && msg.isGroup) {
      await client.sendText(msg.jid, 'Menu Owner hanya tersedia di chat pribadi owner.', msg.raw)
      return true
    }

    const prefix = config.PREFIX
    const configByCategory: Record<MenuCategory, { section: string; title: string }> = {
      ai: { section: 'AI & Search', title: '🔎 AI & Pencarian' },
      media: { section: 'Media', title: '🎬 Media' },
      utility: { section: 'Utility', title: '🧰 Utility' },
      group: { section: 'Group', title: '👥 Group' },
      owner: { section: 'Owner', title: '🔐 Owner' },
    }
    const selected = configByCategory[category]
    const allSections = this.buildMenuSections(
      toolsRegistry.getDefinitions(),
      prefix,
      !msg.isGroup,
      msg.isGroup,
    )
    const detail = allSections.find(section => section.title === selected.section)
    if (!detail) {
      await client.sendText(msg.jid, 'Kategori ini belum memiliki fitur.', msg.raw)
      return true
    }

    const sections = [
      detail,
      {
        title: 'Navigasi',
        rows: [{
          title: 'Kembali ke Menu',
          description: 'Pilih kategori lain',
          rowId: `${prefix}menu`,
        }],
      },
    ]
    const sent = await client.sendListMenu(
      msg.jid,
      selected.title,
      'Pilih fitur yang ingin digunakan.',
      `Kembali: ${prefix}menu`,
      'Buka Fitur',
      sections,
    )
    if (!sent) {
      const rows = detail.rows.map(row => `• ${row.rowId}`).join('\n')
      await client.sendText(msg.jid, `${selected.title}\n\n${rows}\n\nKembali: ${prefix}menu`, msg.raw)
    }
    return true
  }

  private buildMenuCategorySections(
    prefix: string,
    includeOwnerCommands: boolean,
    includeGroupCommands: boolean,
  ): Array<{ title: string; rows: Array<{ title: string; description?: string; rowId: string }> }> {
    const rows = [
      { title: 'AI & Pencarian', description: 'Web, AI, anime, gambar, dan 4KHD', rowId: `${prefix}menu-ai` },
      { title: 'Media', description: 'Sticker dan downloader media', rowId: `${prefix}menu-media` },
      { title: 'Utility', description: 'QR, translate, cuaca, reminder, dan job', rowId: `${prefix}menu-utility` },
    ]
    if (includeGroupCommands) {
      rows.push({ title: 'Group', description: 'Anggota dan nama panggilan grup', rowId: `${prefix}menu-group` })
    }
    if (includeOwnerCommands) {
      rows.push({ title: 'Owner', description: 'Status, grup, memory, dan sticker pool', rowId: `${prefix}menu-owner` })
    }

    return [
      { title: 'Kategori Fitur', rows },
      {
        title: 'Panduan',
        rows: [{ title: 'AI Helper', description: 'Contoh penggunaan bot', rowId: `${prefix}helper` }],
      },
    ]
  }

  private buildCategoryFallback(prefix: string, includeOwnerCommands: boolean, includeGroupCommands: boolean): string {
    const lines = [
      `• AI & Pencarian — ${prefix}menu-ai`,
      `• Media — ${prefix}menu-media`,
      `• Utility — ${prefix}menu-utility`,
    ]
    if (includeGroupCommands) lines.push(`• Group — ${prefix}menu-group`)
    if (includeOwnerCommands) lines.push(`• Owner — ${prefix}menu-owner`)
    return `📋 *Menu Bot*\n\nPilih kategori:\n${lines.join('\n')}\n\nPanduan: ${prefix}helper`
  }

  /** /helper — interactive dropdown guide and quick suggestions */
  private async cmdHelper(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const prefix = config.PREFIX
    const sections = [
      {
        title: 'Panduan Kategori',
        rows: [
          { title: 'AI & Pencarian', description: 'Lihat fitur pencarian dan AI', rowId: `${prefix}menu-ai` },
          { title: 'Media', description: 'Lihat sticker dan downloader', rowId: `${prefix}menu-media` },
          { title: 'Utility', description: 'Lihat alat bantu bot', rowId: `${prefix}menu-utility` },
        ],
      },
      {
        title: 'Contoh Cepat',
        rows: [
          { title: 'Cari Anime Naruto', description: `${prefix}anime naruto`, rowId: `${prefix}anime naruto` },
          { title: 'Translate Hello', description: `${prefix}translate id hello`, rowId: `${prefix}translate id hello` },
          { title: 'Cek Cuaca Jakarta', description: `${prefix}weather Jakarta`, rowId: `${prefix}weather Jakarta` },
        ],
      },
      {
        title: 'Navigasi',
        rows: [
          { title: 'Kembali ke Menu', description: 'Buka kategori utama', rowId: `${prefix}menu` },
        ],
      },
    ]
    const sent = await client.sendListMenu(
      msg.jid,
      '🤖 AI Helper',
      'Pilih panduan atau contoh yang ingin dicoba.',
      `Kembali: ${prefix}menu`,
      'Buka Panduan',
      sections,
    )
    if (!sent) {
      await client.sendText(
        msg.jid,
        `🤖 *AI Helper*\n\nPilih kategori lewat ${prefix}menu-ai, ${prefix}menu-media, atau ${prefix}menu-utility.\n\nKembali: ${prefix}menu`,
        msg.raw,
      )
    }

    return true
  }

  private buildMenuSections(
    toolDefinitions: Array<{ name: string; description: string }>,
    prefix: string,
    includeOwnerCommands: boolean,
    includeGroupCommands = true,
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

    // Commands handled locally by MessageHandler, not registered as AI tools.
    const utilityRows = sections.get('Utility') || []
    utilityRows.push(
      { title: 'Job Media', description: 'Lihat proses media yang aktif', rowId: `${prefix}jobs` },
      { title: 'Pengingat Aktif', description: 'Lihat pengingat chat ini', rowId: `${prefix}reminders` },
      { title: 'Batalkan Job', description: 'Batalkan dengan ID job', rowId: `${prefix}cancel` },
    )
    sections.set('Utility', utilityRows)

    if (includeGroupCommands) {
      sections.set('Group', [
        { title: 'Daftar Anggota', description: 'Lihat anggota yang sudah dikenal bot', rowId: `${prefix}anggota` },
        { title: 'Atur Nama', description: 'Simpan nama panggilanmu di grup', rowId: `${prefix}panggil-aku` },
      ])
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
          { title: 'Daftar Grup', description: 'Lihat grup yang dikenal bot', rowId: '/groups' },
          { title: 'Izinkan Grup', description: 'Aktifkan bot di sebuah grup', rowId: '/group-allow' },
          { title: 'Blokir Grup', description: 'Nonaktifkan bot di sebuah grup', rowId: '/group-block' },
          { title: 'Kelola Sticker', description: 'Lihat sticker contextual pool', rowId: '/stickers' },
          { title: 'Tag Sticker', description: 'Atur tag dan deskripsi sticker', rowId: '/retag' },
          { title: 'Hapus Sticker', description: 'Hapus sticker dari pool', rowId: '/hapus-sticker' },
        ],
      })
    }

    // Keep a predictable order.
    const order = ['AI Helper', 'AI & Search', 'Media', 'Utility', 'Group', 'Owner']
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

  private buildMenuFallback(
    prefix: string,
    toolDefinitions: Array<{ name: string }>,
    includeOwnerCommands: boolean,
    includeGroupCommands = true,
  ): string {
    const commands = toolDefinitions
      .map(tool => this.getToolMenuMeta(tool.name, prefix))
      .filter((meta): meta is NonNullable<ReturnType<CommandHandler['getToolMenuMeta']>> => Boolean(meta))
      .map(meta => `• ${meta.command}`)

    const commonCommands = [
      `${prefix}helper`,
      `${prefix}menu`,
      `${prefix}help`,
      `${prefix}jobs`,
      `${prefix}reminders`,
      `${prefix}cancel`,
      ...commands,
    ]
    const groupCommands = includeGroupCommands ? [`${prefix}anggota`, `${prefix}panggil-aku`] : []
    const ownerCommands = includeOwnerCommands
      ? ['/status', '/reload', '/memory', '/clear', '/groups', '/group-allow', '/group-block', '/stickers', '/retag', '/hapus-sticker']
      : []
    const uniqueCommands = Array.from(new Set([...commonCommands, ...groupCommands, ...ownerCommands]))

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
      case 'smeme':
        return { section: 'Media', title: 'Sticker Meme', command: `${prefix}smeme <teks>` }
      case 'sticker-pool':
        return { section: 'Media', title: 'Sticker Pool', command: `${prefix}sticker-pool` }
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
      case 'reminder':
        return { section: 'Utility', title: 'Pengingat', command: `${prefix}reminder` }
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

  private async cmdGroupAccess(msg: IncomingMessage, client: WhatsAppClient, args: string[], allowed: boolean): Promise<boolean> {
    const groupJid = args[0]?.trim()
    if (!groupJid || !/^[0-9-]+@g\.us$/.test(groupJid)) {
      await client.sendText(msg.jid, '❌ Group ID tidak valid.')
      return true
    }
    await setGroupAccess(groupJid, allowed)
    await client.sendText(msg.jid, `${allowed ? '✅ Grup diizinkan' : '🚫 Grup diblokir'}: ${groupJid}`)
    logger.info({ groupJid, allowed }, 'Group access changed by owner')
    return true
  }

  /** Natural owner shortcut: "Izinkan Nama Grup" / "Blokir Nama Grup". */
  async handleOwnerGroupAccess(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    if (msg.isGroup) return false
    const match = msg.text.trim().match(/^(izinkan|blokir)\s+(.+)$/i)
    if (!match) return false

    const allowed = match[1].toLowerCase() === 'izinkan'
    const groups = await findKnownGroups(match[2])
    if (groups.length === 0) {
      await client.sendText(msg.jid, `❌ Grup "${match[2]}" belum ada di daftar. Pakai \.groups untuk melihat nama dan ID grup.`)
      return true
    }
    if (groups.length > 1) {
      await client.sendText(msg.jid, `⚠️ Ada ${groups.length} grup dengan nama "${match[2]}". Pakai Group ID agar tidak salah grup:\n\n${groups.map(group => `${group.subject}\n${group.id}`).join('\n\n')}`)
      return true
    }

    await setGroupAccess(groups[0].id, allowed)
    await client.sendText(msg.jid, `${allowed ? '✅ Grup diizinkan' : '🚫 Grup diblokir'}: ${groups[0].subject}\n${groups[0].id}`)
    logger.info({ groupJid: groups[0].id, allowed }, 'Group access changed by owner name shortcut')
    return true
  }

  private async cmdGroups(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const groups = await findKnownGroups()
    if (groups.length === 0) {
      await client.sendText(msg.jid, 'Belum ada daftar grup. Coba tunggu sinkronisasi setelah bot tersambung.')
      return true
    }
    await client.sendText(msg.jid, `📋 Grup yang diketahui bot:\n\n${groups.map((group, index) => {
      const allowed = getGroupAccess(group.id) ?? group.allowed
      return `${index + 1}. ${group.subject}\n   ${group.id}\n   Status: ${allowed ? 'DIIZINKAN' : 'DIBLOKIR'}`
    }).join('\n\n')}`)
    for (const group of groups) {
      await client.sendInteractiveButtons(msg.jid, `Atur akses: ${group.subject}`, 'Group access', [
        { id: `${config.PREFIX}group-allow ${group.id}`, text: '✅ Izinkan' },
        { id: `${config.PREFIX}group-block ${group.id}`, text: '🚫 Blokir' },
      ])
    }
    return true
  }

  private async cmdStickers(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const stickers = await listStickerMetadata()
    if (stickers.length === 0) {
      await client.sendText(msg.jid, 'Pool sticker masih kosong.', msg.raw)
      return true
    }
    const lines = stickers.map((sticker, index) =>
      `${index + 1}. ${sticker.file.slice(0, 24)}…\n   ${sticker.tags.join(', ') || '(belum ada tag)'}`
    )
    await client.sendText(msg.jid, `🗂 *Sticker Pool (${stickers.length})*\n\n${lines.join('\n\n')}\n\nRetag: ${config.PREFIX}retag <nomor> tag1,tag2`, msg.raw)
    return true
  }

  private async cmdRetagSticker(msg: IncomingMessage, client: WhatsAppClient, args: string[]): Promise<boolean> {
    const identifier = args.shift()
    const value = args.join(' ').trim()
    if (!identifier || !value) {
      await client.sendText(msg.jid, `Format: ${config.PREFIX}retag <nomor|file> tag1,tag2 | deskripsi opsional`, msg.raw)
      return true
    }
    const [tagText, description] = value.split(/\s*\|\s*/, 2)
    const tags = tagText.split(',').map(tag => tag.trim()).filter(Boolean)
    if (tags.length === 0) {
      await client.sendText(msg.jid, 'Minimal isi satu tag.', msg.raw)
      return true
    }
    const updated = await retagSticker(identifier, tags, description)
    await client.sendText(msg.jid, updated
      ? `✅ Tag diperbarui: ${updated.file}\n${updated.tags.join(', ')}`
      : '❌ Sticker tidak ditemukan.', msg.raw)
    return true
  }

  private async cmdDeleteSticker(msg: IncomingMessage, client: WhatsAppClient, args: string[]): Promise<boolean> {
    const identifier = args[0]
    if (!identifier) {
      await client.sendText(msg.jid, `Format: ${config.PREFIX}hapus-sticker <nomor|file>`, msg.raw)
      return true
    }
    const removed = await deleteStickerFromPool(identifier)
    await client.sendText(msg.jid, removed ? `🗑 Sticker dihapus dari pool: ${removed.file}` : '❌ Sticker tidak ditemukan.', msg.raw)
    return true
  }
}

export const cmdHandler = new CommandHandler()

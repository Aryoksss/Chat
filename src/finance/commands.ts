import { unlink } from 'node:fs/promises'
import type { WhatsAppClient } from '../core/client.js'
import type { IncomingMessage } from '../core/types.js'
import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import { financeManager } from './manager.js'
import {
  financeService,
  formatFinanceTransaction,
} from './service.js'
import { deliverFinanceReport } from './report.js'
import { sendFinanceMenu, sendFinanceReview } from './ui.js'

const COMMANDS = new Set(['catat', 'keuangan', 'laporan', 'transaksi', 'pending', 'export'])

function commandParts(text: string): { command: string; rest: string } | null {
  const value = (text || '').trim()
  const prefix = config.PREFIXES.find(candidate => value.startsWith(candidate))
  if (!prefix) return null
  const withoutPrefix = value.slice(prefix.length).trim()
  const match = withoutPrefix.match(/^(\S+)(?:\s+([\s\S]*))?$/)
  return match ? { command: match[1].toLowerCase(), rest: match[2]?.trim() || '' } : null
}

function isOwnerDm(msg: IncomingMessage): boolean {
  if (msg.isGroup) return false
  const sender = msg.sender.replace(/[^0-9]/g, '')
  return [config.OWNER_NUMBER, config.OWNER_LID]
    .filter(Boolean)
    .map(value => value.replace(/[^0-9]/g, ''))
    .includes(sender)
}

function messageTimestamp(raw: any): number {
  const value = raw?.messageTimestamp
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value?.low === 'number') return value.low * 1000
  return Date.now()
}

function unwrapContent(message: any): any {
  let current = message
  for (let index = 0; index < 5 && current; index++) {
    const nested = current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message
    if (!nested) break
    current = nested
  }
  return current
}

async function downloadReceipt(msg: IncomingMessage, client: WhatsAppClient): Promise<Buffer | null> {
  if (msg.messageType === 'image') return client.downloadMedia(msg.raw)
  const content = unwrapContent(msg.raw?.message)
  const context = content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.documentMessage?.contextInfo
  const quoted = unwrapContent(context?.quotedMessage)
  if (!quoted?.imageMessage) return null
  return client.downloadMedia({
    key: {
      remoteJid: msg.raw?.key?.remoteJid || msg.jid,
      fromMe: false,
      id: context?.stanzaId,
      participant: context?.participant,
    },
    message: quoted,
    messageTimestamp: msg.raw?.messageTimestamp,
  })
}

function transactionList(period?: string): string {
  const transactions = financeService.transactions(period, false, 30)
  if (transactions.length === 0) return `Belum ada transaksi terkonfirmasi${period ? ` untuk ${period}` : ' bulan ini'}.`
  return `💳 *Transaksi ${period || 'bulan ini'}*\n\n${transactions.map(item => {
    const sign = item.type === 'expense' ? '-' : item.type === 'income' ? '+' : '↔'
    const date = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short' })
      .format(new Date(item.occurredAt))
    return `${sign} ${item.id} · ${date} · ${item.merchant || item.category}\n   Rp ${item.amount.toLocaleString('id-ID')} · ${item.category}`
  }).join('\n\n')}`
}

export class FinanceCommandHandler {
  async handle(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const parsed = commandParts(msg.text || '')
    if (!parsed || !COMMANDS.has(parsed.command)) return false
    if (!isOwnerDm(msg)) {
      await client.sendText(msg.jid, '🔒 Fitur keuangan hanya tersedia di chat pribadi owner.', msg.raw)
      return true
    }

    try {
      if (parsed.command === 'catat') return this.record(msg, client, parsed.rest)
      if (parsed.command === 'laporan') return this.report(msg, client, parsed.rest)
      if (parsed.command === 'transaksi') {
        await client.sendText(msg.jid, transactionList(parsed.rest || undefined), msg.raw)
        return true
      }
      if (parsed.command === 'pending') return this.showPending(msg, client)
      if (parsed.command === 'export') return this.export(msg, client, parsed.rest)
      return this.financeAction(msg, client, parsed.rest)
    } catch (err: any) {
      logger.error({ err: err.message }, 'Finance command failed')
      await client.sendText(msg.jid, `❌ Fitur keuangan gagal: ${err.message}`, msg.raw)
      return true
    }
  }

  private async record(msg: IncomingMessage, client: WhatsAppClient, request: string): Promise<boolean> {
    const image = await downloadReceipt(msg, client)
    if (!image && !request) {
      await client.sendText(
        msg.jid,
        `Reply/kirim foto struk dengan ${config.PREFIX}catat, atau ketik contoh:\n${config.PREFIX}catat makan 35000 di Solaria pakai BCA`,
        msg.raw,
      )
      return true
    }
    await client.sendPresence(msg.jid, 'composing')
    const result = image
      ? await financeService.recordReceipt(image, request, messageTimestamp(msg.raw))
      : await financeService.recordManual(request, messageTimestamp(msg.raw))
    if (result.transaction) {
      await sendFinanceReview(client, msg.jid, result.transaction, msg.raw)
    } else if (result.existing) {
      await client.sendText(msg.jid, `ℹ️ Sudah pernah dicatat.\n\n${formatFinanceTransaction(result.existing)}`, msg.raw)
    } else {
      await client.sendText(msg.jid, `❌ ${result.reason || 'Transaksi tidak dapat diproses.'}`, msg.raw)
    }
    return true
  }

  private async financeAction(msg: IncomingMessage, client: WhatsAppClient, rest: string): Promise<boolean> {
    if (!rest) {
      await sendFinanceMenu(client, msg.jid, msg.raw)
      return true
    }
    const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/)
    const action = match?.[1]?.toLowerCase() || ''
    const args = match?.[2]?.trim() || ''
    const [id, ...tail] = args.split(/\s+/)

    if (action === 'sync') {
      const result = await financeManager.syncNow(args || undefined, false)
      await client.sendText(msg.jid, result.message, msg.raw)
      return true
    }
    if (action === 'sheets') {
      if (args && args.toLowerCase() !== 'sync') {
        await client.sendText(msg.jid, 'Format: .keuangan sheets sync', msg.raw)
        return true
      }
      const result = await financeManager.syncSheetsNow()
      await client.sendText(msg.jid, result.message, msg.raw)
      return true
    }
    if (action === 'ringkasan' || action === 'laporan') return this.report(msg, client, args)
    if (action === 'transaksi') {
      await client.sendText(msg.jid, transactionList(args || undefined), msg.raw)
      return true
    }
    if (action === 'pending') return this.showPending(msg, client)
    if (action === 'export') return this.export(msg, client, args)

    if (action === 'konfirmasi' || action === 'simpan') {
      const result = financeService.confirm(id)
      await client.sendText(msg.jid, result.transaction ? `✅ Tersimpan.\n\n${formatFinanceTransaction(result.transaction)}` : `❌ ${result.error}`, msg.raw)
      return true
    }
    if (action === 'abaikan') {
      const transaction = financeService.ignore(id)
      await client.sendText(msg.jid, transaction ? `🗑 Transaksi ${transaction.id} diabaikan.` : '❌ Transaksi tidak ditemukan.', msg.raw)
      return true
    }
    if (action === 'gabungkan') {
      const result = financeService.merge(id)
      await client.sendText(msg.jid, result.target ? `🔗 Digabungkan ke transaksi ${result.target.id}.` : `❌ ${result.error}`, msg.raw)
      return true
    }
    if (action === 'terpisah') {
      const result = financeService.saveSeparate(id)
      await client.sendText(msg.jid, result.transaction ? `✅ Disimpan sebagai transaksi terpisah: ${result.transaction.id}.` : `❌ ${result.error}`, msg.raw)
      return true
    }
    if (action === 'edit') {
      if (!id) {
        await client.sendText(msg.jid, 'Format: .keuangan edit <id> nominal=45000 kategori=Transportasi merchant=Gojek', msg.raw)
        return true
      }
      if (tail.length === 0) {
        await client.sendText(
          msg.jid,
          `Edit dengan:\n${config.PREFIX}keuangan edit ${id} nominal=45000 kategori=Transportasi merchant=Gojek tanggal=04/08/2026 14:30 akun=BCA`,
          msg.raw,
        )
        return true
      }
      const result = financeService.edit(id, tail.join(' '))
      if (result.transaction) await sendFinanceReview(client, msg.jid, result.transaction, msg.raw)
      else await client.sendText(msg.jid, `❌ ${result.error}`, msg.raw)
      return true
    }
    if (action === 'hapus') {
      const transaction = financeService.get(id)
      if (!transaction) {
        await client.sendText(msg.jid, '❌ Transaksi tidak ditemukan.', msg.raw)
        return true
      }
      await client.sendInteractiveButtons(msg.jid, `Hapus transaksi ${transaction.id}? Data akan ditandai diabaikan.`, 'Konfirmasi penghapusan', [
        { id: `${config.PREFIX}keuangan hapus-konfirmasi ${transaction.id}`, text: '🗑 Ya, hapus' },
        { id: `${config.PREFIX}keuangan`, text: 'Batal' },
      ])
      return true
    }
    if (action === 'hapus-konfirmasi') {
      const transaction = financeService.ignore(id)
      await client.sendText(msg.jid, transaction ? `🗑 Transaksi ${transaction.id} dihapus dari laporan.` : '❌ Transaksi tidak ditemukan.', msg.raw)
      return true
    }

    await sendFinanceMenu(client, msg.jid, msg.raw)
    return true
  }

  private async report(msg: IncomingMessage, client: WhatsAppClient, period: string): Promise<boolean> {
    await deliverFinanceReport(client, msg.jid, period || undefined, msg.raw)
    return true
  }

  private async showPending(msg: IncomingMessage, client: WhatsAppClient): Promise<boolean> {
    const pending = financeService.pending(10)
    if (pending.length === 0) {
      await client.sendText(msg.jid, 'Tidak ada transaksi pending.', msg.raw)
      return true
    }
    await client.sendText(msg.jid, `Ada ${pending.length} transaksi yang perlu diperiksa.`, msg.raw)
    for (const transaction of pending) await sendFinanceReview(client, msg.jid, transaction)
    return true
  }

  private async export(msg: IncomingMessage, client: WhatsAppClient, period: string): Promise<boolean> {
    const exported = await financeService.exportCsv(period || undefined)
    try {
      const sent = await client.sendFile(msg.jid, exported.filePath, 'document', `${exported.count} transaksi`, msg.raw, exported.fileName)
      if (!sent) await client.sendText(msg.jid, '❌ CSV gagal dikirim.', msg.raw)
    } finally {
      await unlink(exported.filePath).catch(() => {})
    }
    return true
  }
}

export const financeCommandHandler = new FinanceCommandHandler()

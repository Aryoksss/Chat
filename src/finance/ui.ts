import type { WhatsAppClient } from '../core/client.js'
import { config } from '../system/config.js'
import { formatFinanceTransaction } from './service.js'
import type { FinanceTransactionRecord } from './types.js'

export async function sendFinanceReview(
  client: WhatsAppClient,
  jid: string,
  transaction: FinanceTransactionRecord,
  quoted?: any,
): Promise<void> {
  const prefix = config.PREFIX
  if (transaction.status === 'pending_duplicate') {
    await client.sendInteractiveButtons(
      jid,
      `⚠️ *Kemungkinan transaksi ganda*\n\n${formatFinanceTransaction(transaction)}`,
      'Belum masuk perhitungan laporan',
      [
        { id: `${prefix}keuangan gabungkan ${transaction.id}`, text: '🔗 Gabungkan' },
        { id: `${prefix}keuangan terpisah ${transaction.id}`, text: '✅ Simpan terpisah' },
        { id: `${prefix}keuangan abaikan ${transaction.id}`, text: '🗑 Abaikan' },
      ],
    )
    return
  }

  if (transaction.status === 'pending') {
    const sent = await client.sendInteractiveButtons(
      jid,
      `🧾 *Periksa transaksi*\n\n${formatFinanceTransaction(transaction)}`,
      transaction.amount > 0 ? 'Konfirmasi sebelum masuk laporan' : 'Nominal belum terbaca; pilih Edit',
      [
        { id: `${prefix}keuangan konfirmasi ${transaction.id}`, text: '✅ Simpan' },
        { id: `${prefix}keuangan edit ${transaction.id}`, text: '✏️ Edit' },
        { id: `${prefix}keuangan abaikan ${transaction.id}`, text: '🗑 Abaikan' },
      ],
    )
    if (!sent) {
      await client.sendText(
        jid,
        `${formatFinanceTransaction(transaction)}\n\nSimpan: ${prefix}keuangan konfirmasi ${transaction.id}\nEdit: ${prefix}keuangan edit ${transaction.id} nominal=...\nAbaikan: ${prefix}keuangan abaikan ${transaction.id}`,
        quoted,
      )
    }
    return
  }

  await client.sendText(jid, formatFinanceTransaction(transaction), quoted)
}

export async function sendFinanceMenu(client: WhatsAppClient, jid: string, quoted?: any): Promise<void> {
  const prefix = config.PREFIX
  const sent = await client.sendListMenu(
    jid,
    '💰 Keuangan',
    'Pilih laporan atau pengelolaan transaksi.',
    'Khusus owner · IDR · WIB',
    'Buka Keuangan',
    [
      {
        title: 'Laporan',
        rows: [
          { title: 'Ringkasan Bulan Ini', description: 'Pemasukan, pengeluaran, dan kategori', rowId: `${prefix}laporan` },
          { title: 'Daftar Transaksi', description: 'Transaksi terkonfirmasi bulan ini', rowId: `${prefix}transaksi` },
          { title: 'Export CSV', description: 'Unduh ledger bulan ini', rowId: `${prefix}export` },
        ],
      },
      {
        title: 'Kelola',
        rows: [
          { title: 'Catat Transaksi', description: 'Ketik nominal/merchant atau reply struk', rowId: `${prefix}catat` },
          { title: 'Transaksi Pending', description: 'Periksa hasil struk/email', rowId: `${prefix}pending` },
          { title: 'Sinkronkan Gmail', description: 'Ambil email transaksi baru sekarang', rowId: `${prefix}keuangan sync` },
          { title: 'Sinkronkan Spreadsheet', description: 'Perbarui catatan Google Sheets', rowId: `${prefix}keuangan sheets sync` },
        ],
      },
    ],
  )
  if (!sent) {
    await client.sendText(
      jid,
      `💰 *Keuangan*\n\n${prefix}catat <transaksi>\n${prefix}laporan [YYYY-MM]\n${prefix}transaksi [YYYY-MM]\n${prefix}pending\n${prefix}export [YYYY-MM]\n${prefix}keuangan sync [YYYY-MM-DD]\n${prefix}keuangan sheets sync`,
      quoted,
    )
  }
}

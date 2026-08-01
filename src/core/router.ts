// ============================================================
// Router — Owner DM vs Group classifier
// ============================================================

import { config } from '../system/config.js'
import type { PersonaType } from './types.js'

export class Router {
  /** Determine persona based on sender and chat type */
  route(jid: string, sender: string, isGroup: boolean): PersonaType | null {
    // Owner DM — pesan dari nomor owner di chat pribadi.
    // WhatsApp reports senders by their LID (e.g. "93210101727329") rather than by
    // their phone number, so match against both the owner number and owner LID.
    const ownerIds = [config.OWNER_NUMBER, config.OWNER_LID].filter(Boolean)
    if (!isGroup && ownerIds.includes(sender)) {
      return 'owner'
    }

    // Group — cek apakah grup yang diizinkan
    if (isGroup) {
      // Kalau GROUP_JID dikosongkan, respon di semua grup
      if (!config.GROUP_JID) return 'group'

      // Cocokkan dengan grup yang ditentukan (misal 1234-5678@g.us)
      if (jid === config.GROUP_JID) return 'group'

      // Jika GROUP_JID menggunakan pola koma untuk banyak grup (opsional jika nanti support multi)
      const allowedGroups = config.GROUP_JID.split(',').map(g => g.trim())
      if (allowedGroups.includes(jid)) return 'group'

      // Kalau kita sampai sini, jid grup tidak cocok dengan allowlist. Jangan respon.
      return null
    }

    // Unknown — ignore
    return null
  }
}

export const router = new Router()

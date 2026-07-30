// ============================================================
// Router — Owner DM vs Group classifier
// ============================================================

import { config } from '../system/config.js'
import type { PersonaType } from './types.js'

export class Router {
  /** Determine persona based on sender and chat type */
  route(jid: string, sender: string, isGroup: boolean): PersonaType | null {
    // Owner DM — pesan dari nomor owner di chat pribadi
    if (!isGroup && sender === config.OWNER_NUMBER) {
      return 'owner'
    }

    // Group — cek apakah grup yang diizinkan
    if (isGroup) {
      // Kalau GROUP_JID dikosongkan, respon di semua grup
      if (!config.GROUP_JID) return 'group'

      // Cocokkan dengan grup yang ditentukan
      if (jid === config.GROUP_JID) return 'group'

      // Wildcard: kalau GROUP_JID pake pattern
      if (config.GROUP_JID.endsWith('@g.us') && jid.endsWith('@g.us')) {
        return 'group'
      }
    }

    // Unknown — ignore
    return null
  }
}

export const router = new Router()

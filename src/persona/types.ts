// ============================================================
// Persona Types
// ============================================================

import type { ToolDef } from '../core/types.js'

export interface PersonaConfig {
  name: 'owner' | 'group'
  agent: string
  soul: string
  tools: ToolDef[]
  toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<string>>
}

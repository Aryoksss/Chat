// ============================================================
// Tools Registry — daftar semua tools + handler functions
// ============================================================

import { logger } from '../system/logger.js'
import type { ToolDef, ToolHandler, ToolContext, ToolResult } from '../core/types.js'

interface ToolEntry {
  def: ToolDef
  handler: ToolHandler
}

export class ToolsRegistry {
  private tools = new Map<string, ToolEntry>()

  /** Register a tool with its definition and handler */
  register(def: ToolDef, handler: ToolHandler): void {
    this.tools.set(def.name, { def, handler })
    logger.info({ tool: def.name }, 'Tool registered')
  }

  /** Get tool handler by name */
  getHandler(name: string): ((args: Record<string, unknown>) => Promise<string>) | null {
    const entry = this.tools.get(name)
    if (!entry) return null

    // Wraps the actual handler to return a string for AI consumption
    return async (args: Record<string, unknown>) => {
      try {
        const result = await entry.handler(args, {} as ToolContext)
        if (result.success) {
          return result.text || `✅ ${entry.def.name} berhasil dieksekusi.`
        }
        return `❌ Gagal: ${result.error || 'Unknown error'}`
      } catch (err: any) {
        logger.error({ err, tool: name }, 'Tool execution failed')
        return `❌ Error: ${err.message}`
      }
    }
  }

  /** Get all tool definitions (for AI function calling) */
  getDefinitions(): ToolDef[] {
    return Array.from(this.tools.values()).map(e => e.def)
  }

  /** Execute a tool with full context (sends files back directly) */
  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const entry = this.tools.get(name)
    if (!entry) {
      return { success: false, error: `Tool "${name}" tidak ditemukan.` }
    }
    return entry.handler(args, context)
  }

  /** Check if a tool exists */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Get list of registered tool names */
  listTools(): string[] {
    return Array.from(this.tools.keys())
  }
}

export const toolsRegistry = new ToolsRegistry()

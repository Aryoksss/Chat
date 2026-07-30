// ============================================================
// Tool Executor — bridge between AI tool calls and actual handlers
// ============================================================

import { logger } from '../system/logger.js'
import { toolsRegistry } from './registry.js'
import type { ToolDef, ToolHandler, ToolContext, ToolResult } from '../core/types.js'

export class ToolExecutor {
  /** Execute a tool call from AI and return result text for AI */
  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<string> {
    logger.info({ toolName, args }, 'Executing tool')

    try {
      const result = await toolsRegistry.execute(toolName, args, context)

      if (result.success) {
        if (result.filePath) {
          // File-based result — send via socket
          try {
            await context.sock.sendMessage(context.jid, {
              [result.fileType || 'document']: { url: result.filePath },
              ...(result.caption ? { caption: result.caption } : {}),
            })
          } catch (sendErr) {
            logger.error({ sendErr }, 'Failed to send tool result file')
          }
        }
        return result.text || `✅ ${toolName} berhasil!`
      }

      return `❌ Gagal: ${result.error || 'Unknown error'}`
    } catch (err: any) {
      logger.error({ err, toolName }, 'Tool execution error')
      return `❌ Error saat menjalankan ${toolName}: ${err.message}`
    }
  }

  /** Wraps all registered tools into Map for AI tool calling loop */
  createHandlerMap(context: ToolContext): Map<string, (args: Record<string, unknown>) => Promise<string>> {
    const map = new Map<string, (args: Record<string, unknown>) => Promise<string>>()

    for (const toolName of toolsRegistry.listTools()) {
      map.set(toolName, async (args) => {
        return this.executeToolCall(toolName, args, context)
      })
    }

    return map
  }
}

export const toolExecutor = new ToolExecutor()

// ============================================================
// Tool Executor — bridge between AI tool calls and actual handlers
// ============================================================

import { logger } from '../system/logger.js'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { toolsRegistry } from './registry.js'
import type { ToolDef, ToolHandler, ToolContext, ToolResult } from '../core/types.js'

export class ToolExecutor {
  private async cleanupTempFile(filePath: string): Promise<void> {
    const tempRoot = path.resolve(tmpdir()) + path.sep
    if (!path.resolve(filePath).startsWith(tempRoot)) return
    await unlink(filePath).catch(() => {})
  }

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
        if (result.filePaths && result.filePaths.length > 0) {
          // Multi-file result — send each file via socket
          try {
            for (const fp of result.filePaths) {
              await context.sock.sendMessage(context.jid, {
                [result.fileType || 'document']: { url: fp },
                ...(result.caption ? { caption: result.caption } : {}),
              }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
            }
          } catch (sendErr) {
            logger.error({ sendErr }, 'Failed to send tool result files')
          } finally {
            await Promise.all(result.filePaths.map(filePath => this.cleanupTempFile(filePath)))
          }
        } else if (result.filePath) {
          // File-based result — send via socket
          try {
            // For stickers the author/pack is already baked into the WebP EXIF
            // metadata by wa-sticker-formatter, so just send the file.
            if (result.fileType === 'sticker') {
              await context.sock.sendMessage(context.jid, {
                sticker: { url: result.filePath },
              }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
              context.suppressTextResponse = true
            } else {
              await context.sock.sendMessage(context.jid, {
                [result.fileType || 'document']: { url: result.filePath },
                ...(result.caption ? { caption: result.caption } : {}),
              }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
            }
          } catch (sendErr) {
            logger.error({ sendErr }, 'Failed to send tool result file')
          } finally {
            await this.cleanupTempFile(result.filePath)
          }
        }
        if (context.suppressTextResponse) return ''
        return result.text || `✅ ${toolName} berhasil!`
      }

      // Some tools put the human-readable failure message in `text` (with no `error`).
      // Fall back through text → error → generic so users never see "Unknown error".
      return `❌ Gagal: ${result.text || result.error || 'Terjadi kesalahan, coba lagi.'}`
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

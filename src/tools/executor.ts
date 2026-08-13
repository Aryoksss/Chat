// ============================================================
// Tool Executor — bridge between AI tool calls and actual handlers
// ============================================================

import { logger } from '../system/logger.js'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { toolsRegistry } from './registry.js'
import type { ToolDef, ToolHandler, ToolContext, ToolResult } from '../core/types.js'
import { botDatabase } from '../storage/database.js'
import { mediaJobManager } from '../jobs/media-jobs.js'

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
    const mediaJob = context.mediaJobId ? null : mediaJobManager.begin(toolName, context)
    const trackedMediaJob = mediaJobManager.isMediaTool(toolName) && Boolean(context.mediaJobId)
    if (trackedMediaJob) {
      if (mediaJobManager.isCancelled(context)) {
        context.suppressTextResponse = true
        return ''
      }
      mediaJobManager.startQueued(context)
      await mediaJobManager.react(context, '⏳')
    }

    try {
      const result = await toolsRegistry.execute(toolName, args, context)

      if (mediaJobManager.isCancelled(context)) {
        const files = [...(result.filePaths || []), ...(result.filePath ? [result.filePath] : [])]
        await Promise.all(files.map(filePath => this.cleanupTempFile(filePath)))
        context.suppressTextResponse = true
        await mediaJobManager.react(context, '🚫')
        return ''
      }

      if (result.success) {
        let sendFailed = false
        if (result.filePaths && result.filePaths.length > 0) {
          // Baileys fork supports native album messages for multiple images.
          // Keep the old sequential behavior for tools that do not opt in.
          try {
            if (result.sendAsCarousel && result.filePaths.length >= 2 && (result.fileType === 'image' || result.fileType === 'video')) {
              try {
                const sent = await context.sock.sendMessage(context.jid, {
                  text: result.text || '🖼️ Hasil pencarian',
                  footer: 'Geser untuk melihat hasil lainnya',
                  cards: result.filePaths.map((fp, index) => {
                    const mediaType = result.fileTypes?.[index] || result.fileType || 'image'
                    return {
                      [mediaType]: {
                        url: fp,
                        ...(mediaType === 'video' && result.fileAnimations?.[index] ? { gifPlayback: true } : {}),
                      },
                      caption: result.albumCaptions?.[index] || `Hasil ${index + 1}`,
                      // This Baileys fork expects nativeFlow to exist even
                      // when a card has no action buttons.
                      nativeFlow: [],
                    }
                  }),
                }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
                if (sent?.key?.id) botDatabase.rememberOutgoing(context.jid, sent.key.id, 'image')
              } catch (carouselErr) {
                // Some WhatsApp clients reject a native carousel when one card
                // has an unsupported media format. Do not lose the search result:
                // fall back to ordinary media messages instead.
                logger.warn({ error: this.describeError(carouselErr) }, 'Carousel rejected; falling back to individual media')
                const intro = await context.sock.sendMessage(context.jid, {
                  text: result.text || '🖼️ Hasil pencarian',
                }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
                if (intro?.key?.id) botDatabase.rememberOutgoing(context.jid, intro.key.id, 'text')
                for (const [index, fp] of result.filePaths.entries()) {
                  const mediaType = result.fileTypes?.[index] || result.fileType || 'image'
                  const sent = await context.sock.sendMessage(context.jid, {
                    [mediaType]: {
                      url: fp,
                      ...(mediaType === 'video' && result.fileAnimations?.[index] ? { gifPlayback: true } : {}),
                    },
                    ...(result.albumCaptions?.[index] ? { caption: result.albumCaptions[index] } : {}),
                  }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
                  if (sent?.key?.id) botDatabase.rememberOutgoing(context.jid, sent.key.id, mediaType)
                }
              }
            } else if (result.sendAsAlbum && result.fileType === 'image' && result.filePaths.length >= 2) {
              const sent = await context.sock.sendMessage(context.jid, {
                album: result.filePaths.map((fp, index) => ({
                  image: { url: fp },
                  ...(result.albumCaptions?.[index] ? { caption: result.albumCaptions[index] } : {}),
                })),
              }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
              if (sent?.key?.id) botDatabase.rememberOutgoing(context.jid, sent.key.id, 'image')
            } else {
              for (const fp of result.filePaths) {
                const sent = await context.sock.sendMessage(context.jid, {
                  [result.fileType || 'document']: { url: fp },
                }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
                if (sent?.key?.id) botDatabase.rememberOutgoing(context.jid, sent.key.id, result.fileType || 'document')
              }
            }
          } catch (sendErr) {
            sendFailed = true
            logger.error({ error: this.describeError(sendErr) }, 'Failed to send tool result files')
          } finally {
            await Promise.all(result.filePaths.map(filePath => this.cleanupTempFile(filePath)))
          }
        } else if (result.filePath) {
          // File-based result — send via socket
          try {
            // For stickers the author/pack is already baked into the WebP EXIF
            // metadata by wa-sticker-formatter, so just send the file.
            if (result.fileType === 'sticker') {
              const sent = await context.sock.sendMessage(context.jid, {
                sticker: { url: result.filePath },
                isAnimated: result.isAnimated === true,
              }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
              if (sent?.key?.id) botDatabase.rememberOutgoing(context.jid, sent.key.id, 'sticker')
              context.suppressTextResponse = true
            } else {
              const sent = await context.sock.sendMessage(context.jid, {
                [result.fileType || 'document']: { url: result.filePath },
              }, context.rawMessage ? { quoted: context.rawMessage } : undefined)
              if (sent?.key?.id) botDatabase.rememberOutgoing(context.jid, sent.key.id, result.fileType || 'document')
            }
          } catch (sendErr) {
            sendFailed = true
            logger.error({ error: this.describeError(sendErr) }, 'Failed to send tool result file')
          } finally {
            await this.cleanupTempFile(result.filePath)
          }
        }
        // A successful media tool already delivered the actual result. Do not
        // send a second confirmation text or a media caption afterward.
        if ((result.filePath || (result.filePaths && result.filePaths.length > 0)) && !result.preserveTextResponse) {
          context.suppressTextResponse = true
        }
        if (sendFailed) {
          mediaJobManager.fail(context, 'Media berhasil dibuat tetapi gagal dikirim')
          await mediaJobManager.react(context, '❌')
          return '❌ Media berhasil dibuat tetapi gagal dikirim.'
        }
        mediaJobManager.complete(context)
        if (trackedMediaJob) await mediaJobManager.react(context, '✅')
        if (context.suppressTextResponse) return ''
        return result.text || `✅ ${toolName} berhasil!`
      }

      // Some tools put the human-readable failure message in `text` (with no `error`).
      // Fall back through text → error → generic so users never see "Unknown error".
      const failure = result.text || result.error || 'Terjadi kesalahan, coba lagi.'
      mediaJobManager.fail(context, failure)
      if (trackedMediaJob) await mediaJobManager.react(context, '❌')
      return `❌ Gagal: ${failure}`
    } catch (err: any) {
      mediaJobManager.fail(context, err.message)
      if (trackedMediaJob) await mediaJobManager.react(context, '❌')
      logger.error({ err, toolName }, 'Tool execution error')
      return `❌ Error saat menjalankan ${toolName}: ${err.message}`
    } finally {
      if (mediaJob) context.mediaJobId = undefined
    }
  }

  private describeError(error: unknown): { name?: string; message: string; stack?: string } {
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack }
    }
    return { message: typeof error === 'string' ? error : JSON.stringify(error) }
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

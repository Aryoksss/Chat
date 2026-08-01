// ============================================================
// Core Types — shared across the entire bot
// ============================================================

/** Who sent the message */
export type PersonaType = 'owner' | 'group'

/** Detected message content type */
export type MessageContentType = 'text' | 'image' | 'video' | 'sticker' | 'document' | 'audio'

/** Tool definition parsed from TOOLS.md — maps to OpenAI function-calling */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>  // JSON Schema
}

/** Tool handler function type */
export type ToolHandler = (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>

/** Context passed to every tool handler */
export interface ToolContext {
  sock: any                // Baileys socket instance
  jid: string              // Chat JID (sender or group)
  participant?: string     // Participant who sent message (null in DM)
  downloadMedia?: (msg: any) => Promise<Buffer | null>
  rawMessage?: any         // Raw Baileys message object
}

/** Result from a tool execution */
export interface ToolResult {
  success: boolean
  text?: string           // Text response for AI
  filePath?: string       // Path to file to send (sticker, download, etc.)
  filePaths?: string[]    // Multiple files to send in one call (e.g. photo gallery)
  fileType?: 'sticker' | 'document' | 'video' | 'audio' | 'image'
  caption?: string        // Caption for the file
  error?: string
}

/** Persona configuration loaded from markdown files */
export interface PersonaConfig {
  name: string
  agent: string           // AGENT.md content
  soul: string            // SOUL.md content
  identity?: string       // IDENTITY.md content — who the persona is
  user?: string           // USER.md content — context/preferences about the user
  tools: ToolDef[]        // Parsed from TOOLS.md
}

/** AI conversation message */
export interface AIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: 'text' | 'image_url', text?: string, image_url?: { url: string } }>
  tool_call_id?: string
  tool_calls?: AIToolCall[]
}

/** Tool call from AI response */
export interface AIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string      // JSON string
  }
}

/** Short-term memory entry — Nyimpes konteks percakapan terakhir */
export interface ShortMemoryEntry {
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

/** Parsed incoming message from Baileys */
export interface IncomingMessage {
  jid: string              // Chat identifier
  sender: string           // Phone number of sender
  text: string             // Extracted text content
  messageType: MessageContentType
  hasMedia: boolean
  quotedText?: string      // Text from replied-to message
  isGroup: boolean
  participant?: string     // Group participant number
  isBotMentioned: boolean  // Whether bot @mention in group message
  isReplyToBot: boolean    // Whether replying to bot's message
  raw: any                 // Original Baileys message object
}

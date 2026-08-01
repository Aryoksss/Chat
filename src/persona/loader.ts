// ============================================================
// Persona Loader — parse AGENT.md + SOUL.md + TOOLS.md
// ============================================================

import { readFile, readdir } from 'fs/promises'
import path from 'path'
import { config } from '../system/config.js'
import { logger } from '../system/logger.js'
import type { ToolDef, PersonaConfig } from '../core/types.js'

export class PersonaLoader {
  /** Load all personas from the personas directory */
  async loadAll(): Promise<Map<'owner' | 'group', PersonaConfig>> {
    const personas = new Map<'owner' | 'group', PersonaConfig>()

    for (const name of ['owner', 'group'] as const) {
      try {
        const persona = await this.loadPersona(name)
        personas.set(name, persona)
        logger.info({ persona: name }, 'Persona loaded')
      } catch (err) {
        logger.error({ err, persona: name }, 'Failed to load persona')
      }
    }

    return personas
  }

  /** Load a single persona by name */
  async loadPersona(name: 'owner' | 'group'): Promise<PersonaConfig> {
    const dir = path.resolve(config.PERSONAS_DIR, name)

    const [agent, soul, identity, user, toolsMd] = await Promise.all([
      this.readFile(path.join(dir, 'AGENT.md')),
      this.readFile(path.join(dir, 'SOUL.md')),
      this.readFile(path.join(dir, 'IDENTITY.md')),
      this.readFile(path.join(dir, 'USER.md')),
      this.readFile(path.join(dir, 'TOOLS.md')),
    ])

    const tools = toolsMd ? this.parseToolsMD(toolsMd) : []

    return {
      name,
      agent: agent || `Anda adalah asisten WhatsApp untuk ${name}.`,
      soul: soul || 'Bersikaplah ramah dan membantu.',
      identity: identity || undefined,
      user: user || undefined,
      tools,
    }
  }

  /** Reload a specific persona (for /reload command) */
  async reloadPersona(name: 'owner' | 'group'): Promise<PersonaConfig | null> {
    try {
      return await this.loadPersona(name)
    } catch (err) {
      logger.error({ err, persona: name }, 'Reload failed')
      return null
    }
  }

  private async readFile(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, 'utf-8')
    } catch {
      return null
    }
  }

  /** Parse TOOLS.md → array of ToolDef objects (OpenAI function-calling format) */
  private parseToolsMD(content: string): ToolDef[] {
    const tools: ToolDef[] = []

    // Each tool block starts with ## toolName
    const toolBlocks = content.split(/(?=^##\s+)/m)

    for (const block of toolBlocks) {
      const nameMatch = block.match(/^##\s+(\S+)/m)
      if (!nameMatch) continue

      const name = nameMatch[1].trim()

      // Description: ...
      const descMatch = block.match(/^Description:\s*(.+)$/im)
      const description = descMatch?.[1]?.trim() || name

      // Parameters are in YAML-like list format:
      // - paramName (type, required|optional) — description
      const paramLines = block.match(/^-\s+(.+)$/gm)
      const properties: Record<string, any> = {}
      const required: string[] = []

      if (paramLines) {
        for (const line of paramLines) {
          const cleanLine = line.replace(/^-\s+/, '')
          const paramMatch = cleanLine.match(/^(\S+)\s+\((\w+),\s*(\w+)\)\s*(?:—\s*)?(.+)?$/)
          if (paramMatch) {
            const [, paramName, paramType, requiredStatus, paramDesc] = paramMatch
            properties[paramName] = {
              type: paramType === 'number' ? 'number'
                : paramType === 'boolean' ? 'boolean'
                : 'string',
              description: paramDesc?.trim() || '',
            }
            if (requiredStatus === 'required') {
              required.push(paramName)
            }
          }
        }
      }

      tools.push({
        name,
        description,
        parameters: {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
      })
    }

    return tools
  }
}

export const personaLoader = new PersonaLoader()

import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandHandler } from '../src/system/cmd-handler.js'
import { toolsRegistry } from '../src/tools/registry.js'
import { registerAllTools } from '../src/tools/register-tools.js'

registerAllTools()

test('group menu excludes owner commands and private pap tool', () => {
  const handler = new CommandHandler() as any
  const sections = handler.buildMenuSections(toolsRegistry.getDefinitions(), '!', false)
  const rows = sections.flatMap((section: any) => section.rows)

  assert.equal(sections.some((section: any) => section.title === 'Owner'), false)
  assert.equal(rows.some((row: any) => row.rowId.startsWith('!')), true)
  assert.equal(rows.some((row: any) => row.rowId.includes('pap')), false)
})

test('owner menu includes owner commands', () => {
  const handler = new CommandHandler() as any
  const sections = handler.buildMenuSections(toolsRegistry.getDefinitions(), '.', true)
  const owner = sections.find((section: any) => section.title === 'Owner')

  assert.ok(owner)
  assert.deepEqual(owner.rows.map((row: any) => row.rowId), ['/status', '/reload', '/memory', '/clear'])
})

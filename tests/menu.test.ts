import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandHandler } from '../src/system/cmd-handler.js'
import { toolsRegistry } from '../src/tools/registry.js'
import { registerAllTools } from '../src/tools/register-tools.js'

registerAllTools()

test('main menu only shows categories and hides direct feature rows', () => {
  const handler = new CommandHandler() as any
  const sections = handler.buildMenuCategorySections('.', false, true)
  const rows = sections.flatMap((section: any) => section.rows)

  assert.ok(rows.some((row: any) => row.rowId === '.menu-ai'))
  assert.ok(rows.some((row: any) => row.rowId === '.menu-media'))
  assert.ok(rows.some((row: any) => row.rowId === '.menu-utility'))
  assert.ok(rows.some((row: any) => row.rowId === '.menu-group'))
  assert.equal(rows.some((row: any) => row.rowId === '.sticker'), false)
  assert.equal(rows.some((row: any) => row.rowId === '.jobs'), false)
})

test('private main menu shows owner category but not group category', () => {
  const handler = new CommandHandler() as any
  const sections = handler.buildMenuCategorySections('.', true, false)
  const rows = sections.flatMap((section: any) => section.rows)

  assert.ok(rows.some((row: any) => row.rowId === '.menu-owner'))
  assert.ok(rows.some((row: any) => row.rowId === '.menu-finance'))
  assert.equal(rows.some((row: any) => row.rowId === '.menu-group'), false)
})

test('main menu is delivered as a dropdown with group-safe categories', async () => {
  const handler = new CommandHandler()
  let listSections: any[] = []
  let textCalls = 0
  const client = {
    sendListMenu: async (_jid: string, _title: string, _text: string, _footer: string, _button: string, sections: any[]) => {
      listSections = sections
      return true
    },
    sendText: async () => { textCalls++ },
  }
  const handled = await handler.handle({
    jid: 'group@g.us',
    sender: 'someone',
    text: '.menu',
    messageType: 'text',
    hasMedia: false,
    isGroup: true,
    isBotMentioned: false,
    isReplyToBot: false,
    raw: {},
  } as any, client as any)

  const rows = listSections.flatMap((section: any) => section.rows)
  assert.equal(handled, true)
  assert.ok(rows.some((row: any) => row.rowId === '.menu-media'))
  assert.ok(rows.some((row: any) => row.rowId === '.menu-group'))
  assert.equal(rows.some((row: any) => row.rowId === '.menu-finance'), false)
  assert.equal(textCalls, 0)
})

test('AI helper is delivered as a dropdown menu', async () => {
  const handler = new CommandHandler()
  let listCalls = 0
  let textCalls = 0
  const client = {
    sendListMenu: async () => { listCalls++; return true },
    sendText: async () => { textCalls++ },
  }
  const handled = await handler.handle({
    jid: 'owner@lid',
    sender: 'owner',
    text: '.helper',
    messageType: 'text',
    hasMedia: false,
    isGroup: false,
    isBotMentioned: false,
    isReplyToBot: false,
    raw: {},
  } as any, client as any)

  assert.equal(handled, true)
  assert.equal(listCalls, 1)
  assert.equal(textCalls, 0)
})

test('group menu excludes owner commands and private pap tool', () => {
  const handler = new CommandHandler() as any
  const sections = handler.buildMenuSections(toolsRegistry.getDefinitions(), '!', false)
  const rows = sections.flatMap((section: any) => section.rows)

  assert.equal(sections.some((section: any) => section.title === 'Owner'), false)
  assert.equal(rows.some((row: any) => row.rowId.startsWith('!')), true)
  assert.equal(rows.some((row: any) => row.rowId.includes('pap')), false)
  assert.equal(rows.some((row: any) => row.rowId.includes('keuangan')), false)
  assert.ok(rows.some((row: any) => row.rowId === '!jobs'))
  assert.ok(rows.some((row: any) => row.rowId === '!reminders'))
  assert.ok(rows.some((row: any) => row.rowId === '!reminder'))
  assert.ok(rows.some((row: any) => row.rowId === '!anggota'))
})

test('owner menu includes owner commands', () => {
  const handler = new CommandHandler() as any
  const sections = handler.buildMenuSections(toolsRegistry.getDefinitions(), '.', true)
  const owner = sections.find((section: any) => section.title === 'Owner')
  const rows = sections.flatMap((section: any) => section.rows)

  assert.ok(owner)
  assert.ok(rows.some((row: any) => row.rowId === '.reminder'))
  assert.ok(rows.some((row: any) => row.rowId === '.reminders'))
  assert.ok(owner.rows.some((row: any) => row.rowId === '/groups'))
  assert.ok(owner.rows.some((row: any) => row.rowId === '/group-allow'))
  assert.ok(owner.rows.some((row: any) => row.rowId === '/stickers'))
})

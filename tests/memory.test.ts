import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryScope } from '../src/memory/manager.js'

test('memory scopes are isolated by chat type and jid', () => {
  assert.notEqual(memoryScope('123@g.us', true), memoryScope('456@g.us', true))
  assert.notEqual(memoryScope('123@g.us', true), memoryScope('123@s.whatsapp.net', false))
  assert.equal(memoryScope('owner@s.whatsapp.net', false), 'owner:owner@s.whatsapp.net')
})

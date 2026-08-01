import test from 'node:test'
import assert from 'node:assert/strict'
import { handleWebFetch } from '../src/tools/handlers/web-fetch.js'

test('web-fetch rejects private IPv4 addresses', async () => {
  const result = await handleWebFetch({ url: 'http://127.0.0.1:8080' })
  assert.equal(result.success, false)
  assert.match(result.error || result.text || '', /internal|private/i)
})

test('web-fetch rejects non-http protocols', async () => {
  const result = await handleWebFetch({ url: 'file:///etc/passwd' })
  assert.equal(result.success, false)
})

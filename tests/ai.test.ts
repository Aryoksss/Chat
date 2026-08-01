import test from 'node:test'
import assert from 'node:assert/strict'
import { stripHiddenReasoning } from '../src/core/ai.js'

test('strips tagged reasoning before sending assistant text', () => {
  const result = stripHiddenReasoning('<think>private reasoning</think>\n\nJawaban singkat.')
  assert.equal(result, 'Jawaban singkat.')
})

test('does not expose unterminated reasoning blocks', () => {
  const result = stripHiddenReasoning('Jawaban awal\n<thinking>private reasoning')
  assert.equal(result, 'Jawaban awal')
})

test('removes visible tone markers without removing normal bracket text', () => {
  const result = stripHiddenReasoning('wih keren [joking] lihat [episode 1] juga')
  assert.equal(result, 'wih keren lihat [episode 1] juga')
})

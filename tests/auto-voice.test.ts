import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePersonaPronouns, prepareUserFacingResponse, prepareVoiceText } from '../src/audio/auto-voice.js'

test('voice protocol markers are executed internally and never leaked to chat', () => {
  const response = '`[[tts:text]]ki lho vn-ne, rungokno ya.[[/tts:text]][[audio_as_voice]]`'
  assert.equal(prepareVoiceText(response), 'ki lho vn-ne, rungokno ya.')
  assert.equal(prepareUserFacingResponse(response), 'ki lho vn-ne, rungokno ya.')
})

test('forbidden persona pronouns are normalized before sending', () => {
  assert.equal(normalizePersonaPronouns('lu jangan gitu, gue juga capek'), 'kamu jangan gitu, aku juga capek')
})

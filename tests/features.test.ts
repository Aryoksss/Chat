import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotDatabase } from '../src/storage/database.js'
import { parseReminderRequest } from '../src/reminders/parser.js'
import { selectByContext, type StickerPoolEntry } from '../src/tools/handlers/sticker-pool.js'
import { parseFourkhdSearchIntent } from '../src/tools/handlers/fourkhd.js'
import { handleSmeme } from '../src/tools/handlers/smeme.js'
import { decideAutoVoice, prepareVoiceText } from '../src/audio/auto-voice.js'
import { normalizeForHuTaoVoice, numberToIndonesian } from '../src/audio/text-normalizer.js'
import { extractThreadsMeta, isThreadsUrl } from '../src/tools/handlers/threads-dl.js'
import { extractStickerMediaMessage } from '../src/tools/handlers/sticker.js'
import { extractReminderMentions, handleReminder, isReminderAllowedContext } from '../src/tools/handlers/reminder.js'
import { ownerGreetingSchedule } from '../src/greetings/manager.js'
import { extractPinterestMedia, isPinterestMediaUrl, pinterestSearchUrl } from '../src/tools/handlers/pinterest-search.js'
import { config } from '../src/system/config.js'
import { aiBridge } from '../src/core/ai.js'

test('Threads downloader accepts only HTTPS Threads URLs', () => {
  assert.equal(isThreadsUrl('https://www.threads.com/@z33ven/post/DbgbbgYAWSF/media'), true)
  assert.equal(isThreadsUrl('https://threads.net/@user/post/123'), true)
  assert.equal(isThreadsUrl('http://www.threads.com/@user/post/123'), false)
  assert.equal(isThreadsUrl('https://example.com/@user/post/123'), false)
})

test('Threads metadata decodes canonical post URLs from share pages', () => {
  const html = '<meta property="og:url" content="https://www.threads.com/&#064;user/post/123">'
  assert.equal(extractThreadsMeta(html, 'og:url'), 'https://www.threads.com/@user/post/123')
})

test('sticker reply can extract media nested inside a carousel card', () => {
  const raw = {
    key: { remoteJid: 'chat@s.whatsapp.net' },
    message: {
      extendedTextMessage: {
        contextInfo: {
          stanzaId: 'carousel-message-id',
          quotedMessage: {
            interactiveMessage: {
              carouselMessage: {
                cards: [{ header: { videoMessage: { url: '/media/video.mp4', mediaKey: 'key' } } }],
              },
            },
          },
        },
      },
    },
  }
  const extracted = extractStickerMediaMessage(raw)
  assert.equal(extracted?.key.fromMe, true)
  assert.equal(extracted?.key.id, 'carousel-message-id')
  assert.equal(extracted?.message.videoMessage.mediaKey, 'key')
})

test('Pinterest search only accepts Pin media and builds Pin source links', () => {
  assert.equal(isPinterestMediaUrl('https://i.pinimg.com/originals/aa/bb/image.jpg'), true)
  assert.equal(isPinterestMediaUrl('https://example.com/image.jpg'), false)

  const hits = extractPinterestMedia([
    {
      id: '123456789',
      title: 'Kucing lucu',
      images: { orig: { url: 'https://i.pinimg.com/originals/aa/bb/cat.jpg' } },
    },
    {
      id: '987654321',
      videos: { V_HLSV4: { url: 'https://v1.pinimg.com/videos/mc/720p/cat.mp4' } },
      images: { orig: { url: 'https://example.com/not-pinterest.jpg' } },
    },
  ])
  assert.equal(hits.length, 2)
  assert.equal(hits[0].pageUrl, 'https://www.pinterest.com/pin/123456789/')
  assert.equal(hits[1].mediaType, 'video')
  assert.match(pinterestSearchUrl('kucing lucu'), /BaseSearchResource\/get/)
})

test('reminder parser understands relative, daily, and weekly Indonesian time', () => {
  const now = new Date('2026-08-02T02:00:00+07:00')

  const relative = parseReminderRequest('ingatkan aku 10 menit lagi minum obat', now)
  assert.equal(relative?.task, 'minum obat')
  assert.equal(relative?.dueAt, now.getTime() + 10 * 60_000)

  const daily = parseReminderRequest('reminder setiap hari jam 7 minum vitamin', now)
  assert.equal(daily?.task, 'minum vitamin')
  assert.equal(daily?.recurrence, 'daily')

  const weekly = parseReminderRequest('ingatkan grup tiap Jumat jam 9 rapat mingguan', now)
  assert.equal(weekly?.task, 'rapat mingguan')
  assert.equal(weekly?.recurrence, 'weekly:5')
})

test('reminder tool keeps non-owner private chats blocked', async () => {
  const result = await handleReminder(
    { request: 'ingatkan aku 10 menit lagi minum obat' },
    { jid: '999999999@s.whatsapp.net', sock: {} },
  )
  assert.equal(result.success, false)
  assert.match(result.error || '', /owner/i)
})

test('group reminders allow every member and preserve tagged JIDs', () => {
  const owner = config.OWNER_LID || config.OWNER_NUMBER
  assert.equal(isReminderAllowedContext({ jid: 'group@g.us', participant: '123456789@lid', rawMessage: {} }), true)
  assert.equal(isReminderAllowedContext({ jid: 'group@g.us', rawMessage: {} }), false)
  assert.equal(isReminderAllowedContext({ jid: `${owner}@s.whatsapp.net`, rawMessage: {} }), true)
  assert.equal(isReminderAllowedContext({ jid: '999999999@s.whatsapp.net', rawMessage: {} }), false)

  const raw = {
    message: {
      extendedTextMessage: {
        contextInfo: {
          mentionedJid: ['111@s.whatsapp.net', '222@lid', '111@s.whatsapp.net'],
        },
      },
    },
  }
  assert.deepEqual(extractReminderMentions(raw), ['111@s.whatsapp.net', '222@lid'])
  assert.deepEqual(extractReminderMentions(raw, ['222@lid']), ['111@s.whatsapp.net'])
})

test('group reminder wording receives the active group persona', async () => {
  const originalChat = (aiBridge as any).chat
  let systemPrompt = ''
  try {
    (aiBridge as any).chat = async ({ messages }: any) => {
      systemPrompt = messages[0]?.content || ''
      return { content: 'Waktunya main, gas!', toolCalls: [] }
    }
    const text = await aiBridge.composeReminderMessage('main bareng', true, {
      name: 'group',
      identity: 'PERSONA_GRUP_UNIK',
      soul: 'Santai dan kocak.',
      agent: 'Teman ngobrol grup.',
      tools: [],
    })
    assert.equal(text, 'Waktunya main, gas!')
    assert.match(systemPrompt, /PERSONA_GRUP_UNIK/)
    assert.match(systemPrompt, /Santai dan kocak/)
  } finally {
    (aiBridge as any).chat = originalChat
  }
})

test('owner greeting schedule adapts between weekdays and weekends', () => {
  const weekday = ownerGreetingSchedule(new Date('2026-08-03T06:45:00+07:00'))
  const weekend = ownerGreetingSchedule(new Date('2026-08-08T08:00:00+07:00'))

  assert.equal(weekday.isWeekend, false)
  assert.equal(weekend.isWeekend, true)
  assert.equal(weekday.date, '2026-08-03')
  assert.equal(weekend.date, '2026-08-08')
  assert.ok(weekday.slots.find(slot => slot.period === 'pagi')!.targetMinute < 7 * 60 + 1)
  assert.ok(weekend.slots.find(slot => slot.period === 'pagi')!.targetMinute >= 7 * 60 + 30)
  assert.ok(weekday.slots.find(slot => slot.period === 'malam')!.targetMinute >= 21 * 60 + 50)
  assert.ok(weekend.slots.find(slot => slot.period === 'malam')!.targetMinute <= 22 * 60 + 15)
  assert.deepEqual(weekday.slots.map(slot => slot.period), ['pagi', 'siang', 'sore', 'apresiasi', 'malam'])
  const appreciation = weekend.slots.find(slot => slot.period === 'apresiasi')!
  assert.ok(appreciation.targetMinute >= 19 * 60)
  assert.ok(appreciation.targetMinute <= 20 * 60)
})

test('owner greeting claims prevent duplicate sends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bot-db-'))
  const db = new BotDatabase(join(dir, 'test.db'))
  try {
    assert.equal(db.claimOwnerGreeting('2026-08-08', 'pagi'), true)
    assert.equal(db.claimOwnerGreeting('2026-08-08', 'pagi'), false)
    db.releaseOwnerGreeting('2026-08-08', 'pagi')
    assert.equal(db.claimOwnerGreeting('2026-08-08', 'pagi'), true)
    db.completeOwnerGreeting('2026-08-08', 'pagi')
    assert.equal(db.claimOwnerGreeting('2026-08-08', 'pagi'), false)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('database persists member directory and outgoing reply IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bot-db-'))
  const file = join(dir, 'test.db')
  let db = new BotDatabase(file)
  try {
    db.upsertMember('group@g.us', '123@lid', 'Christo', 'halo')
    db.upsertMember('group@g.us', '123@lid', 'Christo', 'lagi apa')
    const member = db.findMembers('group@g.us', 'Christo')[0]
    assert.equal(member.displayName, 'Christo')
    assert.equal(member.messageCount, 2)

    db.rememberOutgoing('group@g.us', 'MSG-1', 'sticker')
    db.setMemberName('group@g.us', '123@lid', 'Chris')
    db.upsertMember('group@g.us', '123@lid', 'WhatsApp Name', 'pesan berikutnya')
    assert.equal(db.findMembers('group@g.us', 'Chris')[0].displayName, 'Chris')
    db.close()
    db = new BotDatabase(file)
    assert.equal(db.isOutgoing('group@g.us', 'MSG-1'), true)
    db.setToolContext('owner@lid', '4khd-search', { posts: [{ title: 'Machi' }] })
    db.close()
    db = new BotDatabase(file)
    assert.deepEqual(db.getToolContext('owner@lid', '4khd-search', 60_000), {
      posts: [{ title: 'Machi' }],
    })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('media jobs and reminders can only be cancelled by their creator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bot-db-'))
  const db = new BotDatabase(join(dir, 'test.db'))
  try {
    const job = db.createMediaJob('group@g.us', 'alice', 'img-gen', 'queued')
    assert.equal(db.mediaJobStatus(job.id), 'queued')
    assert.equal(db.cancelMediaJobs('group@g.us', 'bob', job.id), 0)
    assert.equal(db.cancelMediaJobs('group@g.us', 'alice', job.id), 1)

    const reminder = db.createReminder('group@g.us', 'alice', 'rapat', Date.now() + 60_000, '', ['111@s.whatsapp.net', '222@lid'])
    assert.deepEqual(reminder.mentions, ['111@s.whatsapp.net', '222@lid'])
    assert.deepEqual(db.listReminders('group@g.us')[0].mentions, ['111@s.whatsapp.net', '222@lid'])
    assert.equal(db.cancelReminder('group@g.us', 'bob', reminder.id), 0)
    assert.equal(db.cancelReminder('group@g.us', 'alice', reminder.id), 1)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sticker selector matches emotion and avoids a recently used sticker', () => {
  const entries: StickerPoolEntry[] = [
    { file: '/pool/funny-a.webp', tags: ['lucu', 'kocak', 'bercanda'] },
    { file: '/pool/funny-b.webp', tags: ['lucu', 'humor'] },
    { file: '/pool/angry.webp', tags: ['marah', 'kesal', 'emosi'] },
  ]
  assert.equal(selectByContext(entries, 'aku marah banget')?.entry.file, '/pool/angry.webp')
  assert.equal(selectByContext(entries, 'wkwk ngakak', ['funny-a.webp'])?.entry.file, '/pool/funny-b.webp')
})

test('natural 4KHD searches route directly to native tools', () => {
  assert.deepEqual(parseFourkhdSearchIntent('Cariin machi di 4khd'), {
    toolName: '4khd-search',
    args: { query: 'machi' },
  })
  assert.deepEqual(parseFourkhdSearchIntent('@5846088061042 cariin di 4khd Furina'), {
    toolName: '4khd-search',
    args: { query: 'Furina' },
  })
  assert.deepEqual(parseFourkhdSearchIntent('cek terbaru di 4khd'), {
    toolName: '4khd-latest',
    args: {},
  })
  assert.equal(parseFourkhdSearchIntent('cariin machi'), null)
})

test('Hu Tao auto voice always handles VN and explicit requests', () => {
  const base = {
    enabled: false,
    response: 'iyaa, aku dengerin kok 😊',
    autoStickerSent: false,
    isCommand: false,
    chance: 0,
    cooldownMs: 600_000,
    maxChars: 240,
  }
  assert.equal(decideAutoVoice({ ...base, messageType: 'audio', messageText: '' }).reason, 'audio-reply')
  assert.equal(decideAutoVoice({ ...base, messageType: 'text', messageText: 'balas pakai vn dong' }).reason, 'explicit-request')
  assert.equal(prepareVoiceText('*halo* 😂 https://example.com'), 'halo link')
})

test('Hu Tao automatic voice uses chance, cooldown, and avoids sticker overlap', () => {
  const base = {
    enabled: true,
    messageType: 'text',
    messageText: 'wkwk lucu banget',
    response: 'iya, aku juga ngakak banget!',
    autoStickerSent: false,
    isCommand: false,
    chance: 0.18,
    cooldownMs: 600_000,
    maxChars: 240,
    now: 1_000_000,
  }
  assert.equal(decideAutoVoice({ ...base, random: () => 0.1 }).reason, 'automatic')
  assert.equal(decideAutoVoice({ ...base, random: () => 0.9 }).send, false)
  assert.equal(decideAutoVoice({ ...base, lastVoiceAt: 900_000, random: () => 0 }).send, false)
  assert.equal(decideAutoVoice({ ...base, autoStickerSent: true, random: () => 0 }).send, false)
  assert.equal(decideAutoVoice({ ...base, messageText: 'tolong debug kode ini', random: () => 0 }).send, false)
})

test('Hu Tao TTS normalizes Indonesian numbers, money, dates, times, and ranges', () => {
  assert.equal(numberToIndonesian(25), 'dua puluh lima')
  assert.equal(numberToIndonesian(25000), 'dua puluh lima ribu')
  assert.equal(
    normalizeForHuTaoVoice('Kirim 25 foto seharga Rp 25.000 pada 02/08/2026 jam 04:30, diskon 10%.'),
    'Kirim dua puluh lima foto seharga dua puluh lima ribu rupiah pada dua Agustus dua ribu dua puluh enam jam empat lewat tiga puluh menit, diskon sepuluh persen.',
  )
  assert.equal(normalizeForHuTaoVoice('Pilih nomor 1-3 dan urutan ke-2.'), 'Pilih nomor satu sampai tiga dan urutan ke dua.')
})

test('bot ignore-list config is available for loop prevention', async () => {
  const { config } = await import('../src/system/config.js')
  assert.ok(Array.isArray(config.IGNORED_BOT_IDS))
})

test('smeme turns a video into an animated WebP sticker', async (t) => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  } catch {
    t.skip('ffmpeg tidak tersedia')
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'wa-bot-smeme-'))
  const videoPath = join(dir, 'input.mp4')
  let outputPath = ''
  try {
    execFileSync('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=8:duration=1',
      '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', videoPath,
    ], { stdio: 'ignore' })
    const video = readFileSync(videoPath)
    const result = await handleSmeme({ text: 'ATAS | BAWAH' }, {
      rawMessage: { message: { videoMessage: {} } },
      downloadMedia: async () => video,
    })

    assert.equal(result.success, true, result.error)
    assert.ok(result.filePath)
    outputPath = result.filePath!
    const webp = readFileSync(outputPath)
    assert.equal(webp.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(webp.subarray(8, 12).toString('ascii'), 'WEBP')
    assert.ok(webp.includes(Buffer.from('ANMF')), 'hasil harus memiliki frame animasi')
  } finally {
    if (outputPath) rmSync(outputPath, { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

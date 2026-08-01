import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BotDatabase } from '../src/storage/database.js'
import { parseReminderRequest } from '../src/reminders/parser.js'
import { selectByContext, type StickerPoolEntry } from '../src/tools/handlers/sticker-pool.js'
import { handleSmeme } from '../src/tools/handlers/smeme.js'

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

    const reminder = db.createReminder('group@g.us', 'alice', 'rapat', Date.now() + 60_000)
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

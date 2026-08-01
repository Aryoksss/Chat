// ============================================================
// Tool: Sticker Pool — send a context-matched sticker from the local pool
// ============================================================

import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { Sticker } from 'wa-sticker-formatter'
import { config } from '../../system/config.js'
import { logger } from '../../system/logger.js'
import { botDatabase } from '../../storage/database.js'

const POOL_EXTENSIONS = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif'])
const INDEX_FILE = 'index.json'

export interface StickerPoolEntry {
  file: string
  tags: string[]
  description?: string
}

export async function listStickerPoolFiles(poolDir = config.STICKER_POOL_DIR): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(poolDir)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  const files: string[] = []
  for (const entry of entries) {
    if (!POOL_EXTENSIONS.has(extname(entry).toLowerCase())) continue
    const filePath = join(poolDir, entry)
    try {
      if ((await stat(filePath)).isFile()) files.push(filePath)
    } catch {
      // Ignore files that disappear while the pool is being scanned.
    }
  }
  return files.sort()
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase('id-ID').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean)
}

async function loadPoolEntries(files: string[]): Promise<StickerPoolEntry[]> {
  const fileByName = new Map(files.map(file => [file.split('/').pop()!, file]))
  const indexPath = join(config.STICKER_POOL_DIR, INDEX_FILE)
  let indexed: Array<Partial<StickerPoolEntry>> = []
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    if (!Array.isArray(parsed)) throw new Error(`${INDEX_FILE} harus berupa array`)
    indexed = parsed
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }

  // Filename tags are a useful fallback, while index.json allows precise tags.
  return files.map(file => {
    const name = file.split('/').pop()!
    const metadata = indexed.find(entry => entry.file === name)
    const tags = metadata?.tags?.length
      ? metadata.tags
      : name.replace(/\.[^.]+$/, '').split(/[-_. ]+/)
    return { file: fileByName.get(name)!, tags, description: metadata?.description }
  })
}

const SEMANTIC_GROUPS: Array<{ match: RegExp; terms: string[] }> = [
  { match: /\b(wkwk|haha|ngakak|ketawa|lucu|kocak|receh|lawak)\b|[🤣😂]/i, terms: ['lucu', 'kocak', 'humor', 'meme', 'bercanda'] },
  { match: /\b(sedih|nangis|galau|kecewa|duka)\b|[😭😢]/i, terms: ['sedih', 'nangis', 'kecewa', 'galau'] },
  { match: /\b(marah|kesal|kesel|sebel|emosi|benci)\b|[😡🤬]/i, terms: ['marah', 'kesal', 'emosi'] },
  { match: /\b(kaget|shock|terkejut|serius|hah)\b|[😱😮]/i, terms: ['kaget', 'shock', 'terkejut'] },
  { match: /\b(bingung|mikir|logis|ragu|heran|kenapa)\b|[🤔]/i, terms: ['bingung', 'mikir', 'ragu', 'tanya', 'logis'] },
  { match: /\b(setuju|mantap|bagus|keren|gas|oke|sip)\b|[👍🔥]/i, terms: ['setuju', 'mantap', 'semangat'] },
  { match: /\b(cinta|sayang|kangen|rindu|gemas)\b|[❤😍🥰]/i, terms: ['cinta', 'sayang', 'kangen'] },
  { match: /\b(malu|awkward|cringe|canggung)\b|[😳]/i, terms: ['malu', 'awkward', 'cringe'] },
]

const GENERIC_TERMS = new Set(['lucu', 'random', 'santai', 'meme', 'humor'])

export function selectByContext(
  entries: StickerPoolEntry[],
  context: string,
  recentFiles: string[] = [],
): { entry: StickerPoolEntry; score: number; confidence: number } | null {
  const normalizedContext = context.toLocaleLowerCase('id-ID')
  const contextTokens = new Set(tokenize(context))
  const semanticTerms = new Set<string>()
  for (const group of SEMANTIC_GROUPS) {
    if (group.match.test(context)) group.terms.forEach(term => semanticTerms.add(term))
  }
  if (contextTokens.size === 0 && semanticTerms.size === 0) {
    const fallback = entries.find(entry => tokenize(entry.tags.join(' ')).includes('default'))
    return fallback ? { entry: fallback, score: 1, confidence: 1 } : null
  }

  const ranked = entries.map(entry => {
    const tagPhrases = entry.tags.map(tag => tag.toLocaleLowerCase('id-ID').trim()).filter(Boolean)
    const tagTokens = new Set(tokenize(tagPhrases.join(' ')))
    const descriptionTokens = new Set(tokenize(entry.description || ''))
    let score = 0

    for (const phrase of tagPhrases) {
      if (phrase.length >= 3 && normalizedContext.includes(phrase)) score += GENERIC_TERMS.has(phrase) ? 3 : 7
    }
    for (const token of contextTokens) {
      if (tagTokens.has(token)) score += GENERIC_TERMS.has(token) ? 1.5 : 4
      else if (token.length >= 4 && descriptionTokens.has(token)) score += 0.75
    }
    for (const term of semanticTerms) {
      if (tagTokens.has(term)) score += GENERIC_TERMS.has(term) ? 1 : 2.5
    }
    return { entry, score }
  }).filter(candidate => candidate.score >= 2)
    .sort((a, b) => b.score - a.score || a.entry.file.localeCompare(b.entry.file))

  if (ranked.length === 0) return null
  const bestScore = ranked[0].score
  // Prefer an equally relevant sticker that was not used recently. This is a
  // deterministic rotation, not random selection.
  const fresh = ranked.find(candidate =>
    !recentFiles.includes(candidate.entry.file.split('/').pop()!) && candidate.score >= bestScore * 0.30
  )
  const selected = fresh || ranked[0]
  const confidence = Math.min(1, selected.score / 10)
  return { ...selected, confidence }
}

export async function handleStickerPool(args: { context?: string } = {}, toolContext?: { jid?: string }): Promise<{
  success: boolean
  text?: string
  filePath?: string
  fileType?: 'sticker'
  error?: string
}> {
  try {
    const files = await listStickerPoolFiles()
    if (files.length === 0) {
      return { success: false, text: `Pool sticker masih kosong. Tambahkan file sticker ke ${config.STICKER_POOL_DIR}.` }
    }
    const context = (args.context || '').trim()
    const entries = await loadPoolEntries(files)
    const recentFiles = toolContext?.jid ? botDatabase.recentStickerFiles(toolContext.jid, 4) : []
    const selected = selectByContext(entries, context, recentFiles)
    if (!selected) {
      logger.info({ context, poolCount: entries.length }, 'No contextual sticker matched')
      return {
        success: false,
        text: `Belum ada sticker yang cocok untuk konteks "${context || 'kosong'}". Tambahkan tag yang sesuai di ${join(config.STICKER_POOL_DIR, INDEX_FILE)}.`,
      }
    }
    const selectedFile = selected.entry.file.split('/').pop()!
    logger.info({ context, selected: selectedFile, tags: selected.entry.tags, score: selected.score, confidence: selected.confidence, recentFiles }, 'Contextual sticker selected')
    const source = resolve(selected.entry.file)
    const output = join(tmpdir(), `sticker_pool_${Date.now()}.webp`)
    if (extname(source).toLowerCase() === '.webp') {
      // The executor removes returned temp files after sending, so never return the pool file itself.
      await copyFile(source, output)
    } else {
      const sticker = new Sticker(await readFile(source), { pack: '🕷', author: 'yoks', quality: 80 })
      await writeFile(output, await sticker.build())
    }
    if (toolContext?.jid) botDatabase.recordStickerUsage(toolContext.jid, selectedFile)
    return { success: true, text: 'Sticker pool dikirim!', filePath: output, fileType: 'sticker' }
  } catch (err: any) {
    return { success: false, error: `Gagal ambil sticker pool: ${err.message}` }
  }
}

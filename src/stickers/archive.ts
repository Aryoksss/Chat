import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { config } from '../system/config.js'

/** Save an incoming WhatsApp sticker once, using its content hash for deduplication. */
export async function archiveIncomingSticker(buffer: Buffer, source: 'owner' | 'group'): Promise<string> {
  const hash = createHash('sha256').update(buffer).digest('hex')
  await mkdir(config.STICKER_ARCHIVE_DIR, { recursive: true })
  const filePath = join(config.STICKER_ARCHIVE_DIR, `sticker_${hash}.webp`)
  await writeFile(filePath, buffer, { flag: 'wx' }).catch((err: any) => {
    // The same sticker may be forwarded repeatedly; an existing hash is fine.
    if (err?.code !== 'EEXIST') throw err
  })
  return filePath
}

interface StickerMetadata {
  file: string
  tags: string[]
  description: string
  source?: 'owner' | 'group'
  analyzedAt?: string
}

export interface StickerPoolItem extends StickerMetadata {}

async function readPoolIndex(): Promise<StickerMetadata[]> {
  try {
    const parsed = JSON.parse(await readFile(join(config.STICKER_POOL_DIR, 'index.json'), 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
}

async function writePoolIndex(index: StickerMetadata[]): Promise<void> {
  await mkdir(config.STICKER_POOL_DIR, { recursive: true })
  await writeFile(join(config.STICKER_POOL_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n')
}

export async function listStickerMetadata(): Promise<StickerPoolItem[]> {
  return readPoolIndex()
}

function resolveStickerIndex(index: StickerMetadata[], identifier: string): number {
  const numeric = Number.parseInt(identifier, 10)
  if (/^\d+$/.test(identifier) && numeric >= 1 && numeric <= index.length) return numeric - 1
  const query = basename(identifier).toLocaleLowerCase('id-ID')
  return index.findIndex(entry => {
    const file = entry.file.toLocaleLowerCase('id-ID')
    return file === query || file.startsWith(query) || file.includes(query)
  })
}

export async function retagSticker(
  identifier: string,
  tags: string[],
  description?: string,
): Promise<StickerPoolItem | null> {
  const index = await readPoolIndex()
  const position = resolveStickerIndex(index, identifier)
  if (position < 0) return null
  index[position] = {
    ...index[position],
    tags: Array.from(new Set(tags.map(tag => tag.trim().toLocaleLowerCase('id-ID')).filter(Boolean))).slice(0, 30),
    description: description?.trim() || index[position].description,
  }
  await writePoolIndex(index)
  return index[position]
}

export async function deleteStickerFromPool(identifier: string): Promise<StickerPoolItem | null> {
  const index = await readPoolIndex()
  const position = resolveStickerIndex(index, identifier)
  if (position < 0) return null
  const [removed] = index.splice(position, 1)
  await writePoolIndex(index)
  await unlink(join(config.STICKER_POOL_DIR, basename(removed.file))).catch((err: any) => {
    if (err?.code !== 'ENOENT') throw err
  })
  return removed
}

export async function isStickerInPool(archivePath: string): Promise<boolean> {
  const file = basename(archivePath)
  return (await readPoolIndex()).some(entry => entry.file === file)
}

/** Return the semantic context previously assigned to a pooled sticker. */
export async function getStickerPoolContext(archivePath: string): Promise<string | null> {
  const file = basename(archivePath)
  const entry = (await readPoolIndex()).find(item => item.file === file)
  if (!entry) return null
  return [...entry.tags, entry.description].filter(Boolean).join(' ')
}

/** Promote an archived sticker into the contextual pool with its AI metadata. */
export async function promoteStickerToPool(
  archivePath: string,
  analysis: { description: string; tags: string[] },
  source: 'owner' | 'group',
): Promise<string> {
  const file = basename(archivePath)
  await mkdir(config.STICKER_POOL_DIR, { recursive: true })
  const poolPath = join(config.STICKER_POOL_DIR, file)
  await copyFile(archivePath, poolPath)

  const index = await readPoolIndex()
  const entry: StickerMetadata = {
    file,
    tags: analysis.tags,
    description: analysis.description,
    source,
    analyzedAt: new Date().toISOString(),
  }
  const existing = index.findIndex(item => item.file === file)
  if (existing >= 0) index[existing] = entry
  else index.push(entry)
  await writePoolIndex(index)
  return poolPath
}

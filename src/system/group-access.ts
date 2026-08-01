import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from './config.js'

const decisions = new Map<string, boolean>()

export async function loadGroupAccess(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(config.GROUP_ACCESS_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const [jid, allowed] of Object.entries(parsed)) {
        if (typeof allowed === 'boolean') decisions.set(jid, allowed)
      }
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }
}

export function getGroupAccess(jid: string): boolean | undefined {
  return decisions.get(jid)
}

export async function setGroupAccess(jid: string, allowed: boolean): Promise<void> {
  decisions.set(jid, allowed)
  await mkdir(dirname(config.GROUP_ACCESS_FILE), { recursive: true })
  await writeFile(config.GROUP_ACCESS_FILE, JSON.stringify(Object.fromEntries(decisions), null, 2) + '\n')
}

export async function findKnownGroups(subjectQuery?: string): Promise<Array<{ id: string; subject: string; allowed?: boolean }>> {
  try {
    const parsed = JSON.parse(await readFile(config.GROUP_REGISTRY_FILE, 'utf8'))
    const groups = Object.entries(parsed || {}) as Array<[string, any]>
    const query = subjectQuery?.trim().toLocaleLowerCase('id-ID')
    return groups
      .map(([id, group]) => ({ id, subject: String(group?.subject || '(tanpa nama)'), allowed: group?.allowed }))
      .filter(group => !query || group.subject.toLocaleLowerCase('id-ID') === query)
      .sort((a, b) => a.subject.localeCompare(b.subject) || a.id.localeCompare(b.id))
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
}

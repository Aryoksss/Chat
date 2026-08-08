import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../system/config.js'
import type { FinanceEmailInput } from './types.js'

interface OAuthClientDefinition {
  client_id: string
  client_secret: string
  redirect_uris?: string[]
}

interface OAuthClientFile {
  installed?: OAuthClientDefinition
  web?: OAuthClientDefinition
}

interface OAuthTokenFile {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  expiry_date?: number
  token_type?: string
  scope?: string
}

interface SharedRefreshResult {
  accessToken: string
  expiryDate: number
}

// Gmail polling and Sheets sync use separate client instances, but share one
// token file. Serialize refreshes so both clients cannot rename the same .tmp
// file at once.
let sharedRefreshPromise: Promise<SharedRefreshResult> | null = null

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isTransient(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

interface GmailHeader {
  name?: string
  value?: string
}

interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  internalDate?: string
  payload?: GmailPart
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized, 'base64').toString('utf8')
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  }
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return named[lower] || ' '
  })
}

export function htmlToFinanceText(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<\/(?:td|th)>\s*<(?:td|th)\b[^>]*>/gi, ': ')
    .replace(/<\s*(?:br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<\s*(?:td|th)\b[^>]*>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

function collectBodies(part: GmailPart | undefined, plain: string[], html: string[]): void {
  if (!part) return
  const mime = (part.mimeType || '').toLowerCase()
  if (part.body?.data && !part.filename) {
    const decoded = base64UrlDecode(part.body.data)
    if (mime === 'text/plain') plain.push(decoded)
    else if (mime === 'text/html') html.push(decoded)
  }
  for (const child of part.parts || []) collectBodies(child, plain, html)
}

function headerMap(headers: GmailHeader[] = []): Map<string, string> {
  const result = new Map<string, string>()
  for (const header of headers) {
    if (header.name && header.value) result.set(header.name.toLowerCase(), header.value)
  }
  return result
}

export function extractEmailAddress(value: string): string {
  const bracket = value.match(/<([^<>\s]+@[^<>\s]+)>/)
  const plain = value.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/i)
  return (bracket?.[1] || plain?.[0] || '').toLowerCase()
}

export function decodeGmailMessage(message: GmailMessage): FinanceEmailInput {
  const headers = headerMap(message.payload?.headers)
  const plain: string[] = []
  const html: string[] = []
  collectBodies(message.payload, plain, html)
  const body = (plain.join('\n').trim() || htmlToFinanceText(html.join('\n'))).slice(0, 20_000)
  const auth = `${headers.get('authentication-results') || ''} ${headers.get('arc-authentication-results') || ''}`
  return {
    messageId: message.id,
    sender: extractEmailAddress(headers.get('from') || ''),
    subject: (headers.get('subject') || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    body,
    receivedAt: Number(message.internalDate) || Date.now(),
    authenticated: /\b(?:dkim|dmarc)=pass\b/i.test(auth),
  }
}

export class GmailReadOnlyClient {
  private client?: OAuthClientDefinition
  private token?: OAuthTokenFile

  async listMessageIds(labelName: string, sinceMs: number, includeOlderLabelChanges = false): Promise<string[]> {
    const labelId = await this.resolveLabelId(labelName)
    if (!labelId) throw new Error(`Label Gmail "${labelName}" tidak ditemukan`)
    const ids: string[] = []
    let pageToken = ''
    do {
      const params = new URLSearchParams({
        labelIds: labelId,
        maxResults: '100',
        includeSpamTrash: 'false',
      })
      if (!includeOlderLabelChanges) params.set('q', `after:${Math.floor(sinceMs / 1000)}`)
      if (pageToken) params.set('pageToken', pageToken)
      const data = await this.api<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>(
        `/users/me/messages?${params}`,
      )
      for (const message of data.messages || []) {
        if (message.id && !ids.includes(message.id)) ids.push(message.id)
        if (ids.length >= 500) return ids
      }
      pageToken = data.nextPageToken || ''
    } while (pageToken)
    return ids
  }

  async listMessageIdsByQuery(query: string, sinceMs: number, includeOlder = false): Promise<string[]> {
    const ids: string[] = []
    let pageToken = ''
    do {
      const params = new URLSearchParams({
        q: includeOlder ? query : `${query} after:${Math.floor(sinceMs / 1000)}`,
        maxResults: '100',
        includeSpamTrash: 'false',
      })
      if (pageToken) params.set('pageToken', pageToken)
      const data = await this.api<{ messages?: Array<{ id?: string }>; nextPageToken?: string }>(
        `/users/me/messages?${params}`,
      )
      for (const message of data.messages || []) {
        if (message.id && !ids.includes(message.id)) ids.push(message.id)
        if (ids.length >= 500) return ids
      }
      pageToken = data.nextPageToken || ''
    } while (pageToken)
    return ids
  }

  async getMessage(id: string): Promise<FinanceEmailInput> {
    const data = await this.api<GmailMessage>(`/users/me/messages/${encodeURIComponent(id)}?format=full`)
    return decodeGmailMessage(data)
  }

  /** Reuse the same OAuth token for Google APIs such as Sheets. */
  async getGoogleAccessToken(): Promise<string> {
    return this.accessToken()
  }

  private async resolveLabelId(name: string): Promise<string | undefined> {
    const data = await this.api<{ labels?: Array<{ id?: string; name?: string }> }>('/users/me/labels')
    return data.labels?.find(label => label.name?.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))?.id
  }

  private async api<T>(path: string, attempt = 0): Promise<T> {
    const accessToken = await this.accessToken()
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 401 && attempt === 0) {
      if (this.token) this.token.expiry_date = 0
      return this.api<T>(path, 1)
    }
    if (isTransient(response.status) && attempt < 2) {
      await sleep(500 * (attempt + 1))
      return this.api<T>(path, attempt + 1)
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      throw new Error(`Gmail API ${response.status}: ${detail}`)
    }
    return response.json() as Promise<T>
  }

  private async accessToken(): Promise<string> {
    await this.loadCredentials()
    if (this.token?.access_token && Number(this.token.expiry_date || 0) > Date.now() + 60_000) {
      return this.token.access_token
    }
    if (!this.client || !this.token?.refresh_token) {
      throw new Error('Refresh token Gmail belum tersedia. Jalankan npm run finance:gmail-auth')
    }
    if (sharedRefreshPromise) {
      const shared = await sharedRefreshPromise
      this.token = { ...this.token, access_token: shared.accessToken, expiry_date: shared.expiryDate }
      return shared.accessToken
    }

    sharedRefreshPromise = (async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: this.client!.client_id,
            client_secret: this.client!.client_secret,
            refresh_token: this.token!.refresh_token!,
            grant_type: 'refresh_token',
          }),
          signal: AbortSignal.timeout(30_000),
        })
        if (response.ok) {
          const refreshed = await response.json() as OAuthTokenFile
          if (!refreshed.access_token) throw new Error('OAuth Gmail tidak mengembalikan access token')
          const expiryDate = Date.now() + Number(refreshed.expires_in || 3600) * 1000
          this.token = { ...this.token, ...refreshed, expiry_date: expiryDate }
          await this.saveToken()
          return { accessToken: refreshed.access_token, expiryDate }
        }
        const detail = (await response.text()).slice(0, 300)
        if (!isTransient(response.status) || attempt === 2) {
          throw new Error(`OAuth Gmail gagal (${response.status}): ${detail}`)
        }
        await sleep(500 * (attempt + 1))
      }
      throw new Error('OAuth Gmail gagal setelah retry')
    })()

    try {
      const shared = await sharedRefreshPromise
      return shared.accessToken
    } finally {
      sharedRefreshPromise = null
    }
  }

  private async loadCredentials(): Promise<void> {
    if (this.client && this.token) return
    const [clientRaw, tokenRaw] = await Promise.all([
      readFile(config.FINANCE_GMAIL_CLIENT_FILE, 'utf8'),
      readFile(config.FINANCE_GMAIL_TOKEN_FILE, 'utf8'),
    ])
    const clientFile = JSON.parse(clientRaw) as OAuthClientFile
    this.client = clientFile.installed || clientFile.web
    this.token = JSON.parse(tokenRaw) as OAuthTokenFile
    if (!this.client?.client_id || !this.client.client_secret) {
      throw new Error('File OAuth client Gmail tidak valid')
    }
  }

  private async saveToken(): Promise<void> {
    if (!this.token) return
    const file = config.FINANCE_GMAIL_TOKEN_FILE
    const temporary = `${file}.${process.pid}.tmp`
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify(this.token, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, file)
  }
}

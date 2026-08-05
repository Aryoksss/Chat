import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { config } from '../src/system/config.js'

interface OAuthClient {
  client_id: string
  client_secret: string
}

async function main(): Promise<void> {
  const raw = await readFile(config.FINANCE_GMAIL_CLIENT_FILE, 'utf8')
  await chmod(config.FINANCE_GMAIL_CLIENT_FILE, 0o600).catch(() => {})
  const parsed = JSON.parse(raw) as { installed?: OAuthClient; web?: OAuthClient }
  const client = parsed.installed || parsed.web
  if (!client?.client_id || !client.client_secret) throw new Error('File OAuth client Gmail tidak valid')

  const state = randomBytes(24).toString('hex')
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth2/callback') {
        response.writeHead(404).end('Not found')
        return
      }
      if (url.searchParams.get('state') !== state) throw new Error('OAuth state tidak cocok')
      const error = url.searchParams.get('error')
      if (error) throw new Error(`Google OAuth ditolak: ${error}`)
      const code = url.searchParams.get('code')
      if (!code) throw new Error('Authorization code tidak diterima')
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Gmail dan Google Sheets sudah terhubung. Tab ini boleh ditutup.')
      resolveCode(code)
    } catch (err) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(err instanceof Error ? err.message : String(err))
      rejectCode(err instanceof Error ? err : new Error(String(err)))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Gagal membuka callback OAuth lokal')
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/spreadsheets',
    ].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  }).toString()

  console.log('\nBuka URL berikut di browser pada komputer ini:\n')
  console.log(authUrl.toString())
  console.log('\nMenunggu login Google (maksimal 5 menit)...\n')

  const timeout = setTimeout(() => rejectCode(new Error('OAuth timeout setelah 5 menit')), 5 * 60_000)
  try {
    const code = await codePromise
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Token exchange gagal (${response.status}): ${(await response.text()).slice(0, 300)}`)
    const token = await response.json() as Record<string, unknown>
    if (!token.refresh_token) throw new Error('Google tidak memberikan refresh token; cabut akses aplikasi lalu coba lagi')
    token.expiry_date = Date.now() + Number(token.expires_in || 3600) * 1000
    await mkdir(dirname(config.FINANCE_GMAIL_TOKEN_FILE), { recursive: true, mode: 0o700 })
    await writeFile(config.FINANCE_GMAIL_TOKEN_FILE, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 })
    console.log(`Token tersimpan aman di ${config.FINANCE_GMAIL_TOKEN_FILE}`)
    console.log('Selanjutnya copy file OAuth client + token ke path yang sama di VPS, lalu set FINANCE_ENABLED=true dan FINANCE_SHEETS_ENABLED=true jika ingin memakai spreadsheet.')
  } finally {
    clearTimeout(timeout)
    server.close()
  }
}

main().catch(error => {
  console.error(`Gagal menghubungkan Gmail: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})

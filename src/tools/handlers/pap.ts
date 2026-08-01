// ============================================================
// Tool: PAP (Owner Only) — kirim foto pap saat owner minta
// ============================================================
// KHUSUS OWNER. Tidak muncul di menu mana pun, dan ditolak kalau
// dipanggil/di-reply dari chat grup atau oleh pengirim non-owner.
//
// Alur (generate dari foto dataset, Wajah TIDAK dijamin identik):
//   1) Pilih 1 foto acak dari `data/pap/`.
//   2) Edit foto itu via Cloudflare FLUX (input_image_0) → gambar baru dari
//      foto milik owner. Wajah diminta dijaga semirip mungkin, TAPI FLUX Klein
//      tidak menjamin identitas persis.
//   3) Kalau dataset kosong → generate teks via 9router.
//   4) Kalau Cloudflare gagal → kirim foto asli dataset sebagai fallback.
//
// Handler menerima `context` (jid/sock) dari executor untuk guard owner.

import { tmpdir } from 'os'
import { join } from 'path'
import { readdir, readFile, writeFile } from 'fs/promises'
import { config } from '../../system/config.js'
import { logger } from '../../system/logger.js'
import sharp from 'sharp'

const PAP_DIR = join(process.cwd(), 'data', 'pap')
const IMAGE_MODEL = 'cf/@cf/black-forest-labs/flux-2-klein-9b'
const CF_MAX_EDGE = 512
const TIMEOUT_MS = 120_000
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp']
// Perlu TIDAK eksplisit: konten. Prompt edit dibuat netral/sopan (selfie wajah
// natural). Tidak membangkitkan konten seksual eksplisit.
// Prompt dioptimalkan agar hasil REALISTIS/fotorealistik (DSLR, skin texture
// asli, lighting natural) — bukan untuk konten eksplisit.
const PAP_REF_PROMPT =
  'keep the same face and identity, natural selfie portrait, photorealistic, ' +
  'DSLR photo, real skin texture with pores, cinematic soft lighting, shallow depth of field, ' +
  'natural skin imperfections, realistic eyes, sharp focus on face, editorial photography style, ' +
  'subtle, authentic, high detail, natural color grading'

interface CfCred {
  accountId: string
  apiKey: string
}

function parseCfCredentials(): CfCred[] {
  const list: CfCred[] = []
  if (config.CF_ACCOUNTS_JSON) {
    try {
      const arr = JSON.parse(config.CF_ACCOUNTS_JSON)
      if (Array.isArray(arr)) {
        for (const c of arr) {
          if (c?.accountId && c?.apiKey) list.push({ accountId: String(c.accountId), apiKey: String(c.apiKey) })
        }
      }
    } catch {
      logger.warn('CF_ACCOUNTS invalid JSON — ignored')
    }
  }
  if (config.CF_ACCOUNT_ID && config.CF_API_KEY) {
    list.push({ accountId: config.CF_ACCOUNT_ID, apiKey: config.CF_API_KEY })
  }
  return list
}

/** Resize input image to Cloudflare limit (≤512 long edge), JPEG. */
async function resizeForCf(buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).metadata()
  const w = meta.width || 0
  const h = meta.height || 0
  const longEdge = Math.max(w, h)
  if (longEdge > CF_MAX_EDGE) {
    const scale = CF_MAX_EDGE / longEdge
    return await sharp(buf)
      .resize(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)))
      .jpeg({ quality: 80 })
      .toBuffer()
  }
  return await sharp(buf).jpeg({ quality: 80 }).toBuffer()
}

/** Generate/edit gambar via Cloudflare Workers AI (input_image_0). */
async function generateWithCloudflare(prompt: string, inputImage: Buffer | null, cred: CfCred): Promise<Buffer> {
  const form = new FormData()
  form.set('prompt', prompt)
  form.set('width', '1024')
  form.set('height', '1024')
  if (inputImage) {
    const resized = await resizeForCf(inputImage)
    form.set('input_image_0', new Blob([new Uint8Array(resized)], { type: 'image/jpeg' }), 'input_0.jpg')
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${cred.accountId}/ai/run/${config.CF_IMAGE_MODEL}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.CF_IMAGE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cred.apiKey}` },
      body: form,
      signal: controller.signal,
    })
  } catch (e: any) {
    throw new Error(e?.name === 'AbortError' ? 'Cloudflare request timed out' : `Cloudflare request failed: ${e.message}`)
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`Cloudflare non-JSON ${res.status}: ${text.slice(0, 300)}`)
  }
  if (!res.ok || json.success === false) {
    throw new Error(`Cloudflare ${res.status}: ${JSON.stringify(json.errors || json.messages || json).slice(0, 400)}`)
  }
  const b64 = json.result?.image || json.image || json.result?.b64_json
  if (!b64) throw new Error('Cloudflare response had no image')
  return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64')
}

// Fraksi nomor/alamat yang dianggap member (bukan owner) untuk menolak dari grup.
const isNonOwner = (jidOrParticipant: string | undefined): boolean => {
  if (!jidOrParticipant) return false
  const n = (jidOrParticipant || '').replace(/[^0-9]/g, '')
  if (!n) return false
  const owner = (config.OWNER_NUMBER || '').replace(/[^0-9]/g, '')
  const ownerLid = (config.OWNER_LID || '').replace(/[^0-9]/g, '')
  if (n && owner && n === owner) return false     // nomor owner
  if (n && ownerLid && n === ownerLid) return false // LID owner
  return true
}

interface PapArgs {
  prompt?: string // opsional: arahan tambahan (dipakai untuk generate/edit)
}

// Caption cuek & minimalis — singkat, kering, datar. Sesuai persona yang
// agak pemalas & cuek, gak lebay dan gak balas-manis.
const PAP_CAPTIONS = [
  'pap.',
  'ini.',
  'udah.',
  'ini ya.',
  'hoo.',
  'yaudah.',
  'ini papnya.',
  '.',
  'sana.',
  'malaz.',
]

function randomCaption(): string {
  return PAP_CAPTIONS[Math.floor(Math.random() * PAP_CAPTIONS.length)]
}

export async function handlePap(
  args: PapArgs,
  context: any,
): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image'; caption?: string; error?: string }> {
  // ---- Guard: pemanggil harus owner (bukan grup/member) ----
  const sender = context?.participant || context?.jid || ''
  if (isNonOwner(sender)) {
    logger.warn({ sender }, 'pap rejected: non-owner caller')
    return { success: false, text: 'Maaf, fitur ini khusus untuk owner.' }
  }

  try {
    // ---- Pilih 1 foto acak dari dataset ----
    let files: string[] = []
    try {
      files = (await readdir(PAP_DIR)).filter(f => IMAGE_EXTS.some(e => f.toLowerCase().endsWith(e)))
    } catch {
      files = []
    }

    const prompt = (() => {
      const userPart = (args.prompt || '').trim()
      return userPart
        ? `${PAP_REF_PROMPT}, ${userPart}`
        : PAP_REF_PROMPT
    })()

    if (files.length > 0) {
      const pick = files[Math.floor(Math.random() * files.length)]
      const srcPath = join(PAP_DIR, pick)

      // 1) Coba edit via Cloudflare FLUX (pakai foto sebagai referensi).
      const creds = parseCfCredentials()
      if (creds.length > 0) {
        try {
          const inputBuf = await readFile(srcPath)
          const start = creds.length > 1 ? Math.floor(Math.random() * creds.length) : 0
          const rotated = [...creds.slice(start), ...creds.slice(0, start)]
          let buffer: Buffer | null = null
          let lastErr = ''
          for (const cred of rotated) {
            try {
              buffer = await generateWithCloudflare(prompt, inputBuf, cred)
              break
            } catch (e: any) {
              lastErr = e.message
            }
          }
          if (buffer) {
            const outPath = join(tmpdir(), `pap_${Date.now()}.png`)
            await writeFile(outPath, buffer)
            return {
              success: true,
              text: 'ini.' ,
              filePath: outPath,
              fileType: 'image',
              caption: randomCaption(),
            }
          }
          logger.warn({ lastErr }, 'pap: all Cloudflare accounts failed, falling back to original photo')
        } catch (err: any) {
          logger.warn({ err }, 'pap: Cloudflare edit failed, falling back to original photo')
        }
      }

      // 2) Fallback: kirim foto asli dataset.
      return {
        success: true,
        text: 'ini.',
        filePath: srcPath,
        fileType: 'image',
        caption: randomCaption(),
      }
    }

    // ---- Dataset kosong → generate teks via 9router ----
    const buffer = await generateWith9router(prompt)
    const outPath = join(tmpdir(), `pap_${Date.now()}.png`)
    await writeFile(outPath, buffer)

    return {
      success: true,
      text: 'ini.',
      filePath: outPath,
      fileType: 'image',
      caption: randomCaption(),
    }
  } catch (err: any) {
    logger.error({ err }, 'pap failed')
    return { success: false, text: 'Gagal kirim pap. Coba lagi nanti kak.' }
  }
}

/** Generate gambar via 9router images API (text-to-image). */
async function generateWith9router(prompt: string): Promise<Buffer> {
  const baseUrl = config.NINE_ROUTER_BASE_URL.replace(/\/+$/, '')
  const body = {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    size: 'auto',
    output_format: 'png',
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.NINE_ROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      throw new Error(`9router image API error ${res.status}: ${t.slice(0, 200)}`)
    }
    const data: any = await res.json()
    const item = data?.data?.[0]
    if (!item) throw new Error('Respons API kosong (tidak ada data[0])')
    if (item.b64_json) return Buffer.from(item.b64_json, 'base64')
    if (item.url || item.image_url) {
      const imgRes = await fetch(item.url || item.image_url)
      if (!imgRes.ok) throw new Error(`Gagal download hasil gambar (HTTP ${imgRes.status})`)
      return Buffer.from(await imgRes.arrayBuffer())
    }
    throw new Error('Respons API tidak memuat gambar')
  } finally {
    clearTimeout(timeout)
  }
}

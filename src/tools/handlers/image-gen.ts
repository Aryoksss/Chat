// ============================================================
// Tool: Image Generate/Edit — Cloudflare FLUX (text→image & edit)
// ============================================================
// PRIMARY: Cloudflare Workers AI directly (multipart FormData with
// `input_image_N` fields) — this is the ONLY format that actually does image
// editing with @cf/black-forest-labs/flux-2-klein-9b (mirrors the VPS tool).
// FALLBACK (no CF creds): 9router /v1/images/generations (text-to-image only;
// its `image` field is accepted but ignored for editing).

import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import sharp from 'sharp'
import { config } from '../../system/config.js'
import { logger } from '../../system/logger.js'

const IMAGE_MODEL = 'cf/@cf/black-forest-labs/flux-2-klein-9b'
const TIMEOUT_MS = 120_000
const CF_MAX_EDGE = 512 // Cloudflare input image limit (long edge, px)

interface ImageGenArgs {
  prompt?: string
}

/** Detect image mime from magic bytes so the edit data-URL is truthful. */
function detectImageMime(buf: Buffer): string {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return 'image/png'
}

/** Grab an attached or replied-to image from the raw WA message (like sticker tool). */
async function extractInputImage(context: any): Promise<Buffer | null> {
  if (!context?.rawMessage || typeof context?.downloadMedia !== 'function') return null
  const raw = context.rawMessage
  const quotedInfo = raw?.message?.extendedTextMessage?.contextInfo
  const quotedMsg = quotedInfo?.quotedMessage

  const directMedia = raw?.message?.imageMessage
  const quotedMedia = quotedMsg?.imageMessage

  if (directMedia) {
    return await context.downloadMedia(raw)
  }
  if (quotedMedia) {
    // Rebuild a WAMessage pointing AT the quoted media so downloadMediaMessage
    // can locate its url/directPath (the raw command message has no media itself).
    return await context.downloadMedia({
      key: {
        remoteJid: raw?.key?.remoteJid,
        fromMe: false,
        id: quotedInfo?.stanzaId || undefined,
      },
      message: quotedMsg,
      messageTimestamp: raw?.messageTimestamp,
    })
  }
  return null
}

/** POST to 9router images API and return the generated image Buffer. */
async function generateImage(prompt: string, inputImage: Buffer | null): Promise<Buffer> {
  const baseUrl = config.NINE_ROUTER_BASE_URL.replace(/\/+$/, '')
  const body: Record<string, unknown> = {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    size: 'auto',
    quality: 'auto',
    background: 'auto',
    image_detail: 'high',
    output_format: 'png',
  }
  if (inputImage) {
    // NOTE: tested 2026-08-01 — 9router accepts this field (HTTP 200) but
    // IGNORES it for cf/flux-2-klein-9b: the output is a fresh text-to-image
    // generation, not an edit of the input. Kept here in case 9router adds
    // real img2img support later.
    body.image = `data:${detectImageMime(inputImage)};base64,${inputImage.toString('base64')}`
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.NINE_ROUTER_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => '')
      // Fallback for edits: try OpenAI-style /v1/images/edits (multipart form-data).
      if (inputImage && response.status >= 400 && response.status < 500) {
        const edited = await tryImageEditsFallback(prompt, inputImage)
        if (edited) return edited
      }
      throw new Error(`9router image API error ${response.status}: ${errText.slice(0, 300)}`)
    }

    const data: any = await response.json()
    const item = data?.data?.[0]
    if (!item) throw new Error('Respons API kosong (tidak ada data[0])')

    if (item.b64_json) {
      return Buffer.from(item.b64_json, 'base64')
    }
    const imgUrl = item.url || item.image_url
    if (imgUrl) {
      const imgRes = await fetch(imgUrl)
      if (!imgRes.ok) throw new Error(`Gagal download hasil gambar (HTTP ${imgRes.status})`)
      return Buffer.from(await imgRes.arrayBuffer())
    }
    throw new Error('Respons API tidak memuat gambar')
  } finally {
    clearTimeout(timeout)
  }
}

/** Fallback: OpenAI-style /v1/images/edits with multipart form-data. */
async function tryImageEditsFallback(prompt: string, inputImage: Buffer): Promise<Buffer | null> {
  const baseUrl = config.NINE_ROUTER_BASE_URL.replace(/\/+$/, '')
  const form = new FormData()
  form.append('model', IMAGE_MODEL)
  form.append('prompt', prompt)
  form.append('n', '1')
  form.append('size', 'auto')
  form.append('output_format', 'png')
  form.append('image', new Blob([new Uint8Array(inputImage)]), 'input.png')

  const response = await fetch(`${baseUrl}/images/edits`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.NINE_ROUTER_API_KEY}` },
    body: form,
  })
  if (!response.ok) return null

  const data: any = await response.json()
  const item = data?.data?.[0]
  if (!item) return null

  if (item.b64_json) return Buffer.from(item.b64_json, 'base64')
  if (item.url || item.image_url) {
    const imgRes = await fetch(item.url || item.image_url)
    if (imgRes.ok) return Buffer.from(await imgRes.arrayBuffer())
  }
  return null
}

/** Resize input image to Cloudflare's limit (≤512 long edge), JPEG. */
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

interface CfCred {
  accountId: string
  apiKey: string
}

/**
 * Collect Cloudflare credentials: CF_ACCOUNTS (JSON array of multiple accounts)
 * plus the single CF_ACCOUNT_ID/CF_API_KEY (if set). Bot rotates through them.
 */
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
      logger.warn('CF_ACCOUNTS is not valid JSON — ignored')
    }
  }
  if (config.CF_ACCOUNT_ID && config.CF_API_KEY) {
    list.push({ accountId: config.CF_ACCOUNT_ID, apiKey: config.CF_API_KEY })
  }
  return list
}

/**
 * Cloudflare Workers AI — the format that actually edits images:
 * multipart FormData with `prompt`, `width`, `height`, `input_image_N`.
 */
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
    throw new Error(`Cloudflare ${res.status}: ${JSON.stringify(json.errors || json.messages || json).slice(0, 500)}`)
  }
  const b64 = json.result?.image || json.image || json.result?.b64_json
  if (!b64) throw new Error('Cloudflare response had no image')
  return Buffer.from(String(b64).replace(/^data:image\/\w+;base64,/, ''), 'base64')
}

export async function handleImageGen(
  args: ImageGenArgs,
  context: any,
): Promise<{ success: boolean; text?: string; filePath?: string; fileType?: 'image'; caption?: string; error?: string }> {
  const prompt = (args.prompt || '').trim()
  if (!prompt) {
    return { success: false, text: 'Kasih prompt-nya dulu kak! Contoh: ".gambar kucing pakai topi"' }
  }

  try {
    const inputImage = await extractInputImage(context)
    const creds = parseCfCredentials()

    // Cloudflare direct = satu-satunya yang benar-benar bisa EDIT. Rotasi antar
    // akun (mulai acak) + fallback otomatis kalau satu akun gagal/kena limit.
    // Tanpa kredensial CF, jatuh ke 9router (generate saja).
    let buffer: Buffer
    let provider = '9router'
    if (creds.length > 0) {
      provider = 'cloudflare'
      const start = creds.length > 1 ? Math.floor(Math.random() * creds.length) : 0
      const rotated = [...creds.slice(start), ...creds.slice(0, start)]
      const errors: string[] = []
      let generated: Buffer | null = null
      for (const cred of rotated) {
        try {
          generated = await generateWithCloudflare(prompt, inputImage, cred)
          break
        } catch (e: any) {
          errors.push(e.message)
        }
      }
      if (!generated) throw new Error(`Semua akun Cloudflare gagal: ${errors.slice(0, 3).join(' | ')}`)
      buffer = generated
    } else {
      buffer = await generateImage(prompt, inputImage)
    }

    const outPath = join(tmpdir(), `img_${Date.now()}${provider === 'cloudflare' ? '.jpg' : '.png'}`)
    await writeFile(outPath, buffer)

    logger.info({ bytes: buffer.length, mode: inputImage ? 'edit' : 'generate', provider, accounts: creds.length }, 'Image generated/edited')

    return {
      success: true,
      text: inputImage ? '✅ Gambar berhasil diedit!' : '✅ Gambar berhasil dibuat!',
      filePath: outPath,
      fileType: 'image',
    }
  } catch (err: any) {
    logger.error({ err }, 'img-gen failed')
    return { success: false, error: `Gagal generate gambar: ${err.message}` }
  }
}

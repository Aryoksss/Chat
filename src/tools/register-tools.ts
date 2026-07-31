import { toolsRegistry } from './registry.js'
import { handleSticker } from './handlers/sticker.js'
import { handleYtDownload } from './handlers/yt-dl.js'
import { handleIgDownload } from './handlers/ig-dl.js'
import { handleTtDownload } from './handlers/tt-dl.js'
import { handleTwDownload } from './handlers/tw-dl.js'
import { handleBrainly } from './handlers/brainly.js'
import { handleQrGenerate } from './handlers/qr.js'
import { handleTranslate } from './handlers/translate.js'
import { handleShortlink } from './handlers/shortlink.js'
import { handleWeather } from './handlers/weather.js'
import { handleAnimeSearch } from './handlers/anime.js'

export function registerAllTools() {
  const defs = [
    { name: 'sticker', desc: 'Bikin sticker dari gambar', params: { imageType: { type: 'string' } } },
    { name: 'yt-dl', desc: 'Download YouTube', params: { url: { type: 'string' }, format: { type: 'string' } } },
    { name: 'ig-dl', desc: 'Download Instagram', params: { url: { type: 'string' } } },
    { name: 'tt-dl', desc: 'Download TikTok', params: { url: { type: 'string' } } },
    { name: 'tw-dl', desc: 'Download Twitter/X', params: { url: { type: 'string' } } },
    { name: 'brainly', desc: 'Cari jawaban Brainly', params: { query: { type: 'string' } } },
    { name: 'qr', desc: 'Bikin QR code', params: { text: { type: 'string' } } },
    { name: 'translate', desc: 'Translate teks', params: { text: { type: 'string' }, to: { type: 'string' } } },
    { name: 'shortlink', desc: 'Pendekin URL', params: { url: { type: 'string' } } },
    { name: 'weather', desc: 'Cek cuaca', params: { city: { type: 'string' } } },
    { name: 'anime', desc: 'Cari anime', params: { query: { type: 'string' } } },
  ]
  const handlers = [handleSticker, handleYtDownload, handleIgDownload, handleTtDownload,
    handleTwDownload, handleBrainly, handleQrGenerate, handleTranslate,
    handleShortlink, handleWeather, handleAnimeSearch]

  defs.forEach((t, i) => toolsRegistry.register(
    { name: t.name, description: t.desc, parameters: { type: 'object', properties: t.params } },
    handlers[i] as any
  ))
  console.log(`✅ ${defs.length} tools registered: ${defs.map(d => d.name).join(', ')}`)
}
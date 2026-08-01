// ============================================================
// Tool: Weather — cek cuaca kota
// ============================================================

import { logger } from '../../system/logger.js'

interface WeatherArgs {
  city: string
}

export async function handleWeather(args: WeatherArgs): Promise<{ success: boolean; text?: string; error?: string }> {
  const { city } = args

  if (!city || city.trim().length === 0) {
    return { success: false, text: 'Mau cek cuaca kota apa? Kasih nama kotanya kak!' }
  }

  try {
    // Use wttr.in JSON format for stable multi-word parsing
    const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
      signal: AbortSignal.timeout(12000),
    })
    if (!response.ok) throw new Error(`wttr.in responded ${response.status}`)
    const data = await response.json() as any
    const current = data?.current_condition?.[0]

    if (current) {
      const condition = current.weatherDesc?.[0]?.value || '?'
      const temp = current.temp_C ? `${current.temp_C}°C` : '?'
      const humidity = current.humidity ? `Kelembaban: ${current.humidity}%` : ''
      const wind = current.windspeedKmph ? `Angin: ${current.windspeedKmph} km/jam` : ''
      const rainProb = current.chanceofrain ? `Hujan: ${current.chanceofrain}%` : ''

      return {
        success: true,
        text: `🌤 *Cuaca ${city}*\n\nKondisi: ${condition}\nSuhu: ${temp}\n${humidity}\n${wind}\n${rainProb}`.replace(/\n+/g, '\n'),
      }
    }

    // Fallback: Open-Meteo API (free, no key needed)
    const geoResp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, {
      signal: AbortSignal.timeout(12000),
    })
    const geoData = await geoResp.json() as any

    if (geoData?.results?.[0]) {
      const { latitude, longitude, name } = geoData.results[0]
      const weatherResp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`,
        { signal: AbortSignal.timeout(12000) }
      )
      const weatherData = await weatherResp.json() as any

      if (weatherData?.current_weather) {
        const w = weatherData.current_weather
        return {
          success: true,
          text: `🌤 *Cuaca ${name}*\n\nSuhu: ${w.temperature}°C\nAngin: ${w.windspeed} km/jam\nKondisi: ${w.weathercode || 'Cerah'}`,
        }
      }
    }

    return { success: false, text: `Gak nemu kota "${city}". Coba periksa ejaannya kak!` }
  } catch (err: any) {
    logger.error({ err }, 'weather failed')
    return { success: false, error: `Gagal cek cuaca: ${err.message}` }
  }
}

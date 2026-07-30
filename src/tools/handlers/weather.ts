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
    // Using wttr.in — free, no API key needed
    const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=%C+%t+%h+%w+%p`)
    const text = await response.text()

    if (text && !text.includes('Unknown location')) {
      const parts = text.trim().split(/\s+/)
      const condition = parts[0] || '?'
      const temp = parts[1] || '?°C'
      const humidity = parts[2] ? `Kelembaban: ${parts[2]}` : ''
      const wind = parts[3] ? `Angin: ${parts[3]}` : ''

      return {
        success: true,
        text: `🌤 *Cuaca ${city}*\n\nKondisi: ${condition}\nSuhu: ${temp}\n${humidity}${humidity && wind ? '\n' : ''}${wind}`,
      }
    }

    // Fallback: Open-Meteo API (free, no key needed)
    const geoResp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`)
    const geoData = await geoResp.json() as any

    if (geoData?.results?.[0]) {
      const { latitude, longitude, name } = geoData.results[0]
      const weatherResp = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`
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

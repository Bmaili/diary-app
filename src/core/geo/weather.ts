/**
 * 实时天气（规格 5.3）。和风天气需要控制台分配的专属 API Host 和 key；没填就用免 key 的 Open-Meteo。
 */
import { http } from '../http'
import type { Weather } from '../types'

export interface QWeatherConfig {
  host: string
  key: string
}

export async function qweatherNow(cfg: QWeatherConfig, lat: number, lng: number): Promise<Weather> {
  const host = cfg.host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const res = await http({
    url: `https://${host}/v7/weather/now?location=${lng.toFixed(2)},${lat.toFixed(2)}&lang=zh`,
    headers: { 'X-QW-Api-Key': cfg.key },
    timeoutMs: 10000,
  })
  if (!res.ok) throw new Error(`和风天气返回 ${res.status}`)
  const d = res.json<{ code: string; now?: { temp: string; text: string } }>()
  if (d.code !== '200' || !d.now) throw new Error(`和风天气返回错误码 ${d.code}`)
  return { text: d.now.text, temp_c: Math.round(Number(d.now.temp)) }
}

/** WMO 天气代码 → 中文 */
export function wmoText(code: number): string {
  if (code === 0) return '晴'
  if (code === 1) return '晴间多云'
  if (code === 2) return '多云'
  if (code === 3) return '阴'
  if (code === 45 || code === 48) return '雾'
  if (code >= 51 && code <= 57) return '毛毛雨'
  if (code === 61 || code === 80) return '小雨'
  if (code === 63 || code === 81) return '中雨'
  if (code === 65 || code === 82) return '大雨'
  if (code === 66 || code === 67) return '冻雨'
  if (code === 71 || code === 85) return '小雪'
  if (code === 73) return '中雪'
  if (code === 75 || code === 86) return '大雪'
  if (code === 77) return '雪粒'
  if (code === 95) return '雷阵雨'
  if (code === 96 || code === 99) return '雷阵雨伴有冰雹'
  return '未知'
}

export async function openMeteoNow(lat: number, lng: number): Promise<Weather> {
  const res = await http({
    url: `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&current=temperature_2m,weather_code&timezone=auto`,
    timeoutMs: 10000,
  })
  if (!res.ok) throw new Error(`Open-Meteo 返回 ${res.status}`)
  const d = res.json<{ current?: { temperature_2m: number; weather_code: number } }>()
  if (!d.current) throw new Error('Open-Meteo 没有返回实时天气')
  return { text: wmoText(d.current.weather_code), temp_c: Math.round(d.current.temperature_2m) }
}

/** 城市名 → 坐标（没有高德 key 时设置默认城市用） */
export async function openMeteoGeocode(name: string): Promise<{ lat: number; lng: number; name: string } | null> {
  const res = await http({
    url: `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh`,
    timeoutMs: 10000,
  })
  if (!res.ok) return null
  const d = res.json<{ results?: { latitude: number; longitude: number; name: string; admin1?: string }[] }>()
  const r = d.results?.[0]
  return r ? { lat: r.latitude, lng: r.longitude, name: [r.admin1, r.name].filter(Boolean).join(' ') } : null
}

/**
 * 位置与天气（规格 5.3、5.4）。
 * 定位用 WebView 自带的 navigator.geolocation：它走系统的定位服务，不依赖谷歌服务，国产手机可用，返回 WGS-84。
 * 只在前台、写当天日记时定位，不申请后台定位。
 */
import { prefs } from './prefs'
import { getSecret } from './platform/secrets'
import { nearby, reverseGeocode, searchPlaces, geocode, type Poi } from './core/geo/amap'
import { openMeteoGeocode, openMeteoNow, qweatherNow } from './core/geo/weather'
import { outOfChina, round6 } from './core/geo/coords'
import type { EntryMeta, Location, Weather } from './core/types'

export interface Position { lat: number; lng: number; accuracy: number }

function locate(high: boolean, timeoutMs: number): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('这台设备不支持定位'))
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: round6(p.coords.latitude), lng: round6(p.coords.longitude), accuracy: p.coords.accuracy }),
      (e) => reject(Object.assign(new Error(e.code === 1 ? '没有定位权限' : e.code === 3 ? '定位超时' : '定位失败'), { code: e.code })),
      { enableHighAccuracy: high, timeout: timeoutMs, maximumAge: 5 * 60 * 1000 },
    )
  })
}

/**
 * 先用 GPS 精确定位；室内常常收不到 GPS 而超时，这时退回网络定位（基站、Wi‑Fi，精度几十米，够选附近地点）。
 */
export async function getPosition(timeoutMs = 10000): Promise<Position> {
  try {
    return await locate(true, timeoutMs)
  } catch (e) {
    if ((e as { code?: number }).code === 1) throw e
    return locate(false, timeoutMs)
  }
}

export async function amapKey(): Promise<string> {
  return getSecret('amap.key')
}

export async function fetchWeather(lat: number, lng: number): Promise<Weather> {
  const p = prefs.place
  if (p.weatherProvider !== 'openmeteo') {
    const key = await getSecret('qweather.key')
    if (p.qweatherHost && key) {
      try {
        return await qweatherNow({ host: p.qweatherHost, key }, lat, lng)
      } catch (e) {
        if (p.weatherProvider === 'qweather') throw e
      }
    } else if (p.weatherProvider === 'qweather') throw new Error('还没有填和风天气的 API Host 和 key')
  }
  return openMeteoNow(lat, lng)
}

export interface AutoFillResult {
  location?: Location
  weather?: Weather
  errors: string[]
}

/**
 * 当天第一次打开编辑页时调用：没有位置就定位并填地址，没有天气就按位置（或默认城市）取天气。
 * 任何一步失败都只记录原因，不影响写作。
 */
export async function autoFill(meta: EntryMeta, opts: { skipLocation: boolean }): Promise<AutoFillResult> {
  const out: AutoFillResult = { errors: [] }
  if (!prefs.place.autoLocate) return out
  let pos: Position | null = null
  const needLocation = !meta.location && !opts.skipLocation
  if (needLocation || !meta.weather) {
    try {
      pos = await getPosition()
    } catch (e) {
      out.errors.push((e as Error).message)
    }
  }
  if (needLocation && pos) {
    const loc: Location = { lat: pos.lat, lng: pos.lng, crs: 'wgs84' }
    const key = await amapKey()
    if (key && !outOfChina(pos.lat, pos.lng)) {
      try {
        const r = await reverseGeocode(key, pos.lat, pos.lng)
        if (r.address) loc.address = r.address
      } catch (e) {
        out.errors.push((e as Error).message)
      }
    }
    out.location = loc
  }
  if (!meta.weather) {
    const at = pos ?? prefs.place.defaultCity
    if (at) {
      try {
        out.weather = await fetchWeather(at.lat, at.lng)
      } catch (e) {
        out.errors.push((e as Error).message)
      }
    }
  }
  return out
}

export async function nearbyPlaces(pos: { lat: number; lng: number }, keywords?: string): Promise<Poi[]> {
  const key = await amapKey()
  if (!key) throw new Error('还没有填高德 Web 服务 key，只能记录坐标')
  return nearby(key, pos.lat, pos.lng, { radius: keywords ? 3000 : 300, keywords })
}

export async function findPlaces(keywords: string): Promise<Poi[]> {
  const key = await amapKey()
  if (!key) throw new Error('还没有填高德 Web 服务 key')
  return searchPlaces(key, keywords, prefs.place.defaultCity?.name ?? '')
}

export async function resolveCity(name: string): Promise<{ lat: number; lng: number; name: string } | null> {
  const key = await amapKey()
  if (key) {
    try {
      const r = await geocode(key, name)
      if (r) return r
    } catch { /* 改用 Open-Meteo */ }
  }
  return openMeteoGeocode(name)
}

export function poiToLocation(p: Poi): Location {
  return { name: p.name, address: p.address || undefined, lat: p.lat, lng: p.lng, crs: 'wgs84', amap_poi_id: p.id || undefined }
}

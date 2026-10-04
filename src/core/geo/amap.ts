/**
 * 高德 Web 服务 API（规格 5.4）：逆地理编码、周边搜索、关键词搜索、地址解析。
 * 只需要一个“Web 服务”类型的 key，不需要高德 Android SDK。
 * 输入输出的坐标都是 WGS-84，内部与高德的 GCJ-02 互转。
 */
import { http } from '../http'
import { gcj02ToWgs84, round6, wgs84ToGcj02 } from './coords'

const BASE = 'https://restapi.amap.com/v3'

export interface Poi {
  id: string
  name: string
  address: string
  type: string
  lat: number
  lng: number
  /** 米 */
  distance: number | null
}

export class AmapError extends Error {}

const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.join('') : '')

async function get<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString()
  let res
  try {
    res = await http({ url: `${BASE}${path}?${qs}`, timeoutMs: 10000 })
  } catch (e) {
    throw new AmapError((e as Error).message)
  }
  if (!res.ok) throw new AmapError(`高德返回 ${res.status}`)
  const data = res.json<{ status: string; info: string; infocode: string } & T>()
  if (data.status !== '1') {
    const hint: Record<string, string> = { INVALID_USER_KEY: 'key 不对', USERKEY_PLAT_NOMATCH: 'key 的类型不对，需要“Web 服务”类型', DAILY_QUERY_OVER_LIMIT: '今天的免费额度用完了' }
    throw new AmapError(`高德：${hint[data.info] ?? data.info}`)
  }
  return data
}

function toPoi(p: Record<string, unknown>): Poi | null {
  const loc = str(p.location).split(',').map(Number)
  if (loc.length !== 2 || loc.some(Number.isNaN)) return null
  const w = gcj02ToWgs84(loc[1], loc[0])
  return {
    id: str(p.id),
    name: str(p.name),
    address: str(p.address),
    type: str(p.type).split(';')[0] ?? '',
    lat: round6(w.lat),
    lng: round6(w.lng),
    distance: p.distance != null && str(p.distance) !== '' ? Number(p.distance) : null,
  }
}

const gcjParam = (lat: number, lng: number) => {
  const g = wgs84ToGcj02(lat, lng)
  return `${g.lng.toFixed(6)},${g.lat.toFixed(6)}`
}

/** 逆地理编码：坐标 → 地址 */
export async function reverseGeocode(key: string, lat: number, lng: number): Promise<{ address: string; city: string; district: string }> {
  const d = await get<{ regeocode: { formatted_address: unknown; addressComponent: Record<string, unknown> } }>('/geocode/regeo', {
    key, location: gcjParam(lat, lng),
  })
  const c = d.regeocode.addressComponent ?? {}
  return {
    address: str(d.regeocode.formatted_address),
    city: str(c.city) || str(c.province),
    district: str(c.district),
  }
}

/** 周边搜索，按距离排序；有关键词时在周边按关键词找 */
export async function nearby(key: string, lat: number, lng: number, opts: { radius?: number; keywords?: string } = {}): Promise<Poi[]> {
  const d = await get<{ pois: Record<string, unknown>[] }>('/place/around', {
    key,
    location: gcjParam(lat, lng),
    radius: String(opts.radius ?? 300),
    sortrule: 'distance',
    offset: '25',
    page: '1',
    extensions: 'base',
    ...(opts.keywords ? { keywords: opts.keywords } : {}),
  })
  return (d.pois ?? []).map(toPoi).filter((p): p is Poi => !!p)
}

/** 关键词搜索（补写往日日记时没有定位，用这个手动找地点） */
export async function searchPlaces(key: string, keywords: string, city = ''): Promise<Poi[]> {
  const d = await get<{ pois: Record<string, unknown>[] }>('/place/text', {
    key, keywords, city, offset: '25', page: '1', extensions: 'base',
  })
  return (d.pois ?? []).map(toPoi).filter((p): p is Poi => !!p)
}

/** 地址或城市名 → 坐标（设置默认城市用） */
export async function geocode(key: string, address: string): Promise<{ lat: number; lng: number; name: string } | null> {
  const d = await get<{ geocodes: Record<string, unknown>[] }>('/geocode/geo', { key, address })
  const g = d.geocodes?.[0]
  if (!g) return null
  const loc = str(g.location).split(',').map(Number)
  const w = gcj02ToWgs84(loc[1], loc[0])
  return { lat: round6(w.lat), lng: round6(w.lng), name: str(g.formatted_address) || address }
}

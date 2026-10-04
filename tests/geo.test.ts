import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { distanceM, gcj02ToWgs84, wgs84ToGcj02 } from '../src/core/geo/coords'
import { nearby, reverseGeocode, searchPlaces } from '../src/core/geo/amap'
import { openMeteoNow, qweatherNow, wmoText } from '../src/core/geo/weather'

const require = createRequire(import.meta.url)
const ct = require('coordtransform')

const POINTS = [
  { name: '北京天安门', lat: 39.908692, lng: 116.397477 },
  { name: '广州塔', lat: 23.106383, lng: 113.318977 },
  { name: '上海陆家嘴', lat: 31.239703, lng: 121.499718 },
  { name: '拉萨', lat: 29.652491, lng: 91.172112 },
  { name: '哈尔滨', lat: 45.803775, lng: 126.534967 },
]

describe('坐标转换（验收：GCJ-02 与 WGS-84 互转误差小于 1 米）', () => {
  it.each(POINTS)('$name', (p) => {
    const g = wgs84ToGcj02(p.lat, p.lng)
    // 与广泛使用的 coordtransform 库的正向结果一致
    const [refLng, refLat] = ct.wgs84togcj02(p.lng, p.lat)
    expect(distanceM(g, { lat: refLat, lng: refLng })).toBeLessThan(0.01)
    // GCJ 偏移在国内一般为几百米
    expect(distanceM(g, p)).toBeGreaterThan(50)
    // 反向迭代回到原点
    const back = gcj02ToWgs84(g.lat, g.lng)
    expect(distanceM(back, p)).toBeLessThan(1)
  })
  it('境外坐标不偏移（新加坡、东京、台北、河内）', () => {
    for (const [lat, lng] of [[1.3521, 103.8198], [35.6762, 139.6503], [25.033, 121.5654], [21.0278, 105.8342]]) {
      expect(wgs84ToGcj02(lat, lng)).toEqual({ lat, lng })
    }
  })
})

describe('高德与天气接口解析', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stub = (handler: (url: string, init?: RequestInit) => unknown) => {
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(handler(url, init)), { headers: { 'Content-Type': 'application/json' } })
    })
    return calls
  }

  it('周边搜索：请求用 GCJ-02 坐标，返回结果转回 WGS-84', async () => {
    const p = POINTS[1]
    const g = wgs84ToGcj02(p.lat, p.lng)
    const calls = stub(() => ({
      status: '1', info: 'OK', infocode: '10000',
      pois: [
        { id: 'B001', name: '广州塔', address: '阅江西路222号', type: '风景名胜;风景名胜', location: `${g.lng.toFixed(6)},${g.lat.toFixed(6)}`, distance: '12' },
        { id: 'B002', name: '某某餐厅', address: [], type: '餐饮服务;中餐厅', location: '113.320000,23.105000', distance: '150' },
      ],
    }))
    const pois = await nearby('KEY', p.lat, p.lng)
    const q = new URL(calls[0].url).searchParams
    expect(q.get('location')).toBe(`${g.lng.toFixed(6)},${g.lat.toFixed(6)}`)
    expect(q.get('radius')).toBe('300')
    expect(q.get('sortrule')).toBe('distance')
    expect(pois[0].name).toBe('广州塔')
    expect(distanceM(pois[0], p)).toBeLessThan(1)
    expect(pois[1].address).toBe('')
    expect(pois[1].type).toBe('餐饮服务')
  })

  it('逆地理编码与错误提示', async () => {
    stub(() => ({ status: '1', info: 'OK', infocode: '10000', regeocode: { formatted_address: '广东省广州市海珠区阅江西路', addressComponent: { city: '广州市', district: '海珠区', province: '广东省' } } }))
    expect(await reverseGeocode('K', 23.1, 113.3)).toEqual({ address: '广东省广州市海珠区阅江西路', city: '广州市', district: '海珠区' })
    stub(() => ({ status: '0', info: 'USERKEY_PLAT_NOMATCH', infocode: '10009' }))
    await expect(searchPlaces('K', '咖啡')).rejects.toThrow(/Web 服务/)
  })

  it('和风天气：专属 Host、请求头带 key、经纬度保留两位小数', async () => {
    const calls = stub(() => ({ code: '200', now: { temp: '28', text: '晴' } }))
    expect(await qweatherNow({ host: 'https://abc123.re.qweatherapi.com/', key: 'QK' }, 23.106383, 113.318977)).toEqual({ text: '晴', temp_c: 28 })
    expect(calls[0].url).toBe('https://abc123.re.qweatherapi.com/v7/weather/now?location=113.32,23.11&lang=zh')
    expect((calls[0].init!.headers as Record<string, string>)['X-QW-Api-Key']).toBe('QK')
  })

  it('Open-Meteo 天气代码转中文', async () => {
    stub(() => ({ current: { temperature_2m: 17.6, weather_code: 61 } }))
    expect(await openMeteoNow(23.1, 113.3)).toEqual({ text: '小雨', temp_c: 18 })
    expect(wmoText(95)).toBe('雷阵雨')
  })
})

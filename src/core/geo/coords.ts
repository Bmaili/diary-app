/**
 * WGS-84 与 GCJ-02 互转（规格 4.3：文件里一律存 WGS-84；高德接口用 GCJ-02）。
 * 正向用公开的标准算法；反向用迭代逼近，误差远小于 1 米。中国境外两者相同。
 */
const A = 6378245.0
const EE = 0.00669342162296594323

// 中国大陆的近似范围：若干矩形的并集减去台湾、越南北部、俄罗斯远东等区域。[北, 西, 南, 东]
// 只用一个大矩形会把新加坡、东南亚也当成国内，导致坐标被错误偏移。
const INSIDE = [
  [49.2204, 79.4462, 42.8899, 96.33],
  [54.1415, 109.6872, 39.3742, 135.0002],
  [42.8899, 73.1246, 29.5297, 124.143255],
  [29.5297, 82.9684, 26.7186, 97.0352],
  [29.5297, 97.0253, 20.414096, 124.367395],
  [20.414096, 107.975793, 17.871542, 111.744104],
]
const OUTSIDE = [
  [25.398623, 119.921265, 21.785006, 122.497559],
  [22.284, 101.8652, 20.0988, 106.665],
  [21.5422, 106.4525, 20.4878, 108.051],
  [55.8175, 109.0323, 50.3257, 119.127],
  [55.8175, 127.4568, 49.5574, 137.0227],
  [44.8922, 131.2662, 42.5692, 137.0227],
]
const inRect = (lat: number, lng: number, r: number[]) => lat <= r[0] && lng >= r[1] && lat >= r[2] && lng <= r[3]

export function outOfChina(lat: number, lng: number): boolean {
  if (!INSIDE.some((r) => inRect(lat, lng, r))) return true
  return OUTSIDE.some((r) => inRect(lat, lng, r))
}

function tLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return r
}

function tLng(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return r
}

export function wgs84ToGcj02(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  let dLat = tLat(lng - 105, lat - 35)
  let dLng = tLng(lng - 105, lat - 35)
  const radLat = (lat / 180) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI)
  dLng = (dLng * 180) / ((A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return { lat: lat + dLat, lng: lng + dLng }
}

export function gcj02ToWgs84(lat: number, lng: number): { lat: number; lng: number } {
  if (outOfChina(lat, lng)) return { lat, lng }
  let wLat = lat
  let wLng = lng
  for (let i = 0; i < 20; i++) {
    const g = wgs84ToGcj02(wLat, wLng)
    const dLat = g.lat - lat
    const dLng = g.lng - lng
    wLat -= dLat
    wLng -= dLng
    if (Math.abs(dLat) < 1e-10 && Math.abs(dLng) < 1e-10) break
  }
  return { lat: wLat, lng: wLng }
}

/** 两点距离（米），球面近似 */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** 写入文件时保留 6 位小数（约 0.1 米） */
export const round6 = (x: number) => Math.round(x * 1e6) / 1e6

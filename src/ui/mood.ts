/** 心情档位的文字与颜色（中国传统色：玄青、黛、缃、竹青、胭脂）。颜色与 style.css 中的 --m1…--m5 一致，供需要连续插值的地方使用。 */
export const MOOD_LABELS = ['很差', '不好', '一般', '不错', '很好'] as const

/** 心情对应的传统色名 */
export const MOOD_COLORS = ['玄青', '黛', '缃', '竹青', '胭脂'] as const

export function moodLabel(v?: number | null): string {
  return v ? MOOD_LABELS[v - 1] : '没记'
}

const LIGHT = ['#3e3c52', '#5c6b7a', '#e0b54e', '#6e8b5a', '#a8343e']
const DARK = ['#7a7896', '#8094a6', '#e3be5e', '#8daa77', '#cf5560']

function isDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 连续心情值对应的 RGB */
export function moodRgb(v: number): [number, number, number] {
  const ramp = isDark() ? DARK : LIGHT
  const x = Math.min(5, Math.max(1, v)) - 1
  const i = Math.min(3, Math.floor(x))
  const t = x - i
  const a = hexToRgb(ramp[i])
  const b = hexToRgb(ramp[i + 1])
  return a.map((ai, k) => Math.round(ai + (b[k] - ai) * t)) as [number, number, number]
}

/** 这个颜色上面写字、画五官用深色还是浅色 */
export function inkOn(v: number): string {
  const [r, g, b] = moodRgb(v)
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#2a2724' : '#f6f1e6'
}

/** 连续心情值（1–5 之间的小数）对应的颜色，拖动时用 */
export function moodColor(v: number): string {
  const ramp = isDark() ? DARK : LIGHT
  const x = Math.min(5, Math.max(1, v)) - 1
  const i = Math.min(3, Math.floor(x))
  const t = x - i
  const a = hexToRgb(ramp[i])
  const b = hexToRgb(ramp[i + 1])
  const c = a.map((ai, k) => Math.round(ai + (b[k] - ai) * t))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/** 心情档位的文字与颜色（恒星光谱色）。颜色与 style.css 中的 --m1…--m5 一致，供需要连续插值的地方使用。 */
export const MOOD_LABELS = ['很差', '不好', '一般', '不错', '很好'] as const

/** 心情对应的恒星光谱型：越热越蓝，“一般”是和太阳一样的 G 型 */
export const SPECTRAL = ['M', 'K', 'G', 'F', 'B'] as const

export function moodLabel(v?: number | null): string {
  return v ? MOOD_LABELS[v - 1] : '没记'
}

const LIGHT = ['#e0603f', '#ef9440', '#e8c04a', '#93bdea', '#5b8def']
const DARK = ['#ff7a59', '#ffa65e', '#ffd96a', '#cfe0ff', '#86abff']

function isDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
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

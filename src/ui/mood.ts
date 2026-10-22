/**
 * 心情档位的文字与颜色。默认是中国传统色，从冷暗到暖亮：玄青、黛蓝、天青、竹青、杏黄；
 * 设置里可以换（2026-10-22 起，core/moodPalette.ts，ui/moodTheme.ts 负责写进样式）。
 * 这里的颜色与 style.css 中的 --m1…--m5 一致，供需要连续插值的地方使用；palette 是响应式的，换了配色会跟着重画。
 */
import { shallowRef } from 'vue'
import { hexToRgb, inkFor, resolvePalette, type Resolved } from '../core/moodPalette'

export const MOOD_LABELS = ['很差', '不好', '一般', '不错', '很好'] as const

/** 默认配色的传统色名 */
export const MOOD_COLORS = ['玄青', '黛蓝', '天青', '竹青', '杏黄'] as const

export function moodLabel(v?: number | null): string {
  return v ? MOOD_LABELS[v - 1] : '没记'
}

/** 现在用的配色（moodTheme.ts 在设置变化时更新） */
export const palette = shallowRef<Resolved>(resolvePalette(undefined))

function isDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** 连续心情值对应的 RGB */
export function moodRgb(v: number): [number, number, number] {
  const p = palette.value
  const ramp = isDark() ? p.dark : p.light
  const x = Math.min(5, Math.max(1, v)) - 1
  const i = Math.min(3, Math.floor(x))
  const t = x - i
  const a = hexToRgb(ramp[i])
  const b = hexToRgb(ramp[i + 1])
  return a.map((ai, k) => Math.round(ai + (b[k] - ai) * t)) as [number, number, number]
}

/** 这个颜色上面写字、画五官用深色还是浅色 */
export function inkOn(v: number): string {
  const rgb = moodRgb(v)
  if (!palette.value.isDefault) return inkFor(rgb, isDark())
  const [r, g, b] = rgb
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#2a2724' : '#f6f1e6'
}

/** 连续心情值（1–5 之间的小数）对应的颜色，拖动时用 */
export function moodColor(v: number): string {
  const c = moodRgb(v)
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

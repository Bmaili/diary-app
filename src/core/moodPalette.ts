/**
 * 心情配色（2026-10-22 加入，规格 6.6）：五档颜色可以在设置里换。
 *
 * - 存的只是浅色下的五个颜色（prefs.ui.moodColors，从“很差”到“很好”）；空数组表示默认。
 * - 深色下的颜色由浅色推出来（提亮一些，免得在夜墨底上看不见）；默认配色用手调过的那一套。
 * - 心情块上的字用深色还是浅色，按对比度自动选；默认配色沿用手调过的。
 * - 只是界面颜色，不写进日记文件。
 */

export type Hex = string

export interface MoodPreset {
  id: string
  name: string
  desc: string
  colors: Hex[]
}

/** 默认：玄青、黛蓝、天青、竹青、杏黄（从冷暗到暖亮） */
export const DEFAULT_LIGHT: Hex[] = ['#3b3d4f', '#5b6d80', '#93b1ae', '#6f9460', '#e3a33b']
export const DEFAULT_DARK: Hex[] = ['#6c6b86', '#7e93a8', '#9fbdb9', '#8db27a', '#eab055']
/** 默认配色心情块上的字色（与 style.css 的 .mood-N 一致） */
const DEFAULT_ON_LIGHT: Hex[] = ['#f6f1e6', '#f6f1e6', '#2a2724', '#f6f1e6', '#2a2724']
const DEFAULT_ON_DARK: Hex[] = ['#f6f1e6', '#1a1a1c', '#1a1a1c', '#1a1a1c', '#1a1a1c']

const INK_LIGHT = '#2a2724'
const INK_DARK = '#1a1a1c'
const MOON = '#f6f1e6'

export const PRESETS: MoodPreset[] = [
  { id: 'qingdai', name: '青黛', desc: '从玄青到杏黄，冷暗到暖亮（默认）', colors: DEFAULT_LIGHT },
  { id: 'zhujin', name: '朱金', desc: '不错是缃黄，很好是朱红，喜气洋洋', colors: ['#424c50', '#75878a', '#93b1ae', '#e0b12a', '#d6452f'] },
  { id: 'shanshui', name: '青绿山水', desc: '黛紫、靛青、石青、石绿、柳黄', colors: ['#4a4266', '#3d5f7a', '#5d8fa8', '#4f9a7c', '#c2b53c'] },
  { id: 'taoyao', name: '桃夭', desc: '青灰、藕荷、丁香、桃红、海棠', colors: ['#5a6470', '#9a8aa8', '#c3a6cb', '#e98b9c', '#d9536a'] },
  { id: 'mo', name: '墨分五色', desc: '焦、浓、重、淡、清，只用墨色', colors: ['#2b2a29', '#4f4b47', '#77726b', '#9e978c', '#c2b9a8'] },
]

/** 单独挑一档时的传统色板（太浅的不收：在宣纸底上看不清） */
export const SWATCHES: { name: string; hex: Hex }[] = [
  { name: '玄青', hex: '#3b3d4f' }, { name: '鸦青', hex: '#424c50' }, { name: '黛', hex: '#4a4266' }, { name: '墨灰', hex: '#5a5653' },
  { name: '黛蓝', hex: '#5b6d80' }, { name: '靛青', hex: '#3d5f7a' }, { name: '群青', hex: '#4c6cb3' }, { name: '石青', hex: '#5d8fa8' },
  { name: '苍色', hex: '#75878a' }, { name: '蟹壳青', hex: '#8a9a96' }, { name: '天青', hex: '#93b1ae' }, { name: '碧色', hex: '#57a88a' },
  { name: '石绿', hex: '#4f9a7c' }, { name: '竹青', hex: '#6f9460' }, { name: '豆绿', hex: '#8eae6a' }, { name: '松花', hex: '#b5c75a' },
  { name: '柳黄', hex: '#c2b53c' }, { name: '缃色', hex: '#e0b12a' }, { name: '杏黄', hex: '#e3a33b' }, { name: '橘黄', hex: '#e8892f' },
  { name: '姜黄', hex: '#d1a33c' }, { name: '檀色', hex: '#b0705a' }, { name: '赭石', hex: '#9a5b3c' }, { name: '朱红', hex: '#d6452f' },
  { name: '海棠红', hex: '#d9536a' }, { name: '胭脂', hex: '#9d2933' }, { name: '桃红', hex: '#e98b9c' }, { name: '藕荷', hex: '#9a8aa8' },
  { name: '丁香', hex: '#c3a6cb' }, { name: '绛紫', hex: '#7a4a6b' },
]

const HEX_RE = /^#[0-9a-f]{6}$/i

/** 设置里存的是不是一组能用的颜色 */
export function validColors(c: unknown): c is Hex[] {
  return Array.isArray(c) && c.length === 5 && c.every((x) => typeof x === 'string' && HEX_RE.test(x))
}

export function isDefault(c: Hex[] | undefined): boolean {
  return !validColors(c) || c.every((x, i) => x.toLowerCase() === DEFAULT_LIGHT[i])
}

/** 和哪套预设一样；都不一样返回 null（自己调过） */
export function presetOf(c: Hex[] | undefined): MoodPreset | null {
  const cur = validColors(c) ? c.map((x) => x.toLowerCase()) : DEFAULT_LIGHT
  return PRESETS.find((p) => p.colors.every((x, i) => x.toLowerCase() === cur[i])) ?? null
}

export function swatchName(hex: Hex): string | null {
  return SWATCHES.find((s) => s.hex.toLowerCase() === hex.toLowerCase())?.name ?? null
}

export function hexToRgb(h: Hex): [number, number, number] {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]: number[]): Hex {
  return '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')
}

function rgbToHsl([r, g, b]: number[]): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  h /= 6
  return [h, s, l]
}

function hslToRgb([h, s, l]: number[]): number[] {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]
}

/** 深色下的颜色：亮度往 0.72 拉近一些（暗的提得多，亮的几乎不动），饱和度略降，免得在夜墨底上刺眼或看不见 */
export function darkVariant(hex: Hex): Hex {
  const [h, s, l] = rgbToHsl(hexToRgb(hex))
  const l2 = l < 0.72 ? l + (0.72 - l) * 0.45 : l
  return rgbToHex(hslToRgb([h, s * 0.92, l2]))
}

/** WCAG 相对亮度 */
function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: number[], b: number[]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** 这个颜色上写字用深色还是浅色：取对比度高的那个 */
export function inkFor(rgb: number[], dark: boolean): Hex {
  const deep = dark ? INK_DARK : INK_LIGHT
  return contrast(rgb, hexToRgb(deep)) >= contrast(rgb, hexToRgb(MOON)) ? deep : MOON
}

export interface Resolved {
  light: Hex[]
  dark: Hex[]
  onLight: Hex[]
  onDark: Hex[]
  /** 是默认配色（不用额外写样式） */
  isDefault: boolean
}

export function resolvePalette(colors: Hex[] | undefined): Resolved {
  if (isDefault(colors)) {
    return { light: DEFAULT_LIGHT, dark: DEFAULT_DARK, onLight: DEFAULT_ON_LIGHT, onDark: DEFAULT_ON_DARK, isDefault: true }
  }
  const light = colors!.map((c) => c.toLowerCase())
  const dark = light.map(darkVariant)
  return {
    light,
    dark,
    onLight: light.map((c) => inkFor(hexToRgb(c), false)),
    onDark: dark.map((c) => inkFor(hexToRgb(c), true)),
    isDefault: false,
  }
}

/** 覆盖 style.css 里心情色的样式表；默认配色返回空串 */
export function paletteCss(p: Resolved): string {
  if (p.isDefault) return ''
  const block = (cs: Hex[], on: Hex[]) => cs.map((c, i) => `--m${i + 1}: ${c}; --onm${i + 1}: ${on[i]};`).join(' ')
  return `:root { ${block(p.light, p.onLight)} }\n@media (prefers-color-scheme: dark) { :root { ${block(p.dark, p.onDark)} } }\n`
}

/** 相邻两档颜色太像（日历上分不出来）：返回这样的档位对（从 1 数） */
export function tooClose(colors: Hex[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) {
      const a = hexToRgb(colors[i]), b = hexToRgb(colors[j])
      const d = Math.hypot(a[0] - b[0], (a[1] - b[1]) * 1.2, a[2] - b[2])
      if (d < 28) out.push([i + 1, j + 1])
    }
  }
  return out
}

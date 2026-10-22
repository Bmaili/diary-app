import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DARK, DEFAULT_LIGHT, PRESETS, SWATCHES, darkVariant, hexToRgb, inkFor, isDefault, paletteCss, presetOf, resolvePalette, tooClose, validColors,
} from '../src/core/moodPalette'
import { buildYearbook } from '../src/core/yearbook'

const lum = (h: string) => {
  const [r, g, b] = hexToRgb(h)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

describe('心情配色', () => {
  it('空数组、不合法的值都当默认', () => {
    expect(isDefault([])).toBe(true)
    expect(isDefault(['#fff'])).toBe(true)
    expect(isDefault(undefined)).toBe(true)
    expect(isDefault([...DEFAULT_LIGHT].map((c) => c.toUpperCase()))).toBe(true)
    expect(validColors(['#123456', '#123456', '#123456', '#123456', 'red'])).toBe(false)
  })

  it('默认配色用手调过的深色，不额外写样式', () => {
    const p = resolvePalette([])
    expect(p.dark).toEqual(DEFAULT_DARK)
    expect(paletteCss(p)).toBe('')
  })

  it('认得出是哪套预设，自己调过的返回 null', () => {
    expect(presetOf([])?.id).toBe('qingdai')
    expect(presetOf(PRESETS[1].colors)?.id).toBe('zhujin')
    const mine = [...PRESETS[1].colors]
    mine[0] = '#3b3d4f'
    expect(presetOf(mine)).toBeNull()
  })

  it('至少有一套是不错黄、很好红', () => {
    const zj = PRESETS.find((p) => p.id === 'zhujin')!
    const [r4, g4, b4] = hexToRgb(zj.colors[3])
    const [r5, g5, b5] = hexToRgb(zj.colors[4])
    expect(r4 > b4 + 80 && g4 > b4 + 60).toBe(true)
    expect(r5 > g5 + 80 && r5 > b5 + 80).toBe(true)
  })

  it('预设和色板都是合法颜色，预设五档互相分得开', () => {
    for (const p of PRESETS) {
      expect(validColors(p.colors)).toBe(true)
      expect(tooClose(p.colors)).toEqual([])
    }
    for (const s of SWATCHES) expect(validColors([s.hex, s.hex, s.hex, s.hex, s.hex])).toBe(true)
    expect(new Set(SWATCHES.map((s) => s.hex)).size).toBe(SWATCHES.length)
  })

  it('深色下的颜色不会比浅色暗，很暗的会被明显提亮', () => {
    for (const s of SWATCHES) expect(lum(darkVariant(s.hex))).toBeGreaterThanOrEqual(lum(s.hex) - 1)
    expect(lum(darkVariant('#2b2a29'))).toBeGreaterThan(80)
  })

  it('字色按对比度选', () => {
    expect(inkFor(hexToRgb('#2b2a29'), false)).toBe('#f6f1e6')
    expect(inkFor(hexToRgb('#e0b12a'), false)).toBe('#2a2724')
    expect(inkFor(hexToRgb('#eab055'), true)).toBe('#1a1a1c')
  })

  it('换过的配色写成浅色、深色两份样式', () => {
    const css = paletteCss(resolvePalette(PRESETS[1].colors))
    expect(css).toContain('--m5: #d6452f')
    expect(css).toContain('--onm1: #f6f1e6')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
  })

  it('相邻两档一样时提醒', () => {
    expect(tooClose(['#3b3d4f', '#3b3d4f', '#93b1ae', '#6f9460', '#e3a33b'])).toEqual([[1, 2]])
  })

  it('年度日记本跟着配色', () => {
    const base = { year: '2026', entries: [{ date: '2026-01-02', meta: { date: '2026-01-02', mood: 5 }, html: '<p>a</p>' }], moods: { '2026-01-02': 5 }, photos: false, starredOnly: false, today: '2026-10-22' }
    expect(buildYearbook(base)).toContain('#e3a33b')
    const html = buildYearbook({ ...base, moodColors: PRESETS[1].colors })
    expect(html).toContain('#d6452f')
    expect(buildYearbook(base)).not.toContain('#d6452f')
  })
})

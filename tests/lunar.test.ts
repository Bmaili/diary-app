import { describe, expect, it } from 'vitest'
import { lunarDay, seasonOf } from '../src/core/lunar'
import { POEMS, poemFor } from '../src/core/poems'

describe('农历与节气', () => {
  it('日期换算', () => {
    expect(lunarDay('2026-10-05')).toMatchObject({ month: '八月', day: '廿五', term: '秋分', cell: '廿五', full: '农历八月廿五', year: '丙午马年' })
    expect(lunarDay('2026-09-25')).toMatchObject({ festival: '中秋', cell: '中秋' })
    expect(lunarDay('2026-10-08')).toMatchObject({ jieqi: '寒露', term: '寒露', cell: '寒露' })
    expect(lunarDay('2026-02-17')).toMatchObject({ month: '正月', day: '初一', festival: '春节' })
    expect(lunarDay('2026-10-10').cell).toBe('九月')
  })
  it('法定节假日和调休', () => {
    expect(lunarDay('2026-10-01')).toMatchObject({ holiday: { name: '国庆', off: true, first: true }, cell: '国庆' })
    expect(lunarDay('2026-10-03').holiday).toEqual({ name: '国庆', off: true, first: false })
    expect(lunarDay('2026-10-10').holiday).toEqual({ name: '国庆', off: false, first: false })
    expect(lunarDay('2026-02-14').holiday?.off).toBe(false)
    expect(lunarDay('2026-01-01').cell).toBe('元旦')
    expect(lunarDay('2026-10-12').holiday).toBeUndefined()
  })
  it('按节气分四季', () => {
    expect(seasonOf('立春')).toBe('spring')
    expect(seasonOf('大暑')).toBe('summer')
    expect(seasonOf('寒露')).toBe('autumn')
    expect(seasonOf('大寒')).toBe('winter')
  })
})

describe('每日诗词', () => {
  it('节日、节气当天出对应的诗', () => {
    expect(poemFor('2026-09-25')).toMatchObject({ reason: '今日中秋', poem: { author: '苏轼' } })
    expect(poemFor('2026-10-08')).toMatchObject({ reason: '今日寒露', poem: { text: '袅袅凉风动，凄凄寒露零。' } })
  })
  it('平时同一天固定，换一首会变，且来自当季、当前节气或通用', () => {
    const a = poemFor('2026-10-05')
    expect(poemFor('2026-10-05')).toEqual(a)
    const seen = new Set(Array.from({ length: 6 }, (_, i) => poemFor('2026-10-05', i).poem.text))
    expect(seen.size).toBeGreaterThan(4)
    for (let i = 0; i < 20; i++) {
      const p = poemFor('2026-10-05', i).poem
      expect(p.tags.some((t) => ['autumn', 'any', '秋分'].includes(t))).toBe(true)
    }
  })
  it('二十四节气和七个节日都有诗', () => {
    const terms = ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒', '春节', '元宵', '端午', '七夕', '中秋', '重阳', '除夕']
    for (const t of terms) expect(POEMS.some((p) => p.tags.includes(t)), t).toBe(true)
  })
})

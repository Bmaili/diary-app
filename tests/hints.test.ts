import { describe, expect, it } from 'vitest'
import { allLines, pickHint, slotOf } from '../src/core/hints'
import { reminderText } from '../src/core/reminder'

const NIGHT_ONLY = ['若有月色，就写进来。', '星河在天，灯下落笔。', '举头望月之前，先低头写几行。', '秋夜月明，写一句。', '冬夜长，慢慢写。', '今天记下了，安心睡吧。', '月圆之夜，写一句。']

describe('小提示句库', () => {
  it('时段：早于“一天开始”的时刻算深夜', () => {
    expect(slotOf(2)).toBe('late')
    expect(slotOf(23)).toBe('late')
    expect(slotOf(6)).toBe('dawn')
    expect(slotOf(5, 6)).toBe('late')
    expect(slotOf(10)).toBe('morning')
    expect(slotOf(14)).toBe('afternoon')
    expect(slotOf(18)).toBe('dusk')
    expect(slotOf(21)).toBe('night')
  })

  it('同一天同一时段总是同一句；换时段会换句', () => {
    const a = pickHint({ date: '2026-11-03', hour: 21 })
    expect(pickHint({ date: '2026-11-03', hour: 22 })).toEqual(a)
    const hours = [6, 10, 14, 18, 21, 0]
    expect(new Set(hours.map((h) => pickHint({ date: '2026-11-03', hour: h }).text)).size).toBeGreaterThan(2)
  })

  it('节日、节气、初一十五当天必定用这一类；节日、节气的句子点明了日子', () => {
    expect(pickHint({ date: '2026-10-08', hour: 10 })).toEqual({ text: '寒露，添件衣服，写一句。', namesDay: true })
    expect(pickHint({ date: '2026-09-25', hour: 21 }).text).toMatch(/中秋/)
    expect(pickHint({ date: '2027-01-01', hour: 10 }).text).toMatch(/新年|一年开头/)
    // 2026-10-10 是农历九月初一
    expect(pickHint({ date: '2026-10-10', hour: 10 })).toMatchObject({ namesDay: false, text: expect.stringMatching(/开头|新月/) })
    expect(pickHint({ date: '2026-12-31', hour: 10 }).text).toBe('一年最后一天，给这一年写个结尾。')
  })

  it('只在夜里的句子白天不出现', () => {
    for (let d = 1; d <= 28; d++) for (const m of ['01', '04', '07', '10']) for (const h of [7, 10, 15, 18]) {
      const t = pickHint({ date: `2027-${m}-${String(d).padStart(2, '0')}`, hour: h }).text
      expect(NIGHT_ONLY).not.toContain(t)
    }
  })

  it('今天写过：连续整数天说一句，否则说写好了；通知里不说日记状态', () => {
    expect(pickHint({ date: '2026-11-03', hour: 10, wrote: true, streak: 7 }).text).toBe('七日不辍，好习惯。')
    expect(pickHint({ date: '2026-11-03', hour: 10, wrote: true, streak: 3 }).text).toMatch(/写好了|落一笔|已记|这页/)
    expect(pickHint({ date: '2026-11-03', hour: 10, wrote: true, streak: 3, forNotice: true }).text).not.toMatch(/写好了|已落一笔/)
  })

  it('那年今日、隔了一阵没写只在首页出现，不说让人愧疚的话', () => {
    const seen = new Set<string>()
    for (let d = 1; d <= 28; d++) for (const h of [10, 21]) {
      seen.add(pickHint({ date: `2027-03-${String(d).padStart(2, '0')}`, hour: h, yearsAgo: 2, gapDays: 9 }).text)
    }
    expect([...seen].some((t) => t.startsWith('两年前的今天你也写过'))).toBe(true)
    expect([...seen].some((t) => t.includes('从今天'))).toBe(true)
    for (const t of allLines()) expect(t).not.toMatch(/没写了|断了|补上/)
  })

  it('一段时间里各种句子都会轮到（不是总挑那几句）', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 400; i++) {
      const dt = new Date(2027, 0, 1 + i)
      const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
      for (const h of [7, 10, 14, 18, 21, 0]) seen.add(pickHint({ date, hour: h }).text)
    }
    expect(seen.size).toBeGreaterThan(90)
    expect(seen).toContain('浮生如寄，字有归处。')
  })

  it('通知：普通日子带农历前缀，夜里的提醒才会用夜里的句子', () => {
    const b = reminderText('2027-03-09', 8).body
    expect(b).toMatch(/^今天(农历|.+)。/)
    for (let d = 1; d <= 28; d++) {
      const body = reminderText(`2027-05-${String(d).padStart(2, '0')}`, 8).body
      expect(NIGHT_ONLY.some((l) => body.endsWith(l))).toBe(false)
    }
  })
})

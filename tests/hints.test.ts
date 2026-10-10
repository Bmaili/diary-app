import { describe, expect, it } from 'vitest'
import { allLines, countdown, PENTAD_GLOSS, pickHint, slotOf, type HintContext } from '../src/core/hints'
import { diaryFacts } from '../src/core/diaryFacts'
import { pentad } from '../src/core/lunar'
import { reminderText } from '../src/core/reminder'
import { addDays } from '../src/core/time'
import type { IndexRow } from '../src/core/types'

const at = (date: string, h: number, m = 0) => {
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m)
}
/** 同一个情境换很多个种子，收集出现过的句子 */
function sample(c: Omit<HintContext, 'seed'>, n = 300) {
  return Array.from({ length: n }, (_, i) => pickHint({ ...c, seed: `s${i}` }))
}
const NIGHT_ONLY = ['若有月色，就写进来。', '星河在天，灯下落笔。', '举头望月之前，先低头写几行。', '秋夜月明，写一句。', '冬夜长，慢慢写。',
  '月到中秋分外明，写一句。', '今夜月色，最宜落笔。', '字已落定，灯可以熄了。', '月圆之夜，写一句。']

describe('小提示：基础', () => {
  it('时段：早于“一天开始”的时刻算深夜', () => {
    expect(slotOf(2)).toBe('late')
    expect(slotOf(23)).toBe('late')
    expect(slotOf(6)).toBe('dawn')
    expect(slotOf(5, 6)).toBe('late')
    expect(slotOf(14)).toBe('afternoon')
    expect(slotOf(18)).toBe('dusk')
    expect(slotOf(21)).toBe('night')
  })

  it('同一个种子总是同一句，不同种子会变', () => {
    const c = { date: '2026-11-03', now: at('2026-11-03', 21) }
    expect(pickHint({ ...c, seed: 'a' })).toEqual(pickHint({ ...c, seed: 'a' }))
    expect(new Set(sample(c, 50).map((h) => h.text)).size).toBeGreaterThan(20)
  })

  it('七十二候都有白话', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 366; i++) seen.add(pentad(addDays('2027-01-01', i)).text)
    expect(seen.size).toBe(72)
    for (const t of seen) expect(PENTAD_GLOSS[t], t).toBeTruthy()
  })

  it('不说让人愧疚的话', () => {
    for (const t of allLines()) expect(t).not.toMatch(/没写了|断了|补上|又没/)
  })
})

describe('小提示：节令与时刻', () => {
  it('节气交节前后：倒计时、当天时辰、最后两小时', () => {
    // 2026 年霜降在 10 月 23 日 17:37
    expect(countdown(at('2026-10-20', 12))).toEqual(['再过三天就霜降了。'])
    expect(countdown(at('2026-10-21', 12))).toEqual(['再过两天就霜降了。'])
    expect(countdown(at('2026-10-22', 12))).toEqual(['明天霜降。'])
    expect(countdown(at('2026-10-23', 9))).toEqual(['今天酉时交霜降。'])
    expect(countdown(at('2026-10-23', 16))).toEqual(['再过一个时辰，就霜降了。'])
    expect(countdown(at('2026-10-23', 18))).toEqual([])
    expect(countdown(at('2026-10-12', 12))).toEqual([])
  })

  it('节气当天：多数是节气句（点明了日子），也会出时辰、七十二候', () => {
    const hs = sample({ date: '2026-10-08', now: at('2026-10-08', 10) })
    const jq = hs.filter((h) => h.kind === 'jieqi')
    expect(jq.length).toBeGreaterThan(120)
    expect(jq.length).toBeLessThan(240)
    expect(jq.every((h) => h.namesDay && h.text.startsWith('寒露'))).toBe(true)
    expect(hs.some((h) => h.text === '鸿雁来宾。最后一批大雁也到了。')).toBe(true)
    expect(hs.some((h) => h.text.startsWith('巳时') || h.text.startsWith('隅中'))).toBe(true)
  })

  it('中秋：白天说团圆、月饼，夜里才说月亮', () => {
    const dayTexts = new Set(sample({ date: '2026-09-25', now: at('2026-09-25', 10) }).filter((h) => h.kind === 'festival').map((h) => h.text))
    const nightTexts = new Set(sample({ date: '2026-09-25', now: at('2026-09-25', 21) }).filter((h) => h.kind === 'festival').map((h) => h.text))
    expect([...dayTexts].sort()).toEqual(['中秋了，月饼吃了吗？', '中秋团圆，今天和谁一起过？'])
    expect(nightTexts.has('月到中秋分外明，写一句。')).toBe(true)
    expect(nightTexts.has('中秋了，月饼吃了吗？')).toBe(false)
  })

  it('只在夜里的句子白天不出现', () => {
    for (const d of ['2027-01-15', '2027-04-15', '2027-07-15', '2027-10-15', '2026-09-25']) {
      for (const h of [7, 10, 15]) {
        for (const x of sample({ date: d, now: at(d, h) }, 80)) expect(NIGHT_ONLY).not.toContain(x.text)
      }
    }
  })

  it('彩蛋：月日相同、闰月、零点前后', () => {
    expect(sample({ date: '2027-11-11', now: at('2027-11-11', 10) }).some((h) => h.text === '今天的日期很整齐。')).toBe(true)
    // 2025 年有闰六月
    expect(sample({ date: '2025-08-05', now: at('2025-08-05', 10) }).some((h) => h.text.startsWith('今年有闰六月'))).toBe(true)
    expect(sample({ date: '2027-03-09', now: at('2027-03-09', 23, 50) }).some((h) => h.text === '一天走到了尽头，也是开头。')).toBe(true)
    expect(sample({ date: '2027-03-09', now: at('2027-03-09', 15) }).some((h) => h.text === '一天走到了尽头，也是开头。')).toBe(false)
  })

  it('一年下来句子很丰富', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 365; i++) {
      const d = addDays('2027-01-01', i)
      for (const h of [7, 10, 14, 18, 21, 0]) seen.add(pickHint({ date: d, now: at(d, h), seed: `${d}|${h}` }).text)
    }
    expect(seen.size).toBeGreaterThan(250)
  })
})

describe('小提示：写过以后、日记素材、通知', () => {
  it('写过以后：连续整数天说一句；不出催人写的句子', () => {
    expect(pickHint({ date: '2026-11-03', now: at('2026-11-03', 10), wrote: true, streak: 7 }).text).toBe('七日不辍，好习惯。')
    const hs = sample({ date: '2026-11-03', now: at('2026-11-03', 21), wrote: true, streak: 3 })
    for (const h of hs.filter((x) => x.kind !== 'wrote')) expect(h.text).not.toMatch(/写|记|笔/)
    expect(hs.some((h) => h.kind === 'wrote')).toBe(true)
    expect(hs.some((h) => h.kind === 'seasonal')).toBe(true)
  })

  it('日记素材大约三成；通知里不用', () => {
    const c = { date: '2026-11-03', now: at('2026-11-03', 10), personal: ['一年前的今天，你在江边公园。'] }
    const n = sample(c).filter((h) => h.kind === 'personal').length
    expect(n).toBeGreaterThan(50)
    expect(n).toBeLessThan(140)
    expect(sample({ ...c, forNotice: true }).some((h) => h.kind === 'personal')).toBe(false)
  })

  it('通知：普通日子带农历前缀；节气当天的节气句不带；早上的提醒不出夜里的句子', () => {
    expect(reminderText('2026-10-08', at('2026-10-08', 22)).body).not.toMatch(/^今天寒露。寒露/)
    for (let d = 1; d <= 28; d++) {
      const date = `2027-05-${String(d).padStart(2, '0')}`
      const body = reminderText(date, at(date, 8)).body
      expect(NIGHT_ONLY.some((l) => body.endsWith(l))).toBe(false)
      expect(body.length).toBeGreaterThan(4)
    }
  })
})

const row = (date: string, o: Partial<IndexRow> = {}): IndexRow => ({
  date, path: `diary/entries/${date.slice(0, 4)}/${date}.md`, mtime: 0, size: 0, hash: '', tags: [], people: [], places: [], text: '今天的事。', mood: 4, ...o,
})

describe('从日记里取材', () => {
  it('那年今日：地点、人、天气、心情', () => {
    const f = diaryFacts([row('2025-11-03', { places: ['江边公园'], people: ['小雨'], weather: '晴 19°', mood: 5 })], '2026-11-03')
    expect(f.personal).toEqual(expect.arrayContaining([
      '一年前的今天，你在江边公园。', '一年前的今天，你写到了小雨。', '一年前的今天，是个晴天。', '一年前的今天，你心情很好。',
    ]))
  })

  it('心情低、设了不让 AI 读的日记不用', () => {
    expect(diaryFacts([row('2025-11-03', { places: ['医院'], mood: 1 })], '2026-11-03').personal).toEqual([])
    expect(diaryFacts([row('2025-11-03', { places: ['医院'], aiExclude: true })], '2026-11-03').personal).toEqual([])
    expect(diaryFacts([row('2025-11-03', { places: ['医院'], mood: undefined })], '2026-11-03').personal).toEqual([])
  })

  it('第一次写到（整百天）、好久没写到的地方（不说人）、本月常去、去年此时', () => {
    const today = '2026-11-03'
    const first = addDays(today, -300)
    const rows = [
      row(first, { people: ['小雨'], places: ['楼下面馆'] }), row(addDays(first, 5), { people: ['小雨'], places: ['楼下面馆'] }),
      row(addDays(first, 9), { people: ['小雨'], places: ['楼下面馆'] }),
      row('2026-11-01', { places: ['图书馆'] }), row('2026-11-02', { places: ['图书馆'] }), row('2026-10-31', { places: ['图书馆'] }),
      row('2025-11-01', { places: ['海边'] }), row('2025-11-06', { places: ['海边'] }),
    ]
    const p = diaryFacts(rows, today).personal
    expect(p).toContain('你第一次写到小雨，是三百天前。')
    expect(p).toContain('上次写到楼下面馆，已经是九个月前了。')
    expect(p.some((t) => t.includes('小雨') && t.includes('上次'))).toBe(false)
    expect(p).toContain('去年这个时候，你常去海边。')
    // 本月（11 月）只有两篇写到图书馆，不够 3 次
    expect(p.some((t) => t.startsWith('这个月你去得最多'))).toBe(false)
  })

  it('这周心情变好才说', () => {
    const today = '2026-11-14'
    const mk = (offs: number[], mood: number) => offs.map((o) => row(addDays(today, -o), { mood }))
    expect(diaryFacts([...mk([0, 1, 2], 5), ...mk([8, 9, 10], 3)], today).personal).toContain('这周的心情比上周好一些。')
    expect(diaryFacts([...mk([0, 1, 2], 3), ...mk([8, 9, 10], 5)], today).personal).not.toContain('这周的心情比上周好一些。')
  })

  it('写完今天之后：第 N 篇、写了几段、满万字', () => {
    const rows = Array.from({ length: 99 }, (_, i) => row(addDays('2026-11-03', -1 - i), { text: '字'.repeat(100) }))
    rows.push(row('2026-11-03', { sections: 3, text: '字'.repeat(200) }))
    const f = diaryFacts(rows, '2026-11-03')
    expect(f.afterWrite).toEqual(['这是你写下的第 100 篇。', '今天已经写了三段，话很多的一天。', '你已经写了一万字。'])
    expect(diaryFacts(rows.slice(0, 99), '2026-11-03').afterWrite).toEqual([])
  })
})

/**
 * 首页小提示里“说中你自己”的那些句子（2026-10-10 加入），全部在本机从索引算出，不用 AI、不联网。
 *
 * 分寸：
 * - 只用心情 3 档以上、而且没有设“不让 AI 读”的日记（后者是“这篇敏感”的信号）；
 * - 人名、地名至少在这些日记里出现过 3 次才会用；
 * - “好久没写到”只说地点，不说人（人可能是分开了或不在了）；
 * - 心情只在变好时说，变差时不说。
 * 设置里可以关掉（prefs.ui.diaryHints），关掉后首页只用节令和通用的句子。
 */
import type { IndexRow } from './types'
import { addDays, daysBetween } from './time'
import { cnNum } from './hints'

export interface DiaryFacts {
  /** 任何时候都可以说的 */
  personal: string[]
  /** 今天写过以后才说的：第 N 篇、写了几段、满几万字 */
  afterWrite: string[]
}

const COUNT_MILESTONES = new Set([50, 100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000])

/** 100 → 一百，300 → 三百，1000 → 一千；其他用阿拉伯数字 */
function roundCn(n: number): string {
  if (n % 1000 === 0 && n <= 10000) return `${cnNum(n / 1000)}千`
  if (n % 100 === 0 && n < 1000) return `${cnNum(n / 100)}百`
  return String(n)
}

function yearsAgo(n: number): string {
  return n <= 10 ? `${cnNum(n)}年前` : `${n} 年前`
}

/** “晴 19°” → “晴”；太长或看不懂的不用 */
function weatherWord(w?: string): string {
  const t = (w ?? '').split(/\s+/)[0]
  return /^[一-龥]{1,3}$/.test(t) ? t.replace(/天$/, '') : ''
}

const eligible = (r: IndexRow) => !r.error && !r.aiExclude && (r.mood ?? 0) >= 3

/**
 * @param rows 全部日记（任意顺序）
 * @param today 今天的日记日期
 */
export function diaryFacts(rows: IndexRow[], today: string): DiaryFacts {
  const personal: string[] = []
  const afterWrite: string[] = []
  const all = rows.filter((r) => !r.error).sort((a, b) => (a.date < b.date ? -1 : 1))
  const good = all.filter(eligible)
  const year = Number(today.slice(0, 4))
  const md = today.slice(5)
  const todayRow = all.find((r) => r.date === today)

  // 那年今日：具体到地点、人、天气、心情（最近的两年）
  const past = good.filter((r) => r.date.slice(5) === md && r.date < today).reverse().slice(0, 2)
  for (const r of past) {
    const pre = `${yearsAgo(year - Number(r.date.slice(0, 4)))}的今天`
    const place = r.places[0] ?? r.locationName
    if (place) personal.push(`${pre}，你在${place}。`)
    if (r.people[0]) personal.push(`${pre}，你写到了${r.people[0]}。`)
    const w = weatherWord(r.weather)
    if (w) personal.push(`${pre}，是个${w}天。`)
    if ((r.mood ?? 0) >= 5) personal.push(`${pre}，你心情很好。`)
    else if ((r.mood ?? 0) >= 4) personal.push(`${pre}，你心情不错。`)
  }

  // 人和地点：第一次、最后一次、次数（只看“可以说”的日记，今天之前的）
  type Seen = { first: string; last: string; count: number }
  const people = new Map<string, Seen>()
  const places = new Map<string, Seen>()
  for (const r of good) {
    if (r.date >= today) continue
    for (const [map, names] of [[people, r.people], [places, r.places]] as const) {
      for (const n of new Set(names)) {
        const s = map.get(n)
        if (s) Object.assign(s, { last: r.date, count: s.count + 1 })
        else map.set(n, { first: r.date, last: r.date, count: 1 })
      }
    }
  }
  for (const map of [people, places]) {
    for (const [name, s] of map) {
      if (s.count < 3) continue
      const days = daysBetween(s.first, today)
      if (s.first.slice(5) === md && days >= 365) personal.push(`${yearsAgo(year - Number(s.first.slice(0, 4)))}的今天，你第一次写到${name}。`)
      else if (days > 0 && days % 100 === 0) personal.push(`你第一次写到${name}，是${roundCn(days)}天前。`)
    }
  }
  const todayPlaces = new Set(todayRow?.places ?? [])
  for (const [name, s] of places) {
    if (s.count < 3 || todayPlaces.has(name)) continue
    const days = daysBetween(s.last, today)
    if (days < 60) continue
    const months = Math.floor(days / 30)
    personal.push(months >= 12 ? `上次写到${name}，已经是一年多以前了。` : `上次写到${name}，已经是${cnNum(months)}个月前了。`)
  }

  // 这个月去得最多的地方
  const month = today.slice(0, 7)
  const top = topOf(good.filter((r) => r.date.startsWith(month)).flatMap((r) => [...new Set(r.places)]), 3)
  if (top) personal.push(`这个月你去得最多的是${top}。`)

  // 这周的心情比上周好（只在变好时说）
  const moodAvg = (from: string, to: string) => {
    const ms = all.filter((r) => !r.aiExclude && r.mood != null && r.date >= from && r.date <= to).map((r) => r.mood!)
    return ms.length >= 3 ? ms.reduce((a, b) => a + b, 0) / ms.length : null
  }
  const thisWeek = moodAvg(addDays(today, -6), today)
  const lastWeek = moodAvg(addDays(today, -13), addDays(today, -7))
  if (thisWeek != null && lastWeek != null && thisWeek - lastWeek >= 0.5) personal.push('这周的心情比上周好一些。')

  // 去年这个时候常去的地方（去年今天前后一周）
  const ly = `${year - 1}-${md}`
  if (!md.startsWith('02-29')) {
    const near = good.filter((r) => r.date >= addDays(ly, -7) && r.date <= addDays(ly, 7))
    const place = topOf(near.flatMap((r) => [...new Set(r.places)]), 2)
    if (place) personal.push(`去年这个时候，你常去${place}。`)
  }

  // 写完今天之后
  if (todayRow) {
    if (COUNT_MILESTONES.has(all.length)) afterWrite.push(`这是你写下的第 ${all.length} 篇。`)
    if ((todayRow.sections ?? 0) >= 3) afterWrite.push(`今天已经写了${cnNum(todayRow.sections!)}段，话很多的一天。`)
    const chars = (r: IndexRow) => r.text.replace(/\s/g, '').length
    const total = all.reduce((s, r) => s + chars(r), 0)
    const wan = Math.floor(total / 10000)
    if (wan >= 1 && Math.floor((total - chars(todayRow)) / 10000) < wan) afterWrite.push(`你已经写了${wan <= 10 ? cnNum(wan) : `${wan} `}万字。`)
  }
  return { personal, afterWrite }
}

/** 出现最多、且至少 min 次的那个 */
function topOf(names: string[], min: number): string {
  const c = new Map<string, number>()
  for (const n of names) c.set(n, (c.get(n) ?? 0) + 1)
  let best = ''
  let n = 0
  for (const [k, v] of c) if (v > n) [best, n] = [k, v]
  return n >= min ? best : ''
}

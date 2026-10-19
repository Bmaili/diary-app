/**
 * 问答首屏的推荐问题（2026-10-15 加入，规格 7.3）：从你常写的人、地点、标签里出题，不调模型。
 * 只用 AI 能读的日记（去掉 ai_exclude 的），问得出来也答得出来。每次打开换一批，点“换一批”再换。
 */
import type { IndexRow } from './types'

export type SuggestKind = 'person' | 'place' | 'tag' | 'time'
export interface Suggestion {
  q: string
  kind: SuggestKind
}

// 2026-10-19 起少问统计、多问有故事的：问题什么样，回答就什么样
const PERSON = ['我和{x}都一起做过什么？', '上次见{x}是什么时候，那天怎么样？', '和{x}在一起最开心的是哪天？', '今年和{x}见了几次？']
const PLACE = ['在{x}的那些天，都发生了什么？', '第一次去{x}是什么时候？', '今年去了几次{x}？']
const TAG = ['说说我写“{x}”的那些日子', '最近一次写到“{x}”是什么时候？']

function top(rows: IndexRow[], pick: (r: IndexRow) => string[], n: number): string[] {
  const c = new Map<string, number>()
  for (const r of rows) for (const v of new Set(pick(r))) c.set(v, (c.get(v) ?? 0) + 1)
  return [...c].filter(([v, k]) => k >= 2 && v.trim()).sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v)
}

function rng(seed: number) {
  let h = seed | 0 || 1
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const shiftDays = (d: string, n: number) => {
  const t = new Date(`${d}T12:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

/** rows：AI 能读的日记（新的在前）；today：今天的日记日期 */
export function suggestQuestions(rows: IndexRow[], today: string, seed: number, n = 5): Suggestion[] {
  const R = rng(seed)
  const pickOne = <T,>(a: T[]): T | undefined => (a.length ? a[Math.floor(R() * a.length)] : undefined)
  const fill = (t: string, x: string) => t.replace('{x}', x)

  const pool: Suggestion[][] = []
  const people = top(rows, (r) => r.people, 8)
  const places = top(rows, (r) => r.places, 8)
  const tags = top(rows, (r) => r.tags, 6)

  const take = (vals: string[], tpl: string[], kind: SuggestKind, k: number) => {
    const vs = [...vals].sort(() => R() - 0.5).slice(0, k)
    pool.push(vs.map((x) => ({ q: fill(pickOne(tpl)!, x), kind })))
  }
  take(people, PERSON, 'person', 2)
  take(places, PLACE, 'place', 2)
  take(tags, TAG, 'tag', 1)

  const time: Suggestion[] = []
  const recent = rows.some((r) => r.date >= shiftDays(today, -31))
  if (recent) time.push({ q: '最近有什么让我高兴的小事？', kind: 'time' }, { q: '帮我回顾一下上个月', kind: 'time' }, { q: '最近一个月过得怎么样？', kind: 'time' })
  const lastYear = shiftDays(today, -365)
  if (rows.some((r) => r.date >= shiftDays(lastYear, -20) && r.date <= shiftDays(lastYear, 20))) {
    time.push({ q: '去年这个时候我在忙什么？', kind: 'time' })
  }
  if (people.length) time.push({ q: '这一年我和谁见面最多？', kind: 'time' })
  if (rows.some((r) => r.date === lastYear)) time.push({ q: '去年今天我写了什么？', kind: 'time' })
  if (rows.length >= 30) time.push({ q: '这些日子里，我最开心的是哪几天？', kind: 'time' })
  if (!time.length && rows.length) time.push({ q: '帮我回顾一下我写过的日记', kind: 'time' })
  pool.push(time.sort(() => R() - 0.5))

  // 轮流从各组里拿，人、地、题、时间都有一点；不够就多拿时间类的
  const out: Suggestion[] = []
  for (let round = 0; out.length < n && pool.some((g) => g.length > round); round++) {
    for (const g of pool) if (g[round] && out.length < n && !out.some((s) => s.q === g[round].q)) out.push(g[round])
  }
  return out
}

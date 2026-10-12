/**
 * 问答的统计工具 aggregate（2026-10-12 加入，规格 7.3）：按时间、心情、天气、地点、人物、标签分组，
 * 算天数、平均心情和心情分布；可以带最多 4 组“系列”做对比。全部在代码里算，模型只选参数。
 * 结果也是回答里图表的数据来源（见 charts.ts）。
 */
import type { IndexRow, ListField } from '../types'
import { addDays, parseYmd, weekday, ymd } from '../time'

export const GROUP_BY = ['year', 'month', 'week', 'day', 'weekday', 'mood', 'weather', 'place', 'person', 'tag', 'none'] as const
export type GroupBy = (typeof GROUP_BY)[number]
export const TIME_GROUPS: readonly GroupBy[] = ['year', 'month', 'week', 'day']

/** 天气是自由文本（“小雨 18°”），归成几类再统计 */
export const WEATHER_KINDS = ['晴', '多云', '阴', '雨', '雪', '雾霾', '其他', '未记录'] as const
export function weatherKind(w: string | undefined): string {
  const s = (w ?? '').trim()
  if (!s) return '未记录'
  if (/雪|冰雹/.test(s)) return '雪'
  if (/雨|雷/.test(s)) return '雨'
  if (/雾|霾|沙|尘/.test(s)) return '雾霾'
  if (/多云|少云|间晴|晴间/.test(s)) return '多云'
  if (/阴/.test(s)) return '阴'
  if (/晴/.test(s)) return '晴'
  return '其他'
}

const MOOD_LABEL = ['', '很差', '不太好', '一般', '不错', '很好']
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const LIST_OF: Record<string, ListField> = { place: 'places', person: 'people', tag: 'tags' }

export interface Filter {
  from?: string
  to?: string
  /** 同义写法：命中任意一个就算 */
  terms?: string[]
  fields?: ListField[]
  match_text?: boolean
  moods?: number[]
  weather?: string[]
  places?: string[]
  people?: string[]
  tags?: string[]
}

export interface Group {
  key: string
  label: string
  days: number
  /** 这组里记了心情的日子的平均心情，没有为 null */
  avg_mood: number | null
  /** 心情 1–5 各几天（组太多时省略） */
  moods?: number[]
}

export interface Series {
  label: string
  total_days: number
  avg_mood: number | null
  moods: number[]
  groups: Group[]
}

export interface AggregateResult {
  group_by: GroupBy
  unit: string
  series: Series[]
  /** 地点、人物、标签分组时，没列出的还有几个 */
  more?: number
  note: string
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [])
const ints = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : [])
const FIELDS: ListField[] = ['places', 'people', 'tags']

/** 模型给的参数 → Filter（容忍各种写法错误） */
export function toFilter(a: Record<string, unknown>): Filter {
  const fields = strs(a.fields).filter((f): f is ListField => FIELDS.includes(f as ListField))
  return {
    from: typeof a.from === 'string' && a.from ? a.from : undefined,
    to: typeof a.to === 'string' && a.to ? a.to : undefined,
    terms: strs(a.terms),
    fields: fields.length ? fields : undefined,
    match_text: a.match_text !== false,
    moods: ints(a.moods),
    weather: strs(a.weather),
    places: strs(a.places),
    people: strs(a.people),
    tags: strs(a.tags),
  }
}

/** from/to 可以是 YYYY、YYYY-MM 或 YYYY-MM-DD，按相同长度的前缀比较 */
export function inRange(d: string, from?: string, to?: string): boolean {
  if (from && d.slice(0, from.length) < from) return false
  if (to && d.slice(0, to.length) > to) return false
  return true
}

const has = (vals: string[], want: string[]) => want.some((w) => vals.some((v) => v.toLowerCase().includes(w.toLowerCase())))

export function matches(r: IndexRow, f: Filter): boolean {
  if (!inRange(r.date, f.from, f.to)) return false
  if (f.moods?.length && !(r.mood != null && f.moods.includes(r.mood))) return false
  if (f.weather?.length && !f.weather.includes(weatherKind(r.weather))) return false
  if (f.places?.length && !has(r.places, f.places)) return false
  if (f.people?.length && !has(r.people, f.people)) return false
  if (f.tags?.length && !has(r.tags, f.tags)) return false
  if (f.terms?.length) {
    const terms = f.terms.map((t) => t.toLowerCase())
    const inMeta = (f.fields ?? FIELDS).some((fl) => r[fl].some((v) => terms.some((t) => v.toLowerCase().includes(t))))
    const inText = f.match_text !== false && terms.some((t) => r.text.toLowerCase().includes(t))
    if (!inMeta && !inText) return false
  }
  return true
}

/** 一篇日记属于哪些组（地点、人物、标签可以属于好几组） */
function keysOf(r: IndexRow, by: GroupBy): string[] {
  switch (by) {
    case 'year': return [r.date.slice(0, 4)]
    case 'month': return [r.date.slice(0, 7)]
    case 'week': return [weekStart(r.date)]
    case 'day': return [r.date]
    case 'weekday': return [weekday(r.date)]
    case 'mood': return r.mood != null ? [String(r.mood)] : []
    case 'weather': return [weatherKind(r.weather)]
    case 'place': case 'person': case 'tag': return [...new Set(r[LIST_OF[by]])]
    default: return ['all']
  }
}

/** 这一周的周一 */
export function weekStart(date: string): string {
  const d = parseYmd(date)
  return addDays(date, -((d.getDay() + 6) % 7))
}

function label(by: GroupBy, key: string): string {
  switch (by) {
    case 'year': return `${key} 年`
    case 'month': return `${Number(key.slice(0, 4))} 年 ${Number(key.slice(5))} 月`
    case 'week': return `${Number(key.slice(5, 7))}/${Number(key.slice(8))} 起的一周`
    case 'mood': return `${key} ${MOOD_LABEL[Number(key)] ?? ''}`.trim()
    case 'none': return '全部'
    default: return key
  }
}

/** 时间分组要补上空档（某个月一篇都没有也要占一格，图表才对得上） */
function timeKeys(by: GroupBy, first: string, last: string): string[] {
  const out: string[] = []
  if (by === 'year') for (let y = Number(first.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) out.push(String(y))
  else if (by === 'month') {
    let y = Number(first.slice(0, 4))
    let m = Number(first.slice(5, 7))
    const end = last.slice(0, 7)
    for (;;) {
      const k = `${y}-${String(m).padStart(2, '0')}`
      if (k > end) break
      out.push(k)
      if (++m > 12) { m = 1; y++ }
    }
  } else if (by === 'week') for (let d = weekStart(first); d <= last; d = addDays(d, 7)) out.push(d)
  else if (by === 'day') for (let d = first; d <= last; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * 时间范围的首尾：优先用参数里的 from/to（补成完整日期），没给时用命中日记的首尾。
 * 结束日期不超过最近一篇日记（latest）：“今年”问到 10 月时，不画出还没到的 11、12 月。
 */
function span(rows: IndexRow[], f: Filter, latest: string | undefined): [string, string] | null {
  const dates = rows.map((r) => r.date).sort()
  const pad = (s: string, end: boolean) => {
    if (s.length >= 10) return s.slice(0, 10)
    if (s.length === 7) return end ? ymd(new Date(Number(s.slice(0, 4)), Number(s.slice(5)), 0)) : `${s}-01`
    return end ? `${s}-12-31` : `${s}-01-01`
  }
  const first = f.from ? pad(f.from, false) : dates[0]
  let last = f.to ? pad(f.to, true) : dates[dates.length - 1]
  if (!first || !last) return null
  if (latest && last > latest && latest >= first) last = latest
  return first <= last ? [first, last] : null
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null)
function moodCounts(rows: IndexRow[]): number[] {
  const c = [0, 0, 0, 0, 0]
  for (const r of rows) if (r.mood != null && r.mood >= 1 && r.mood <= 5) c[r.mood - 1]++
  return c
}

/** 分组太多时（按天分一整年）每组不带心情分布，免得结果太长 */
const DETAIL_LIMIT = 120
/** 按天分组最多这么多天 */
const DAY_LIMIT = 400

export function aggregate(rows: IndexRow[], a: Record<string, unknown>): AggregateResult | { error: string } {
  const by: GroupBy = GROUP_BY.includes(a.group_by as GroupBy) ? (a.group_by as GroupBy) : 'none'
  const base = toFilter(a)
  const rawSeries = Array.isArray(a.series) ? (a.series as unknown[]).filter((s): s is Record<string, unknown> => !!s && typeof s === 'object').slice(0, 4) : []
  const defs = rawSeries.length
    ? rawSeries.map((s, i) => {
      const own = toFilter(s)
      // 系列的条件和外层的条件同时生效；外层没给的用系列的
      const f: Filter = {
        ...base,
        from: own.from ?? base.from,
        to: own.to ?? base.to,
        terms: own.terms?.length ? own.terms : base.terms,
        fields: own.fields ?? base.fields,
        match_text: s.match_text === undefined ? base.match_text : own.match_text,
        moods: own.moods?.length ? own.moods : base.moods,
        weather: own.weather?.length ? own.weather : base.weather,
        places: own.places?.length ? own.places : base.places,
        people: own.people?.length ? own.people : base.people,
        tags: own.tags?.length ? own.tags : base.tags,
      }
      return { label: String(s.label ?? '').trim() || `第 ${i + 1} 组`, f }
    })
    : [{ label: '全部', f: base }]

  // 对比不同年份时（今年 vs 去年），按月或按周分组要对齐到同一个位置
  const aligned = defs.length > 1 && (by === 'month' || by === 'day')
    && new Set(defs.map((d) => (d.f.from ?? '').slice(0, 4))).size > 1
  const alignKey = (k: string) => (aligned ? k.slice(5) : k)

  const picked = defs.map((d) => ({ ...d, rows: rows.filter((r) => matches(r, d.f)) }))
  const latest = rows.reduce<string | undefined>((m, r) => (!m || r.date > m ? r.date : m), undefined)
  let keys: string[]
  if (TIME_GROUPS.includes(by)) {
    if (aligned) {
      const all = new Set<string>()
      for (const p of picked) {
        const sp = span(p.rows, p.f, latest)
        if (sp) for (const k of timeKeys(by, sp[0], sp[1])) all.add(alignKey(k))
      }
      keys = [...all].sort()
    } else {
      const sp = span(picked.flatMap((p) => p.rows), { from: base.from, to: base.to }, latest)
      keys = sp ? timeKeys(by, sp[0], sp[1]) : []
    }
    if (by === 'day' && keys.length > DAY_LIMIT) return { error: `按天分组最多 ${DAY_LIMIT} 天，请缩小日期范围或改按周、按月分组` }
  } else if (by === 'weekday') keys = WEEKDAYS
  else if (by === 'mood') keys = ['1', '2', '3', '4', '5']
  else if (by === 'weather') {
    // 没有“未记录”的日子就不列这一组
    const blank = picked.some((p) => p.rows.some((r) => !r.weather?.trim()))
    keys = WEATHER_KINDS.filter((k) => blank || k !== '未记录')
  }
  else if (by === 'none') keys = ['all']
  else {
    // 地点、人物、标签：按各系列合计的天数取前 limit 个
    const c = new Map<string, number>()
    for (const p of picked) for (const r of p.rows) for (const k of keysOf(r, by)) c.set(k, (c.get(k) ?? 0) + 1)
    keys = [...c].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k]) => k)
  }
  const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50)
  let more: number | undefined
  if (['place', 'person', 'tag'].includes(by) && keys.length > limit) {
    more = keys.length - limit
    keys = keys.slice(0, limit)
  }
  const detail = keys.length <= DETAIL_LIMIT

  const series: Series[] = picked.map((p) => {
    const buckets = new Map<string, IndexRow[]>(keys.map((k) => [k, []]))
    for (const r of p.rows) for (const k of keysOf(r, by)) buckets.get(alignKey(k))?.push(r)
    return {
      label: p.label,
      total_days: p.rows.length,
      avg_mood: avg(p.rows.filter((r) => r.mood != null).map((r) => r.mood!)),
      moods: moodCounts(p.rows),
      groups: keys.map((k) => {
        const rs = buckets.get(k)!
        const g: Group = {
          key: k,
          label: aligned ? (by === 'month' ? `${Number(k.slice(0, 2))} 月` : `${Number(k.slice(0, 2))}/${Number(k.slice(3))}`) : label(by, k),
          days: rs.length,
          avg_mood: avg(rs.filter((r) => r.mood != null).map((r) => r.mood!)),
        }
        if (detail) g.moods = moodCounts(rs)
        return g
      }),
    }
  })
  return {
    group_by: by,
    unit: '天',
    series,
    ...(more ? { more } : {}),
    note: '单位是天：同一天写了几段也只算一天。平均心情只算记了心情的日子（1 很差 … 5 很好）。'
      + (['place', 'person', 'tag'].includes(by) ? '同一天可以同时属于几个地点、人物或标签。' : ''),
  }
}

/** get_stats 补充的心情概况 */
export function moodSummary(rows: IndexRow[]): { mood_days: number; avg_mood: number | null; moods: number[] } {
  const ms = rows.filter((r) => r.mood != null).map((r) => r.mood!)
  return { mood_days: ms.length, avg_mood: avg(ms), moods: moodCounts(rows) }
}

/**
 * 问答回答里的图表（2026-10-12 加入，规格 7.3）。
 *
 * 数字只来自代码：aggregate、count_days 的结果由代码编号（chart_id），模型在回答里写
 * [[chart:编号]] 或 [[chart:编号:类型]] 决定放哪张、放在哪，界面用存下的数据来画。模型碰不到数字。
 * 被引用到的图表数据存进这次问答的记录，翻看以前的对话时图还在。
 */
import type { AggregateResult, GroupBy } from './stats'
import { TIME_GROUPS } from './stats'

export const CHART_KINDS = ['bar', 'line', 'rank', 'mood', 'heatmap'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export interface ChartGroup {
  key: string
  label: string
  days: number
  avg_mood: number | null
  moods?: number[]
}
export interface ChartSeries {
  label: string
  groups: ChartGroup[]
}
/** 分组统计（aggregate） */
export interface GroupsChart {
  type: 'groups'
  title: string
  group_by: GroupBy
  series: ChartSeries[]
}
/** 一串日期（count_days）：画成日历格子，或按月汇总成柱状图 */
export interface DatesChart {
  type: 'dates'
  title: string
  from: string
  to: string
  dates: { date: string; mood: number | null }[]
}
export type ChartData = GroupsChart | DatesChart

/** 日历格子最多画几个月 */
export const HEATMAP_MONTHS = 36

/** aggregate 的结果 → 图表数据。不分组只是几组对比时，把每组当成一行 */
export function chartFromAggregate(r: AggregateResult, title: string): GroupsChart | null {
  if (!r.series.length) return null
  if (r.group_by === 'none') {
    if (r.series.length < 2) return null
    return {
      type: 'groups', title, group_by: 'none',
      series: [{
        label: '',
        groups: r.series.map((s) => ({ key: s.label, label: s.label, days: s.total_days, avg_mood: s.avg_mood, moods: s.moods })),
      }],
    }
  }
  return {
    type: 'groups', title, group_by: r.group_by,
    series: r.series.map((s) => ({ label: s.label, groups: s.groups.map((g) => ({ ...g })) })),
  }
}

const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7)) + 1

/** 这张图能画成哪几种 */
export function kindsFor(c: ChartData): ChartKind[] {
  if (c.type === 'dates') return monthsBetween(c.from, c.to) <= HEATMAP_MONTHS ? ['heatmap', 'bar'] : ['bar']
  const out: ChartKind[] = ['bar', 'rank']
  if (c.series.some((s) => s.groups.some((g) => g.avg_mood != null))) out.push('line')
  if (c.series.length === 1 || c.group_by === 'none') {
    if (c.series.every((s) => s.groups.every((g) => g.moods))) out.push('mood')
  }
  if (c.group_by === 'day' && c.series.length === 1) out.push('heatmap')
  return out
}

/** 没指定类型、或指定的画不了时用哪种 */
export function defaultKind(c: ChartData): ChartKind {
  if (c.type === 'dates') return kindsFor(c)[0]
  if (TIME_GROUPS.includes(c.group_by) || c.group_by === 'mood') return 'bar'
  return 'rank'
}

export function pickKind(c: ChartData, want?: string): ChartKind {
  const ks = kindsFor(c)
  return want && ks.includes(want as ChartKind) ? (want as ChartKind) : defaultKind(c)
}

/** count_days 的日期按月汇总（日期太多、跨度太长时画柱状图） */
export function monthlyCounts(c: DatesChart): ChartGroup[] {
  const by = new Map<string, number>()
  for (const d of c.dates) by.set(d.date.slice(0, 7), (by.get(d.date.slice(0, 7)) ?? 0) + 1)
  const out: ChartGroup[] = []
  let y = Number(c.from.slice(0, 4))
  let m = Number(c.from.slice(5, 7))
  const end = c.to.slice(0, 7)
  for (let i = 0; i < 600; i++) {
    const k = `${y}-${String(m).padStart(2, '0')}`
    if (k > end) break
    out.push({ key: k, label: `${y} 年 ${m} 月`, days: by.get(k) ?? 0, avg_mood: null })
    if (++m > 12) { m = 1; y++ }
  }
  return out
}

// ---------- 回答正文里的图表标记 ----------

/** [[chart:编号]] 或 [[chart:编号:类型]]；容忍全角括号、冒号和空格 */
export const CHART_MARK = /(?:\[\[|【【)\s*chart\s*[:：]\s*([A-Za-z0-9_-]+)\s*(?:[:：]\s*([a-z]+)\s*)?(?:\]\]|】】)/g

export type AnswerPart = { md: string } | { chart: string; kind?: string }

/** 把回答拆成文字段和图表段 */
export function splitAnswer(text: string): AnswerPart[] {
  const parts: AnswerPart[] = []
  let last = 0
  for (const m of text.matchAll(CHART_MARK)) {
    const before = text.slice(last, m.index)
    if (before.trim()) parts.push({ md: before })
    parts.push({ chart: m[1], ...(m[2] ? { kind: m[2] } : {}) })
    last = m.index! + m[0].length
  }
  const rest = text.slice(last)
  if (rest.trim() || !parts.length) parts.push({ md: rest })
  return parts
}

/** 回答里引用到的图表编号 */
export function chartRefs(text: string): string[] {
  return [...new Set([...text.matchAll(CHART_MARK)].map((m) => m[1]))]
}

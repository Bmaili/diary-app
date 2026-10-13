/**
 * 问答工具（规格 7.3）。模型负责选词和表述，计数、去重、合并全部在这里用代码完成。
 */
import type { DiaryIndex } from '../diaryIndex'
import type { DiaryRepo } from '../repo'
import type { FileStore, IndexRow, ListField } from '../types'
import { hasBody, needsExtraction } from '../diaryIndex'
import { readSummary, summaryStatus } from '../summaries'
import type { ToolDef } from './client'
import { aggregate, GROUP_BY, moodSummary, WEATHER_KINDS, type AggregateResult } from './stats'
import { chartFromAggregate, type ChartData } from './charts'

const DATE = { type: 'string', description: 'YYYY-MM-DD' }
const FIELD = { type: 'string', enum: ['places', 'people', 'tags'] }

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_stats',
    description: '日记的基本统计：篇数、日期范围、已用 AI 抽取过地点人物标签的篇数和未抽取篇数，以及心情概况（记了心情的天数、平均心情、1–5 各几天）。回答任何问题前可先调用以了解数据范围。',
    parameters: { type: 'object', properties: { from: DATE, to: DATE }, required: [] },
  },
  {
    name: 'list_values',
    description:
      '列出 places（去过的地方）、people（提到的人）或 tags（标签）字段里已有的取值及各自出现的天数。用于找到同一个地方或人的不同写法，例如查“老王”能看到“老王烧烤”“老王家”。query 为空时按天数降序返回。',
    parameters: {
      type: 'object',
      properties: { field: FIELD, query: { type: 'string', description: '包含这个子串的取值；可留空' }, limit: { type: 'integer', description: '默认 50' } },
      required: ['field'],
    },
  },
  {
    name: 'count_days',
    description:
      '统计有多少天提到了某个人、地点或事物。terms 是同义写法列表（会合并去重，同一天只算一次）。默认同时匹配元数据字段（places、people、tags）和正文。返回天数和全部日期，以及每天是从哪里匹配到的。所有“几次”“多少天”的问题必须用这个工具计数，不要自己数。',
    parameters: {
      type: 'object',
      properties: {
        terms: { type: 'array', items: { type: 'string' }, description: '要找的词及其各种写法、简称' },
        fields: { type: 'array', items: FIELD, description: '匹配哪些元数据字段，默认全部' },
        match_text: { type: 'boolean', description: '是否也在正文里找，默认 true' },
        from: DATE,
        to: DATE,
      },
      required: ['terms'],
    },
  },
  {
    name: 'aggregate',
    description:
      '分组统计（全部在代码里算）：按时间（year/month/week/day）、星期几（weekday）、心情（mood）、天气（weather）、'
      + '地点（place）、人物（person）、标签（tag）分组，返回每组的天数、平均心情（1–5）和心情分布。'
      + '筛选条件和 count_days 一样（terms 同义写法、fields、match_text），还可以按心情、天气、地点、人物、标签筛选。'
      + '要对比时用 series（最多 4 组，每组有自己的 label 和筛选条件，例如今年和去年、晴天和雨天）；对比不同年份按月分组时会按月份对齐。'
      + '“心情怎么样”“哪个月最低落”“和谁在一起时心情好”“下雨天心情如何”“星期几写得最多”这类问题用它。结果带 chart_id，可以在回答里画成图。',
    parameters: {
      type: 'object',
      properties: {
        group_by: { type: 'string', enum: [...GROUP_BY], description: '分组方式；none 表示不分组，只算总数' },
        from: DATE,
        to: DATE,
        terms: { type: 'array', items: { type: 'string' }, description: '只统计提到这些词（任意一个）的日子' },
        fields: { type: 'array', items: FIELD },
        match_text: { type: 'boolean', description: 'terms 是否也在正文里找，默认 true' },
        moods: { type: 'array', items: { type: 'integer' }, description: '只统计这些心情的日子' },
        weather: { type: 'array', items: { type: 'string', enum: [...WEATHER_KINDS] } },
        places: { type: 'array', items: { type: 'string' } },
        people: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        series: {
          type: 'array',
          description: '对比的几组，每组的条件和外层条件同时生效',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' }, from: DATE, to: DATE,
              terms: { type: 'array', items: { type: 'string' } },
              moods: { type: 'array', items: { type: 'integer' } },
              weather: { type: 'array', items: { type: 'string' } },
              places: { type: 'array', items: { type: 'string' } },
              people: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['label'],
          },
        },
        limit: { type: 'integer', description: '按地点、人物、标签分组时最多列几组，默认 15' },
      },
      required: ['group_by'],
    },
  },
  {
    name: 'search_entries',
    description: '按关键词和条件搜索日记，返回命中总数和每篇的日期、片段、元数据。多个关键词用空格分隔，表示同时包含。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        from: DATE,
        to: DATE,
        tags: { type: 'array', items: { type: 'string' } },
        people: { type: 'array', items: { type: 'string' } },
        places: { type: 'array', items: { type: 'string' } },
        moods: { type: 'array', items: { type: 'integer' }, description: '心情 1–5，1 很差 5 很好' },
        limit: { type: 'integer', description: '最多返回多少篇，默认 20' },
      },
      required: [],
    },
  },
  {
    name: 'get_entries',
    description: '读取日记全文（含天气、心情、位置等元数据）。可给日期列表或日期范围。内容超过 max_chars 时分页，用返回的 next_offset 继续读。',
    parameters: {
      type: 'object',
      properties: {
        dates: { type: 'array', items: DATE },
        from: DATE,
        to: DATE,
        max_chars: { type: 'integer', description: '本次最多返回的字数，默认 12000' },
        offset: { type: 'integer', description: '从第几篇开始，分页用' },
      },
      required: [],
    },
  },
  {
    name: 'get_summaries',
    description: '读取月度或年度总结。问“这几年”“今年过得怎样”这类跨度很大的问题时，先读总结，不要读全部原文。缺失的期间会单独列出。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['monthly', 'yearly'] },
        from: { type: 'string', description: '月度用 YYYY-MM，年度用 YYYY' },
        to: { type: 'string' },
      },
      required: ['kind'],
    },
  },
]

/** from/to 可以是 YYYY、YYYY-MM 或 YYYY-MM-DD，按相同长度的前缀比较 */
function inRange(d: string, from?: unknown, to?: unknown): boolean {
  if (typeof from === 'string' && from && d.slice(0, from.length) < from) return false
  if (typeof to === 'string' && to && d.slice(0, to.length) > to) return false
  return true
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [])
const FIELDS: ListField[] = ['places', 'people', 'tags']

export class DiaryTools {
  constructor(private index: DiaryIndex, private repo: DiaryRepo, private store: FileStore) {}

  /** 只给 AI 看没设置“不让 AI 读”的日记 */
  private rows(from?: unknown, to?: unknown): IndexRow[] {
    return this.index.aiRows().filter((r) => inRange(r.date, from, to))
  }

  /** 词表：按 AI 能读的日记重新计数 */
  private values(field: ListField): { value: string; count: number }[] {
    const c = new Map<string, number>()
    for (const r of this.rows()) for (const v of r[field]) c.set(v, (c.get(v) ?? 0) + 1)
    return [...c].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
  }

  get_stats(a: Record<string, unknown>) {
    const rows = this.rows(a.from, a.to)
    const pending = rows.filter((r) => hasBody(r) && needsExtraction(r)).length
    return {
      total: rows.length,
      extracted: rows.length - pending,
      not_extracted: pending,
      first: rows[rows.length - 1]?.date ?? null,
      last: rows[0]?.date ?? null,
      ...moodSummary(rows),
    }
  }

  aggregate(a: Record<string, unknown>) {
    return aggregate(this.rows(), a)
  }

  list_values(a: Record<string, unknown>) {
    const field = (FIELDS.includes(a.field as ListField) ? a.field : 'places') as ListField
    const q = String(a.query ?? '').trim().toLowerCase()
    const limit = Math.min(Number(a.limit) || 50, 300)
    let vals = this.values(field)
    if (q) {
      // 子串匹配；再放宽到“共享至少两个字”，以便找到简称
      const direct = vals.filter((v) => v.value.toLowerCase().includes(q) || q.includes(v.value.toLowerCase()))
      const bigrams = new Set(Array.from({ length: Math.max(0, q.length - 1) }, (_, i) => q.slice(i, i + 2)))
      const fuzzy = vals.filter((v) => !direct.includes(v) && [...bigrams].some((b) => v.value.toLowerCase().includes(b)))
      vals = [...direct, ...fuzzy]
    }
    return { field, total: vals.length, values: vals.slice(0, limit).map((v) => ({ value: v.value, days: v.count })) }
  }

  count_days(a: Record<string, unknown>) {
    const terms = strArr(a.terms).map((t) => t.toLowerCase())
    if (!terms.length) return { error: 'terms 不能为空' }
    const fields = strArr(a.fields).filter((f): f is ListField => FIELDS.includes(f as ListField))
    const useFields = fields.length ? fields : FIELDS
    const matchText = a.match_text !== false
    const dates: { date: string; via: string[]; matched: string[] }[] = []
    for (const r of this.rows(a.from, a.to)) {
      const via = new Set<string>()
      const matched = new Set<string>()
      for (const f of useFields) {
        for (const v of r[f]) {
          const lv = v.toLowerCase()
          for (const t of terms) if (lv.includes(t)) {
            via.add(f)
            matched.add(v)
          }
        }
      }
      if (matchText) {
        const lt = r.text.toLowerCase()
        for (const t of terms) if (lt.includes(t)) {
          via.add('text')
          matched.add(t)
        }
      }
      if (via.size) dates.push({ date: r.date, via: [...via], matched: [...matched] })
    }
    dates.sort((x, y) => (x.date < y.date ? -1 : 1))
    const range = this.rows(a.from, a.to)
    return {
      days: dates.length,
      note: '单位是天：同一天提到多次只算一次',
      unextracted_in_range: range.filter((r) => hasBody(r) && needsExtraction(r)).length,
      text_only_days: dates.filter((d) => d.via.length === 1 && d.via[0] === 'text').length,
      dates: dates.slice(0, 500),
    }
  }

  search_entries(a: Record<string, unknown>) {
    const hits = this.index.search({
      q: String(a.query ?? ''),
      from: typeof a.from === 'string' ? a.from : undefined,
      to: typeof a.to === 'string' ? a.to : undefined,
      tags: strArr(a.tags),
      people: strArr(a.people),
      places: strArr(a.places),
      moods: Array.isArray(a.moods) ? a.moods.map(Number) : undefined,
    }).filter((h) => !h.row.aiExclude)
    const limit = Math.min(Number(a.limit) || 20, 100)
    return {
      total: hits.length,
      results: hits.slice(0, limit).map((h) => ({
        date: h.row.date,
        snippet: h.snippet.map((s) => s.text).join(''),
        mood: h.row.mood ?? null,
        tags: h.row.tags,
        people: h.row.people,
        places: h.row.places,
      })),
    }
  }

  async get_entries(a: Record<string, unknown>) {
    const max = Math.min(Number(a.max_chars) || 12000, 40000)
    const offset = Math.max(0, Number(a.offset) || 0)
    const want = strArr(a.dates)
    const rows = want.length
      ? want.map((d) => this.index.get(d)).filter((r): r is IndexRow => !!r && !r.aiExclude)
      : this.rows(a.from, a.to).slice().reverse()
    const out: Record<string, unknown>[] = []
    let used = 0
    let i = offset
    for (; i < rows.length; i++) {
      const r = rows[i]
      const doc = await this.repo.readEntry(r.date).catch(() => null)
      const body = doc?.body ?? r.text
      if (used + body.length > max && out.length) break
      used += body.length
      const m = doc?.meta
      out.push({
        date: r.date,
        weather: m?.weather ? `${m.weather.text ?? ''} ${m.weather.temp_c ?? ''}°C`.trim() : undefined,
        mood: m?.mood,
        location: m?.location?.name ?? m?.location?.address,
        tags: m?.tags, people: m?.people, places: m?.places,
        text: body,
      })
    }
    return { returned: out.length, total: rows.length, next_offset: i < rows.length ? i : null, entries: out }
  }

  async get_summaries(a: Record<string, unknown>) {
    const kind = a.kind === 'yearly' ? 'yearly' : 'monthly'
    const all = this.index.aiRows()
    if (!all.length) return { summaries: [], missing: [] }
    const periods = new Set(all.map((r) => (kind === 'yearly' ? r.date.slice(0, 4) : r.date.slice(0, 7))))
    const list = [...periods].filter((p) => (!a.from || p >= String(a.from)) && (!a.to || p <= String(a.to))).sort()
    const summaries: { period: string; text: string; status: string }[] = []
    const missing: string[] = []
    for (const p of list) {
      const s = await readSummary(this.store, p)
      if (!s) missing.push(p)
      else summaries.push({ period: p, text: s.body, status: await summaryStatus(this.store, this.index, p) })
    }
    return { summaries, missing }
  }

  /**
   * 能画成图的结果（aggregate、count_days）→ 图表数据，其他返回 null。
   * 数据全部来自工具结果和索引，见 charts.ts。
   */
  chart(name: string, args: Record<string, unknown>, result: unknown): ChartData | null {
    const r = result as Record<string, unknown> | null
    if (!r || typeof r !== 'object' || 'error' in r) return null
    const terms = strArr(args.terms)
    const about = terms.length ? `“${terms.slice(0, 3).join('、')}”${terms.length > 3 ? '等' : ''}` : ''
    if (name === 'aggregate') {
      const a = r as unknown as AggregateResult
      // 标题：范围 · 分组；指标（天数、平均心情……）由界面按画法接在后面
      const by = a.group_by === 'none'
        ? a.series.map((x) => x.label).join('、')
        : ({ year: '按年', month: '按月', week: '按周', day: '按天', weekday: '按星期', mood: '按心情', weather: '按天气', place: '按地点', person: '按人物', tag: '按标签' } as Record<string, string>)[a.group_by] ?? ''
      return chartFromAggregate(a, [about, by].filter(Boolean).join(' · '))
    }
    if (name === 'count_days') {
      const dates = (r.dates as { date: string }[] | undefined) ?? []
      if (!dates.length) return null
      const pad = (v: unknown, end: boolean) => {
        const s = typeof v === 'string' ? v : ''
        if (s.length === 10) return s
        if (s.length === 7) return end ? `${s}-31` : `${s}-01`
        if (s.length === 4) return end ? `${s}-12-31` : `${s}-01-01`
        return ''
      }
      return {
        type: 'dates',
        title: `${about || '提到'}的日子`,
        from: pad(args.from, false) || dates[0].date,
        to: pad(args.to, true) || dates[dates.length - 1].date,
        dates: dates.map((d) => ({ date: d.date, mood: this.index.get(d.date)?.mood ?? null })),
      }
    }
    return null
  }

  async run(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_stats': return this.get_stats(args)
      case 'list_values': return this.list_values(args)
      case 'count_days': return this.count_days(args)
      case 'aggregate': return this.aggregate(args)
      case 'search_entries': return this.search_entries(args)
      case 'get_entries': return this.get_entries(args)
      case 'get_summaries': return this.get_summaries(args)
      default: return { error: `没有这个工具：${name}` }
    }
  }
}

/**
 * 人物、地点、标签的小传（2026-10-15 加入，规格 7.7）：一个人或一个地方在日记里出现的样子。
 * 都由代码从索引里算（按 AI 标注或手动填的 people / places / tags 字段），不调模型。纯函数，有单元测试。
 */
import type { IndexRow, ListField } from './types'

export interface BioDay {
  date: string
  mood?: number
  /** 正文开头 */
  preview: string
}

export interface Bio {
  field: ListField
  value: string
  /** 提到的日子，新的在前 */
  days: BioDay[]
  first?: string
  last?: string
  /** 出现过的年份，新的在前 */
  years: string[]
  /** 某一年每月几天 */
  months: (year: string) => number[]
  /** 某一年几天 */
  inYear: (year: string) => number
  /** 这些天里各心情的天数，下标 0 是没记心情 */
  moods: number[]
  /** 常一起出现的（别的人、地点、标签），按次数 */
  together: { field: ListField; value: string; count: number }[]
}

const FIELDS: ListField[] = ['people', 'places', 'tags']

export function previewText(text: string, n = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

export function buildBio(rows: IndexRow[], field: ListField, value: string): Bio {
  const hit = rows.filter((r) => !r.error && r[field].includes(value)).sort((a, b) => (a.date < b.date ? 1 : -1))
  const days = hit.map((r) => ({ date: r.date, ...(r.mood ? { mood: r.mood } : {}), preview: previewText(r.text) }))
  const years = [...new Set(hit.map((r) => r.date.slice(0, 4)))]
  const moods = [0, 0, 0, 0, 0, 0]
  for (const r of hit) moods[r.mood && r.mood >= 1 && r.mood <= 5 ? r.mood : 0]++
  const co = new Map<string, { field: ListField; value: string; count: number }>()
  for (const r of hit) {
    for (const f of FIELDS) {
      for (const v of new Set(r[f])) {
        if (f === field && v === value) continue
        const k = `${f}\u0000${v}`
        const e = co.get(k) ?? { field: f, value: v, count: 0 }
        e.count++
        co.set(k, e)
      }
    }
  }
  return {
    field,
    value,
    days,
    first: hit[hit.length - 1]?.date,
    last: hit[0]?.date,
    years,
    months: (y) => {
      const m = new Array(12).fill(0)
      for (const r of hit) if (r.date.startsWith(`${y}-`)) m[Number(r.date.slice(5, 7)) - 1]++
      return m
    },
    inYear: (y) => hit.filter((r) => r.date.startsWith(`${y}-`)).length,
    moods,
    together: [...co.values()].sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1)).slice(0, 8),
  }
}

/** 名帖第三格：人看常一起去的地方，地点看常一起来的人，标签看常在哪儿 */
export function companion(b: Bio): { label: string; value: string } | null {
  const want: ListField = b.field === 'people' ? 'places' : 'people'
  const t = b.together.find((x) => x.field === want && x.count >= 2)
  if (!t) return null
  return { label: b.field === 'people' ? '常一起去' : b.field === 'places' ? '常一起来' : '常和谁', value: t.value }
}

/** “三天前”“两个月前”这类说法 */
export function ago(date: string, today: string): string {
  const d = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86400000)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 31) return `${d} 天前`
  if (d < 365) return `${Math.round(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

/** 印章里写的字：四个字以内写名字，太长写一个字代表（人 / 地 / 题） */
export function sealText(field: ListField, value: string): string {
  const v = value.trim()
  if ([...v].length <= 4) return v
  return field === 'people' ? '人' : field === 'places' ? '地' : '题'
}

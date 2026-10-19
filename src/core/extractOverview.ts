/**
 * AI 标注一览（2026-10-14 加入，规格 7.4）：把索引里的日记分成“待标注”“已标注”“跳过”三组，
 * 让用户看得出哪些还没标、标了些什么。纯函数，只读索引行。
 */
import { hasBody, needsExtraction } from './diaryIndex'
import type { IndexRow, ListField } from './types'

export type PendingReason = 'never' | 'edited'
export type SkipReason = 'exclude' | 'mood-only' | 'broken'

export interface OverviewRow {
  date: string
  /** 正文开头一小段 */
  preview: string
}

export interface PendingRow extends OverviewRow {
  reason: PendingReason
}

export interface TaggedRow extends OverviewRow {
  places: string[]
  people: string[]
  tags: string[]
  /** 手动改过、AI 不再动的字段 */
  locked: ListField[]
  /** AI 上次标注的时间 */
  extractedAt: string
}

export interface SkippedRow extends OverviewRow {
  reason: SkipReason
}

export interface ExtractOverview {
  pending: PendingRow[]
  tagged: TaggedRow[]
  skipped: SkippedRow[]
}

export const PENDING_LABEL: Record<PendingReason, string> = { never: '还没整理过', edited: '整理后又改过' }
export const SKIP_LABEL: Record<SkipReason, string> = {
  exclude: '设了不让 AI 读',
  'mood-only': '只记了心情，没有正文',
  broken: '这篇的格式坏了，读不出来',
}

const FIELDS: ListField[] = ['places', 'people', 'tags']

export function previewOf(text: string, n = 36): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

/**
 * 分组规则和批量标注一致（DiaryIndex.needsExtraction）：
 * 格式有误、不让 AI 读、只记了心情的跳过；其余没抽取过或抽取后改过的待标注；剩下的是已标注。
 * 每组都是新的在前（传入的行已按日期倒序）。
 */
export function extractOverview(rows: IndexRow[]): ExtractOverview {
  const out: ExtractOverview = { pending: [], tagged: [], skipped: [] }
  for (const r of rows) {
    const base = { date: r.date, preview: previewOf(r.text) }
    if (r.error) out.skipped.push({ ...base, reason: 'broken' })
    else if (r.aiExclude) out.skipped.push({ ...base, reason: 'exclude' })
    else if (!hasBody(r)) out.skipped.push({ ...base, reason: 'mood-only' })
    else if (needsExtraction(r)) out.pending.push({ ...base, reason: r.extractedAt ? 'edited' : 'never' })
    else {
      out.tagged.push({
        ...base,
        places: r.places,
        people: r.people,
        tags: r.tags,
        locked: FIELDS.filter((f) => r.locked?.includes(f)),
        extractedAt: r.extractedAt ?? '',
      })
    }
  }
  return out
}

/** 按月分组（YYYY-MM），保持原来的顺序 */
export function byMonth<T extends { date: string }>(rows: T[]): { month: string; rows: T[] }[] {
  const groups: { month: string; rows: T[] }[] = []
  for (const r of rows) {
    const m = r.date.slice(0, 7)
    const last = groups[groups.length - 1]
    if (last?.month === m) last.rows.push(r)
    else groups.push({ month: m, rows: [r] })
  }
  return groups
}

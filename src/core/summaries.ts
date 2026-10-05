/**
 * 总结文件（规格 4.5）：summaries/monthly/YYYY-MM.md、summaries/yearly/YYYY.md。
 * 与日记文件一样：front matter + Markdown，未知字段原样保留。
 * source_hash 是生成时所用内容的摘要，用来判断“源内容已变”。
 */
import { Document, isMap, isScalar, parseDocument, Pair, YAMLMap } from 'yaml'
import type { FileStore } from './types'
import { normalizeNewlines } from './entryFile'
import { sha256Hex } from './bytes'
import type { DiaryIndex } from './diaryIndex'
import { ROOT, type DiaryRepo } from './repo'

export type SummaryKind = 'monthly' | 'yearly'

export interface SummaryMeta {
  type: 'monthly-summary' | 'yearly-summary'
  period: string
  generated_at?: string
  model?: string
  /** 日记太多、分几段读完再合成时的段数（2026-10-04 加入；一次读完时不写） */
  parts?: number
  source_count?: number
  source_hash?: string
  locked?: boolean
  edited_at?: string
}

export interface SummaryDoc {
  meta: SummaryMeta
  body: string
  extra: Pair[]
}

const KNOWN = ['type', 'period', 'generated_at', 'model', 'parts', 'source_count', 'source_hash', 'locked', 'edited_at'] as const

export const kindOf = (period: string): SummaryKind => (/^\d{4}$/.test(period) ? 'yearly' : 'monthly')
export const summaryPath = (period: string) => `${ROOT}/summaries/${kindOf(period)}/${period}.md`

export function parseSummary(raw: string, period: string): SummaryDoc {
  const text = normalizeNewlines(raw)
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text)
  const meta: SummaryMeta = { type: kindOf(period) === 'yearly' ? 'yearly-summary' : 'monthly-summary', period }
  const extra: Pair[] = []
  if (!m) return { meta, body: text.trim(), extra }
  const doc = parseDocument(m[1])
  if (!doc.errors.length && isMap(doc.contents)) {
    for (const item of (doc.contents as YAMLMap).items) {
      const key = isScalar(item.key) ? String(item.key.value) : String(item.key)
      const v = (item.value as { toJSON?: () => unknown } | null)?.toJSON?.() ?? item.value
      if ((KNOWN as readonly string[]).includes(key)) (meta as unknown as Record<string, unknown>)[key] = v
      else extra.push(item as Pair)
    }
  }
  meta.period = String(meta.period ?? period)
  if (meta.source_count != null) meta.source_count = Number(meta.source_count)
  if (meta.parts != null) meta.parts = Number(meta.parts)
  meta.locked = meta.locked === true || (meta.locked as unknown) === 'true'
  return { meta, body: text.slice(m[0].length).trim(), extra }
}

export function serializeSummary(s: SummaryDoc): string {
  const doc = new Document()
  const map = new YAMLMap()
  const rec = s.meta as unknown as Record<string, unknown>
  for (const k of KNOWN) {
    const v = rec[k]
    if (v == null || v === '') continue
    map.items.push(new Pair(doc.createNode(k), doc.createNode(v)))
  }
  for (const p of s.extra) map.items.push(p)
  doc.contents = map as unknown as Document['contents']
  return `---\n${doc.toString({ lineWidth: 0 })}---\n\n${s.body.trim()}\n`
}

export async function readSummary(store: FileStore, period: string): Promise<SummaryDoc | null> {
  const raw = await store.readText(summaryPath(period))
  return raw == null ? null : parseSummary(raw, period)
}

export async function writeSummary(repo: DiaryRepo, s: SummaryDoc): Promise<void> {
  await repo.writeAtomic(summaryPath(s.meta.period), serializeSummary(s))
}

/** 某月日记的内容摘要：按日期排序后各篇文件哈希的哈希 */
export async function monthSourceHash(index: DiaryIndex, ym: string): Promise<{ hash: string; count: number }> {
  // 不让 AI 读的日记不算：切换这个设置后，总结会显示“源内容已变”
  const rows = index.month(Number(ym.slice(0, 4)), Number(ym.slice(5, 7))).filter((r) => !r.aiExclude).sort((a, b) => (a.date < b.date ? -1 : 1))
  return { hash: 'sha256:' + (await sha256Hex(rows.map((r) => `${r.date}:${r.hash}`).join('\n'))), count: rows.length }
}

/** 年度总结的来源：12 份月度总结的正文 */
export async function yearSourceHash(store: FileStore, year: string): Promise<{ hash: string; count: number }> {
  const parts: string[] = []
  for (let m = 1; m <= 12; m++) {
    const p = `${year}-${String(m).padStart(2, '0')}`
    const s = await readSummary(store, p)
    if (s) parts.push(`${p}:${await sha256Hex(s.body)}`)
  }
  return { hash: 'sha256:' + (await sha256Hex(parts.join('\n'))), count: parts.length }
}

export type SummaryStatus = 'fresh' | 'stale' | 'locked' | 'locked-stale' | 'missing'

export async function summaryStatus(store: FileStore, index: DiaryIndex, period: string): Promise<SummaryStatus> {
  const s = await readSummary(store, period)
  if (!s) return 'missing'
  const cur = kindOf(period) === 'monthly' ? await monthSourceHash(index, period) : await yearSourceHash(store, period)
  const stale = !!s.meta.source_hash && s.meta.source_hash !== cur.hash
  if (s.meta.locked) return stale ? 'locked-stale' : 'locked'
  return stale ? 'stale' : 'fresh'
}

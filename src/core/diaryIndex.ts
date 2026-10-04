/**
 * 本地索引（规格 4.7）。索引只是 diary/ 的派生缓存：存在 cache/index.json，
 * 删掉后可从文件完整重建。启动时按文件修改时间与大小做增量更新。
 */
import { isScalar } from 'yaml'
import type { FileStore, IndexRow, ListField } from './types'
import { parseEntry, plainText } from './entryFile'
import { DiaryRepo, entryPath, type EntryFile } from './repo'

export const INDEX_CACHE = 'cache/index.json'
const CACHE_VERSION = 3

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function rowFromRaw(f: EntryFile, raw: string): Promise<IndexRow> {
  const hash = await sha256(raw)
  try {
    const doc = parseEntry(raw, f.date)
    const m = doc.meta
    const test = doc.extra.some(
      (p) => isScalar(p.key) && p.key.value === 'test_data' && isScalar(p.value) && p.value.value === true,
    )
    return {
      date: f.date,
      path: f.path,
      mtime: f.mtime,
      size: f.size,
      hash,
      updated: m.updated,
      mood: m.mood,
      weather: m.weather
        ? [m.weather.text, m.weather.temp_c != null ? `${m.weather.temp_c}°` : ''].filter(Boolean).join(' ')
        : undefined,
      locationName: m.location?.name,
      lat: m.location?.lat,
      lng: m.location?.lng,
      tags: m.tags ?? [],
      people: m.people ?? [],
      places: m.places ?? [],
      text: plainText(doc.body),
      ...(m.ai?.extracted_at ? { extractedAt: String(m.ai.extracted_at) } : {}),
      ...(m.locked?.length ? { locked: m.locked } : {}),
      ...(test ? { test: true } : {}),
    }
  } catch (e) {
    return {
      date: f.date, path: f.path, mtime: f.mtime, size: f.size, hash,
      tags: [], people: [], places: [],
      text: raw.slice(0, 2000),
      error: (e as Error).message,
    }
  }
}

export interface SearchQuery {
  q?: string
  from?: string
  to?: string
  tags?: string[]
  people?: string[]
  places?: string[]
  moods?: number[]
}

export interface Segment {
  text: string
  hit: boolean
}

export interface SearchHit {
  row: IndexRow
  snippet: Segment[]
}

export class DiaryIndex {
  private rows = new Map<string, IndexRow>()
  private sorted: IndexRow[] | null = null

  constructor(private repo: DiaryRepo, private store: FileStore) {}

  get size(): number {
    return this.rows.size
  }

  /** 读取缓存，然后与 diary/ 中的文件逐一比对，只重新解析有变化的文件。返回重新解析的文件数。 */
  async load(): Promise<number> {
    this.rows.clear()
    this.sorted = null
    const cacheText = await this.store.readText(INDEX_CACHE).catch(() => null)
    if (cacheText) {
      try {
        const c = JSON.parse(cacheText)
        if (c.version === CACHE_VERSION) for (const r of c.rows as IndexRow[]) this.rows.set(r.date, r)
      } catch {
        /* 缓存损坏就当没有 */
      }
    }
    const files = await this.repo.listEntryFiles()
    const seen = new Set<string>()
    let changed = 0
    for (const f of files) {
      seen.add(f.date)
      const cached = this.rows.get(f.date)
      if (cached && cached.path === f.path && cached.mtime === f.mtime && cached.size === f.size) continue
      const raw = await this.store.readText(f.path)
      if (raw == null) continue
      this.rows.set(f.date, await rowFromRaw(f, raw))
      changed++
    }
    for (const d of Array.from(this.rows.keys())) {
      if (!seen.has(d)) {
        this.rows.delete(d)
        changed++
      }
    }
    if (changed || !cacheText) await this.saveCache()
    return changed
  }

  /** 设置里的“重建索引”：删掉缓存，从文件完整重建。 */
  async rebuild(): Promise<void> {
    await this.store.remove(INDEX_CACHE).catch(() => {})
    await this.load()
  }

  async saveCache(): Promise<void> {
    await this.store.mkdirp('cache')
    await this.store.writeText(
      INDEX_CACHE,
      JSON.stringify({ version: CACHE_VERSION, rows: Array.from(this.rows.values()) }),
    )
  }

  /**
   * 保存或删除某天的日记后调用，只刷新内存里的这一天。
   * 缓存文件不在这里写（编辑时每秒都会调用）；即使缓存落后，下次 load() 也会按修改时间自动补上。
   */
  async refresh(date: string): Promise<void> {
    const path = entryPath(date)
    const st = await this.store.stat(path)
    if (!st) this.rows.delete(date)
    else {
      const raw = await this.store.readText(path)
      if (raw != null) this.rows.set(date, await rowFromRaw({ path, date, mtime: st.mtime, size: st.size }, raw))
    }
    this.sorted = null
    this.dirty = true
  }

  /** 内存索引是否比缓存文件新 */
  dirty = false

  async saveCacheIfDirty(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await this.saveCache()
  }

  get(date: string): IndexRow | undefined {
    return this.rows.get(date)
  }

  /** 全部日记，日期倒序 */
  all(): IndexRow[] {
    if (!this.sorted) this.sorted = Array.from(this.rows.values()).sort((a, b) => (a.date < b.date ? 1 : -1))
    return this.sorted
  }

  month(year: number, month: number): IndexRow[] {
    const prefix = `${year}-${String(month).padStart(2, '0')}-`
    return this.all().filter((r) => r.date.startsWith(prefix))
  }

  /** 那年今日：往年同月同日的日记，最近的年份在前。2 月 29 日只匹配闰年。 */
  onThisDay(today: string): IndexRow[] {
    const md = today.slice(5)
    const year = today.slice(0, 4)
    return this.all().filter((r) => r.date.slice(5) === md && r.date.slice(0, 4) < year)
  }

  /** 某个列表字段的全部取值及出现天数，按天数降序 */
  values(field: ListField): { value: string; count: number }[] {
    const m = new Map<string, number>()
    for (const r of this.rows.values()) for (const v of r[field]) m.set(v, (m.get(v) ?? 0) + 1)
    return Array.from(m, ([value, count]) => ({ value, count })).sort(
      (a, b) => b.count - a.count || a.value.localeCompare(b.value, 'zh'),
    )
  }

  search(q: SearchQuery): SearchHit[] {
    const terms = (q.q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hits: SearchHit[] = []
    for (const r of this.all()) {
      if (q.from && r.date < q.from) continue
      if (q.to && r.date > q.to) continue
      if (q.moods?.length && (r.mood == null || !q.moods.includes(r.mood))) continue
      if (q.tags?.length && !q.tags.every((t) => r.tags.includes(t))) continue
      if (q.people?.length && !q.people.every((t) => r.people.includes(t))) continue
      if (q.places?.length && !q.places.every((t) => r.places.includes(t))) continue
      if (terms.length) {
        const textLower = r.text.toLowerCase()
        const metaLower = [...r.tags, ...r.people, ...r.places, r.locationName ?? ''].join('\n').toLowerCase()
        if (!terms.every((t) => textLower.includes(t) || metaLower.includes(t))) continue
      }
      hits.push({ row: r, snippet: makeSnippet(r.text, terms) })
    }
    return hits
  }

  /** 还没抽取过、或抽取后又改过的日记（规格 7.3） */
  needsExtraction(): IndexRow[] {
    return this.all().filter((r) => !r.error && needsExtraction(r))
  }

  testRows(): IndexRow[] {
    return this.all().filter((r) => r.test)
  }

  brokenRows(): IndexRow[] {
    return this.all().filter((r) => r.error)
  }
}

export function needsExtraction(r: Pick<IndexRow, 'extractedAt' | 'updated'>): boolean {
  if (!r.extractedAt) return true
  if (!r.updated) return false
  return Date.parse(r.updated) > Date.parse(r.extractedAt)
}

/** 命中片段：第一个命中词前后各约 40 字，并标出所有命中位置。 */
export function makeSnippet(text: string, terms: string[], radius = 40): Segment[] {
  const flat = text.replace(/\s+/g, ' ')
  const lower = flat.toLowerCase()
  let first = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i >= 0 && (first < 0 || i < first)) first = i
  }
  const start = first < 0 ? 0 : Math.max(0, first - radius)
  const end = Math.min(flat.length, (first < 0 ? 0 : first) + radius * 2)
  const piece = flat.slice(start, end)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  if (!terms.length) return [{ text: prefix + piece + suffix, hit: false }]
  const pl = piece.toLowerCase()
  const marks = new Array<boolean>(piece.length).fill(false)
  for (const t of terms) {
    let i = pl.indexOf(t)
    while (i >= 0) {
      for (let k = i; k < i + t.length; k++) marks[k] = true
      i = pl.indexOf(t, i + t.length)
    }
  }
  const segs: Segment[] = []
  if (prefix) segs.push({ text: prefix, hit: false })
  for (let i = 0; i < piece.length; ) {
    let j = i
    while (j < piece.length && marks[j] === marks[i]) j++
    segs.push({ text: piece.slice(i, j), hit: marks[i] })
    i = j
  }
  if (suffix) segs.push({ text: suffix, hit: false })
  return segs
}

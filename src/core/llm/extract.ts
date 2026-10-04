/**
 * 抽取地点、人物、标签（规格 7.3）。
 * - 提示词里附上已有词表（各取出现最多的前 200 个），要求优先复用已有写法；
 * - 只写不在 locked 里的字段，并更新 ai 块；
 * - AI 写回不更新 updated，所以写完后不会被当成“抽取后又改过”。
 */
import type { EntryDoc } from '../entryFile'
import type { DiaryIndex } from '../diaryIndex'
import type { DiaryRepo } from '../repo'
import type { ListField } from '../types'
import { LIST_FIELDS } from '../types'
import { isoLocal } from '../time'
import { chat, extractJson, type LlmConfig } from './client'

export type Extraction = Record<ListField, string[]>

export function vocabulary(index: DiaryIndex, n = 200): Extraction {
  return {
    places: index.values('places').slice(0, n).map((v) => v.value),
    people: index.values('people').slice(0, n).map((v) => v.value),
    tags: index.values('tags').slice(0, n).map((v) => v.value),
  }
}

const SYSTEM = `你从用户的一篇日记里抽取三类信息，只输出 JSON，不要任何解释：
{"places": [...], "people": [...], "tags": [...]}

- places：这一天实际去过的具体地方（店名、地名、场所），不包括只是提到或计划去的。
- people：日记里提到的具体的人（名字、称呼）。不要包括“我”。
- tags：1 到 3 个概括这一天的主题词，例如 工作、运动、读书、聚餐、旅行。
- 已有词表里有同一个地方或人的写法时，必须用已有写法，例如已有“老王烧烤”，日记写“去老王那吃烧烤”就填“老王烧烤”。
- 没有就给空数组。`

function clean(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x).trim()).filter((x) => x && x.length <= 40))].slice(0, 20)
}

export async function extractEntry(cfg: LlmConfig, doc: EntryDoc, vocab: Extraction): Promise<Extraction> {
  const user = `已有词表：
地点：${vocab.places.join('、') || '（无）'}
人物：${vocab.people.join('、') || '（无）'}
标签：${vocab.tags.join('、') || '（无）'}

日记（${doc.meta.date}）：
${doc.body}`
  const r = await chat(cfg, { system: SYSTEM, messages: [{ role: 'user', content: user }], maxTokens: 600, temperature: 0 })
  const j = extractJson<Record<string, unknown>>(r.text)
  if (!j) throw new Error('模型没有按要求返回 JSON')
  return { places: clean(j.places), people: clean(j.people), tags: clean(j.tags) }
}

/** 把抽取结果写进元数据（只写未锁定的字段）。返回实际写入的字段。 */
export function applyExtraction(doc: EntryDoc, x: Extraction, model: string, now = new Date()): ListField[] {
  const locked = new Set(doc.meta.locked ?? [])
  const written: ListField[] = []
  for (const f of LIST_FIELDS) {
    if (locked.has(f)) continue
    if (x[f].length) doc.meta[f] = x[f]
    else delete doc.meta[f]
    written.push(f)
  }
  doc.meta.ai = { ...(doc.meta.ai ?? {}), extracted_at: isoLocal(now), model, fields: written }
  return written
}

export async function extractAndSave(cfg: LlmConfig, repo: DiaryRepo, index: DiaryIndex, date: string, now = new Date()): Promise<ListField[]> {
  const doc = await repo.readEntry(date)
  if (!doc) return []
  const x = await extractEntry(cfg, doc, vocabulary(index))
  const written = applyExtraction(doc, x, cfg.model, now)
  await repo.saveEntry(doc, now, { touchUpdated: false })
  return written
}

export interface BatchState {
  running: boolean
  paused: boolean
  done: number
  total: number
  failed: { date: string; error: string }[]
}

/**
 * 批量抽取：并发 2，可暂停。待处理列表每次都从文件重新算出，所以中途被杀掉后重开会从未完成的继续。
 */
export async function runBatch(opts: {
  cfg: LlmConfig
  repo: DiaryRepo
  index: DiaryIndex
  dates: string[]
  state: BatchState
  onSaved: (date: string) => Promise<void>
  concurrency?: number
}): Promise<void> {
  const { state } = opts
  state.running = true
  state.paused = false
  state.done = 0
  state.total = opts.dates.length
  state.failed = []
  let next = 0
  const worker = async () => {
    while (next < opts.dates.length && !state.paused) {
      const date = opts.dates[next++]
      try {
        await extractAndSave(opts.cfg, opts.repo, opts.index, date)
        await opts.onSaved(date)
      } catch (e) {
        state.failed.push({ date, error: (e as Error).message })
        // 连续失败（例如 key 错了）就停下，免得白白请求
        if (state.failed.length >= 3 && state.done === 0) state.paused = true
      }
      state.done++
    }
  }
  try {
    await Promise.all(Array.from({ length: opts.concurrency ?? 2 }, worker))
  } finally {
    state.running = false
  }
}

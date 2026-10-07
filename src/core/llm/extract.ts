/**
 * 抽取地点、人物、标签（规格 7.4）。
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
import { chatJson, type LlmConfig } from './client'
import { EXTRACT_FORMAT, PROMPTS } from './prompts'

export type Extraction = Record<ListField, string[]>

export function vocabulary(index: DiaryIndex, n = 200): Extraction {
  return {
    places: index.values('places').slice(0, n).map((v) => v.value),
    people: index.values('people').slice(0, n).map((v) => v.value),
    tags: index.values('tags').slice(0, n).map((v) => v.value),
  }
}

/** 抽取结果的 JSON 结构（约束解码用） */
const SCHEMA = {
  type: 'object',
  properties: {
    places: { type: 'array', items: { type: 'string' } },
    people: { type: 'array', items: { type: 'string' } },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['places', 'people', 'tags'],
}

function clean(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x).trim()).filter((x) => x && x.length <= 40))].slice(0, 20)
}

/** rules：可编辑的提示词（设置里改过就传改过的），输出格式由代码接在后面 */
export async function extractEntry(cfg: LlmConfig, doc: EntryDoc, vocab: Extraction, rules: string = PROMPTS.extract.text): Promise<Extraction> {
  const user = `已有词表：
地点：${vocab.places.join('、') || '（无）'}
人物：${vocab.people.join('、') || '（无）'}
标签：${vocab.tags.join('、') || '（无）'}

日记（${doc.meta.date}）：
${doc.body}`
  const { value: j } = await chatJson<Record<string, unknown>>(cfg, {
    system: `${rules.trim()}\n\n${EXTRACT_FORMAT}`,
    messages: [{ role: 'user', content: user }],
    // 推理模型的思考也算在输出里，给少了会在写出 JSON 前就截断
    maxTokens: 2000,
    temperature: 0,
    json: { name: 'save_extraction', schema: SCHEMA },
  })
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

export async function extractAndSave(cfg: LlmConfig, repo: DiaryRepo, index: DiaryIndex, date: string, now = new Date(), rules?: string): Promise<ListField[]> {
  const doc = await repo.readEntry(date)
  if (!doc) return []
  const x = await extractEntry(cfg, doc, vocabulary(index), rules)
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
  /** 改过的抽取提示词 */
  rules?: string
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
        await extractAndSave(opts.cfg, opts.repo, opts.index, date, new Date(), opts.rules)
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

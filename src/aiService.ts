/** AI 的应用层：服务配置、首次发送确认、问答记录、批量抽取、总结、词表合并。 */
import { reactive } from 'vue'
import { diaryChanged, enqueue, index, refreshDate, repo, store, today } from './app'
import { prefs, type LlmProfile } from './prefs'
import { getSecret } from './platform/secrets'
import { AbortedError, parseExtraBody, type LlmConfig, type Usage } from './core/llm/client'
import { DiaryTools } from './core/llm/tools'
import { ask, systemPrompt, type Step } from './core/llm/agent'
import { extractEntry, runBatch, vocabulary, type BatchState, type Extraction } from './core/llm/extract'
import { generateMonthly, generateYearly } from './core/llm/summarize'
import { captionImage } from './core/llm/caption'
import { imageForAi } from './imageService'
import { mergeValues } from './core/vocab'
import type { ListField } from './core/types'

export type Task = 'chat' | 'extract' | 'summary' | 'caption'
export const TASK_LABEL: Record<Task, string> = { chat: '问答', extract: '抽取', summary: '总结', caption: '图片说明' }

export const tools = new DiaryTools(index, repo, store)

export function profileFor(task: Task): LlmProfile | null {
  const id = prefs.ai.use[task] || prefs.ai.profiles[0]?.id
  return prefs.ai.profiles.find((p) => p.id === id) ?? null
}

export async function configFor(task: Task): Promise<LlmConfig> {
  const p = profileFor(task)
  if (!p) throw new Error('还没有添加 AI 服务，请先到“设置 → AI 服务”里添加')
  return { ...profileConfig(p, await getSecret(`llm.${p.id}`)), instructions: notesFor(task) }
}

/** 设置里的数字：输入框清空或乱填时用默认值 */
export function int(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def
}

/** 共用的补充说明加上这项功能自己的 */
export function notesFor(task: Task): string {
  return [prefs.ai.notes, prefs.ai.taskNotes[task]].map((s) => s?.trim()).filter(Boolean).join('\n\n')
}

/** 服务配置（含高级设置）转成请求用的配置。额外参数写错时报错，免得悄悄被忽略。 */
export function profileConfig(p: LlmProfile, apiKey: string): LlmConfig {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  return {
    protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, apiKey,
    contextTokens: num(p.contextTokens),
    maxOutput: num(p.maxOutput),
    temperature: typeof p.temperature === 'number' && Number.isFinite(p.temperature) ? p.temperature : undefined,
    timeoutMs: num(p.timeoutSec) ? p.timeoutSec! * 1000 : undefined,
    extraBody: parseExtraBody(p.extraBody),
    stream: p.stream !== false,
  }
}

/** 第一次把日记发给某个服务前，说明会发什么（规格第 8 节） */
export function ensureConsent(task: Task): boolean {
  const p = profileFor(task)
  if (!p) return false
  if (prefs.ai.consented.includes(p.id)) return true
  let host = p.baseUrl
  try {
    host = new URL(p.baseUrl).host
  } catch { /* 保持原样 */ }
  const ok = window.confirm(
    `第一次使用「${p.name}」（${host}）。\n\n` +
      '问答时会发送你的问题以及工具查到的相关日记片段；抽取会发送单篇日记全文；总结会发送整月的日记；' +
      '图片说明会发送那张图片（缩小后）和这篇日记的开头。\n' +
      '这些内容会经过该服务商的服务器。确定继续吗？',
  )
  if (ok) prefs.ai.consented.push(p.id)
  return ok
}

// ---------- 问答记录：只存在本机（app 数据目录的 ai/ 下），不进 diary/，不同步 ----------

export interface ChatTurn {
  q: string
  a: string
  steps: Step[]
  dates: string[]
  error?: string
  at: number
  /** 调了几次模型、用了多少 token（旧记录没有） */
  usage?: Usage & { calls: number }
  /** 为了不超出上下文省略过内容 */
  compacted?: boolean
  /** 用户点了停止（a 里是停止前收到的部分） */
  stopped?: boolean
}

export interface Conversation {
  id: string
  title: string
  updatedAt: number
  turns: ChatTurn[]
}

const CHATS = 'ai/chats.json'
export const chats = reactive({ list: [] as Conversation[], loaded: false, currentId: '' })

export async function loadChats() {
  if (chats.loaded) return
  try {
    chats.list = JSON.parse((await store.readText(CHATS)) ?? '[]')
  } catch {
    chats.list = []
  }
  chats.loaded = true
}

async function saveChats() {
  chats.list.sort((a, b) => b.updatedAt - a.updatedAt)
  chats.list = chats.list.slice(0, 50)
  await store.mkdirp('ai')
  await store.writeText(CHATS, JSON.stringify(chats.list))
}

export function current(): Conversation | null {
  return chats.list.find((c) => c.id === chats.currentId) ?? null
}

export function newConversation() {
  chats.currentId = ''
}

export async function deleteConversation(id: string) {
  chats.list = chats.list.filter((c) => c.id !== id)
  if (chats.currentId === id) chats.currentId = ''
  await saveChats()
}

/** partial：流式输出中、这一轮已经收到的文字 */
export const asking = reactive({ busy: false, steps: [] as Step[], question: '', partial: '' })
let controller: AbortController | null = null

/** 停止正在进行的问答：已经收到的文字留下来 */
export function stopAsking() {
  controller?.abort()
}

export async function askQuestion(q: string): Promise<void> {
  if (asking.busy || !q.trim()) return
  if (!ensureConsent('chat')) return
  await loadChats()
  let conv = current()
  if (!conv) {
    conv = { id: `c${Date.now()}`, title: q.trim().slice(0, 30), updatedAt: Date.now(), turns: [] }
    chats.list.unshift(conv)
    chats.currentId = conv.id
  }
  Object.assign(asking, { busy: true, steps: [], question: q.trim(), partial: '' })
  controller = new AbortController()
  const all = index.aiRows()
  const turn: ChatTurn = { q: q.trim(), a: '', steps: [], dates: [], at: Date.now() }
  try {
    const r = await ask({
      cfg: await configFor('chat'),
      tools,
      question: q.trim(),
      history: conv.turns.filter((t) => !t.error).map((t) => ({ q: t.q, a: t.a })),
      system: systemPrompt(today(), all[all.length - 1]?.date ?? null, all[0]?.date ?? null, all.length),
      onStep: (s) => asking.steps.push(s),
      historyTurns: int(prefs.ai.chat.historyTurns, 10, 50, 10),
      maxRounds: int(prefs.ai.chat.maxRounds, 10, 30, 10),
      onRound: () => (asking.partial = ''),
      onText: (d) => (asking.partial += d),
      signal: controller.signal,
    })
    Object.assign(turn, { a: r.answer, steps: r.steps, dates: r.dates, usage: r.usage, ...(r.compacted ? { compacted: true } : {}) })
  } catch (e) {
    turn.steps = [...asking.steps]
    if (e instanceof AbortedError || controller?.signal.aborted) {
      turn.stopped = true
      turn.a = asking.partial.trim()
      turn.dates = [...new Set([...turn.a.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]))].sort()
    } else turn.error = (e as Error).message
  } finally {
    conv.turns.push(turn)
    conv.updatedAt = Date.now()
    controller = null
    Object.assign(asking, { busy: false, steps: [], question: '', partial: '' })
    await saveChats()
  }
}

// ---------- 图片说明 ----------

/** 让 AI 看图写一句说明。src 是正文里的图片路径；excerpt 是这篇日记正文（取开头作参考） */
export async function captionPreview(date: string, src: string, excerpt: string): Promise<string> {
  const cfg = await configFor('caption')
  return captionImage(cfg, await imageForAi(src), { date, excerpt })
}

// ---------- 抽取 ----------

/** 单篇抽取：只返回结果，由编辑页展示后确认写入 */
export async function extractPreview(date: string): Promise<{ x: Extraction; model: string }> {
  const cfg = await configFor('extract')
  const doc = await repo.readEntry(date)
  if (!doc) throw new Error('这一天还没有保存的日记')
  return { x: await extractEntry(cfg, doc, vocabulary(index)), model: cfg.model }
}

export const batch = reactive<BatchState>({ running: false, paused: false, done: 0, total: 0, failed: [] })

export async function startBatch() {
  if (batch.running || !ensureConsent('extract')) return
  const cfg = await configFor('extract')
  const dates = index.needsExtraction().map((r) => r.date)
  await runBatch({
    cfg, repo, index, dates, state: batch,
    concurrency: int(prefs.ai.extract.concurrency, 1, 4, 2),
    onSaved: (d) => refreshDate(d),
  })
  diaryChanged()
}

export function pauseBatch() {
  batch.paused = true
}

// ---------- 总结 ----------

export const summarizing = reactive({ period: '', message: '' })

export async function summarize(period: string): Promise<void> {
  if (summarizing.period || !ensureConsent('summary')) return
  summarizing.period = period
  summarizing.message = '正在写总结'
  try {
    const cfg = await configFor('summary')
    if (/^\d{4}$/.test(period)) await generateYearly(cfg, repo, index, store, period, (m) => (summarizing.message = m))
    else await generateMonthly(cfg, repo, index, period, new Date(), (m) => (summarizing.message = m))
    diaryChanged()
  } finally {
    summarizing.period = ''
    summarizing.message = ''
  }
}

// ---------- 词表 ----------

export async function merge(field: ListField, from: string[], to: string): Promise<number> {
  const n = await enqueue(() => mergeValues(repo, index, field, from, to, (d) => refreshDate(d)))
  diaryChanged()
  return n
}

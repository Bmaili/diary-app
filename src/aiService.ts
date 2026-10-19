/** AI 的应用层：服务配置、首次发送确认、问答记录、批量抽取、总结、词表合并。 */
import { chartRefs, type ChartData } from './core/llm/charts'
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
import { promptText, type PromptId } from './core/llm/prompts'
import { cleanCustom, DEFAULT_PERSONA, personaById, type CustomPersona, type Persona } from './core/llm/personas'
import { imageForAi } from './imageService'
import { mergeValues } from './core/vocab'
import type { ListField } from './core/types'
import { ask as askDialog } from './ui/dialog'
import { annotateEntry } from './core/llm/annotate'
import { annotationPath, parseAnnotation, serializeAnnotation, type Annotation } from './core/annotation'
import { isoLocal } from './core/time'
import { syncAfterEdit } from './syncService'
import { writePortrait } from './core/llm/portrait'
import { briefOf } from './core/answer'
import { buildBio } from './core/bio'

export type Task = 'chat' | 'extract' | 'summary' | 'caption' | 'annotate'
export const TASK_LABEL: Record<Task, string> = { chat: '问答', extract: '抽取', summary: '总结', caption: '图片说明', annotate: '朱批' }

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

/** 某项功能实际用的系统提示词（可编辑部分）：设置里改过就用改过的 */
export function prompt(id: PromptId): string {
  return promptText(id, prefs.ai.prompts)
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
export async function ensureConsent(task: Task): Promise<boolean> {
  const p = profileFor(task)
  if (!p) return false
  if (prefs.ai.consented.includes(p.id)) return true
  let host = p.baseUrl
  try {
    host = new URL(p.baseUrl).host
  } catch { /* 保持原样 */ }
  const ok = await askDialog({
    title: `第一次使用「${p.name}」`,
    message:
      `服务地址：${host}\n\n` +
      '问答时会发送你的问题以及工具查到的相关日记片段；抽取会发送单篇日记全文；总结会发送整月的日记；' +
      '图片说明会发送那张图片（缩小后）和这篇日记；朱批会发送你请批的那一篇；小传会发送提到那个人或地方的日记。这些内容会经过该服务商的服务器。',
    ok: '继续', cancel: '不用了',
  })
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
  /** 回答里引用到的图表数据（2026-10-12 加入，旧记录没有） */
  charts?: Record<string, ChartData>
  /** 这一句是哪个人物答的（2026-10-19 加入）：id 和当时的名字（自定义人物删了也能显示） */
  persona?: string
  personaName?: string
}

export interface Conversation {
  id: string
  title: string
  updatedAt: number
  turns: ChatTurn[]
  /** 这个对话现在由哪个人物陪聊（2026-10-19 加入；旧对话没有，用上次选的） */
  persona?: string
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

// ---------- 人物（规格 7.3，2026-10-19 加入） ----------

/** 现在陪聊的人物：打开着的对话用它自己的，新对话用上次选的 */
export function activePersona(): Persona {
  return personaById(current()?.persona ?? prefs.ai.chat.persona, prefs.ai.personas)
}

/** 换人物：记成下次的默认；打开着对话时从下一句开始换 */
export async function setPersona(id: string) {
  prefs.ai.chat.persona = id
  const c = current()
  if (c && c.persona !== id) {
    c.persona = id
    await saveChats()
  }
}

/** 保存一个自定义人物（新的加在最后）。返回保存后的样子；名字或说话的样子为空返回 null */
export function savePersona(p: CustomPersona): CustomPersona | null {
  const c = cleanCustom(p)
  if (!c) return null
  const i = prefs.ai.personas.findIndex((x) => x.id === c.id)
  if (i >= 0) prefs.ai.personas[i] = c
  else prefs.ai.personas.push(c)
  return c
}

/** 删掉自定义人物：正在用它的换回老友（对话记录里的名字留着） */
export async function removePersona(id: string) {
  prefs.ai.personas = prefs.ai.personas.filter((p) => p.id !== id)
  if (prefs.ai.chat.persona === id) prefs.ai.chat.persona = DEFAULT_PERSONA
  let changed = false
  for (const c of chats.list) {
    if (c.persona === id) {
      c.persona = DEFAULT_PERSONA
      changed = true
    }
  }
  if (changed) await saveChats()
}

export async function deleteConversation(id: string) {
  chats.list = chats.list.filter((c) => c.id !== id)
  if (chats.currentId === id) chats.currentId = ''
  await saveChats()
}

/** partial：流式输出中、这一轮已经收到的文字 */
export const asking = reactive({ busy: false, steps: [] as Step[], question: '', partial: '', charts: {} as Record<string, ChartData> })
let controller: AbortController | null = null

/** 停止正在进行的问答：已经收到的文字留下来 */
export function stopAsking() {
  controller?.abort()
}

export async function askQuestion(q: string): Promise<void> {
  if (asking.busy || !q.trim()) return
  if (!(await ensureConsent('chat'))) return
  await loadChats()
  let conv = current()
  if (!conv) {
    conv = { id: `c${Date.now()}`, title: q.trim().slice(0, 30), updatedAt: Date.now(), turns: [], persona: prefs.ai.chat.persona }
    chats.list.unshift(conv)
    chats.currentId = conv.id
  }
  Object.assign(asking, { busy: true, steps: [], question: q.trim(), partial: '', charts: {} })
  controller = new AbortController()
  const all = index.aiRows()
  const persona = personaById(conv.persona ?? prefs.ai.chat.persona, prefs.ai.personas)
  const turn: ChatTurn = { q: q.trim(), a: '', steps: [], dates: [], at: Date.now(), persona: persona.id, personaName: persona.name }
  try {
    const r = await ask({
      cfg: await configFor('chat'),
      tools,
      question: q.trim(),
      history: conv.turns.filter((t) => !t.error).map((t) => ({ q: t.q, a: t.a })),
      system: systemPrompt(today(), all[all.length - 1]?.date ?? null, all[0]?.date ?? null, all.length, prompt('chat'), persona),
      onStep: (s) => asking.steps.push(s),
      historyTurns: int(prefs.ai.chat.historyTurns, 10, 50, 10),
      maxRounds: int(prefs.ai.chat.maxRounds, 10, 30, 10),
      onRound: () => (asking.partial = ''),
      onText: (d) => (asking.partial += d),
      onChart: (id, c) => (asking.charts[id] = c),
      signal: controller.signal,
    })
    Object.assign(turn, {
      a: r.answer, steps: r.steps, dates: r.dates, usage: r.usage,
      ...(r.compacted ? { compacted: true } : {}), ...(r.charts ? { charts: r.charts } : {}),
    })
    // 收藏过的问题：记下这次问的时间和回答的第一句
    const pin = prefs.ai.pinned.find((p) => p.q === turn.q)
    if (pin) Object.assign(pin, { at: turn.at, brief: briefOf(r.answer) })
  } catch (e) {
    turn.steps = [...asking.steps]
    if (e instanceof AbortedError || controller?.signal.aborted) {
      turn.stopped = true
      turn.a = asking.partial.trim()
      turn.dates = [...new Set([...turn.a.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => m[1]))].sort()
      const used = chartRefs(turn.a).filter((id) => asking.charts[id])
      if (used.length) turn.charts = Object.fromEntries(used.map((id) => [id, asking.charts[id]]))
    } else turn.error = (e as Error).message
  } finally {
    conv.turns.push(turn)
    conv.updatedAt = Date.now()
    controller = null
    Object.assign(asking, { busy: false, steps: [], question: '', partial: '', charts: {} })
    await saveChats()
  }
}

// ---------- 图片说明 ----------

/** 让 AI 看图写一句说明。src 是正文里的图片路径；context 是附上的日记内容（core/imageCaption.ts 的 captionContext） */
export async function captionPreview(date: string, src: string, context: string): Promise<string> {
  const cfg = await configFor('caption')
  return captionImage(cfg, await imageForAi(src), { date, context }, prompt('caption'))
}

// ---------- 抽取 ----------

/** 单篇抽取：只返回结果，由编辑页展示后确认写入 */
export async function extractPreview(date: string): Promise<{ x: Extraction; model: string }> {
  const cfg = await configFor('extract')
  const doc = await repo.readEntry(date)
  if (!doc) throw new Error('这一天还没有保存的日记')
  return { x: await extractEntry(cfg, doc, vocabulary(index), prompt('extract')), model: cfg.model }
}

export const batch = reactive<BatchState>({ running: false, paused: false, done: 0, total: 0, failed: [] })

export async function startBatch() {
  if (batch.running || !(await ensureConsent('extract'))) return
  const cfg = await configFor('extract')
  const dates = index.needsExtraction().map((r) => r.date)
  await runBatch({
    cfg, repo, index, dates, state: batch, rules: prompt('extract'),
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
  if (summarizing.period) throw new Error(`正在写 ${summarizing.period} 的总结，等它写完再试`)
  // 没配服务时 configFor 会报错说明；用户在确认框里点了取消就什么都不做
  if (profileFor('summary') && !(await ensureConsent('summary'))) return
  summarizing.period = period
  summarizing.message = '正在写总结'
  try {
    const cfg = await configFor('summary')
    const prompts = { monthly: prompt('monthly'), monthlyPart: prompt('monthlyPart'), yearly: prompt('yearly') }
    if (/^\d{4}$/.test(period)) await generateYearly(cfg, repo, index, store, period, (m) => (summarizing.message = m), new Date(), prompts)
    else await generateMonthly(cfg, repo, index, period, new Date(), (m) => (summarizing.message = m), prompts)
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
  // 小传里 AI 写的几句跟着改名（合并时留第一个写法的）
  await loadPortraits()
  const old = from.map((v) => portraits.map[portraitKey(field, v)]).find(Boolean)
  let changed = false
  for (const v of from) if (v !== to && portraits.map[portraitKey(field, v)]) (delete portraits.map[portraitKey(field, v)], (changed = true))
  if (old && !portraits.map[portraitKey(field, to)]) (portraits.map[portraitKey(field, to)] = old, (changed = true))
  if (changed) await savePortraits()
  return n
}

// ---------- 朱批 ----------

/** 这一天的批语；没有或文件坏了返回 null（坏文件不动它） */
export async function loadAnnotation(date: string): Promise<Annotation | null> {
  const raw = await store.readText(annotationPath(date))
  if (raw == null) return null
  try {
    const a = parseAnnotation(raw, date)
    return a.text ? a : null
  } catch {
    return null
  }
}

/** 请 AI 批这一篇（avoid：换一句时上一句的内容）。写进 diary/annotations/ 并返回 */
export async function requestAnnotation(date: string, avoid?: string): Promise<Annotation> {
  const cfg = await configFor('annotate')
  const doc = await repo.readEntry(date)
  if (!doc) throw new Error('这一天还没有保存的日记')
  if (doc.meta.ai_exclude) throw new Error('这篇设了不让 AI 读')
  const text = await annotateEntry(cfg, doc, prompt('annotate'), avoid)
  const old = await loadAnnotation(date)
  const a: Annotation = { date, created: isoLocal(new Date()), model: cfg.model, text, extra: old?.extra ?? [] }
  await enqueue(async () => {
    await store.mkdirp(annotationPath(date).replace(/\/[^/]+$/, ''))
    await repo.writeAtomic(annotationPath(date), serializeAnnotation(a))
  })
  syncAfterEdit()
  return a
}

/** 删去批语（AI 写的，随时可以再请，所以直接删文件；云端的在下次同步时删掉） */
export async function deleteAnnotation(date: string): Promise<void> {
  await enqueue(() => store.remove(annotationPath(date)).catch(() => {}))
  syncAfterEdit()
}

// ---------- 常问的问题 ----------

export const PIN_MAX = 6

export function isPinned(q: string): boolean {
  return prefs.ai.pinned.some((p) => p.q === q.trim())
}

/** 收藏或取消收藏一个问题。收藏时带上这次回答的第一句 */
export function togglePin(q: string, answer?: string, at?: number): boolean {
  const t = q.trim()
  const i = prefs.ai.pinned.findIndex((p) => p.q === t)
  if (i >= 0) {
    prefs.ai.pinned.splice(i, 1)
    return false
  }
  if (prefs.ai.pinned.length >= PIN_MAX) prefs.ai.pinned.pop()
  prefs.ai.pinned.unshift({ q: t, ...(at ? { at } : {}), ...(answer ? { brief: briefOf(answer) } : {}) })
  return true
}

// ---------- 小传：AI 写的几句，只存在本机（ai/portraits.json），不进 diary/，不同步 ----------

export interface Portrait {
  text: string
  model: string
  at: number
  /** 写的时候一共写到几天 */
  total: number
}

const PORTRAITS = 'ai/portraits.json'
export const portraits = reactive({ map: {} as Record<string, Portrait>, loaded: false })
export const portraitKey = (field: ListField, value: string) => `${field}:${value}`

export async function loadPortraits() {
  if (portraits.loaded) return
  try {
    portraits.map = JSON.parse((await store.readText(PORTRAITS)) ?? '{}') ?? {}
  } catch {
    portraits.map = {}
  }
  portraits.loaded = true
}

async function savePortraits() {
  await store.mkdirp('ai')
  await store.writeText(PORTRAITS, JSON.stringify(portraits.map))
}

/** 请 AI 写几句。只读 AI 能读的日记（ai_exclude 的跳过） */
export async function requestPortrait(field: ListField, value: string): Promise<Portrait> {
  await loadPortraits()
  const cfg = await configFor('summary')
  const bio = buildBio(index.aiRows(), field, value)
  if (!bio.days.length) throw new Error('提到它的日记都设了不让 AI 读')
  const entries = []
  for (const d of bio.days) {
    const doc = await repo.readEntry(d.date).catch(() => null)
    entries.push({ date: d.date, text: doc?.body ?? index.get(d.date)?.text ?? '', ...(d.mood ? { mood: d.mood } : {}) })
  }
  const r = await writePortrait(cfg, { field, value, entries, total: bio.days.length, first: bio.first!, last: bio.last! }, prompt('portrait'))
  const p: Portrait = { text: r.text, model: cfg.model, at: Date.now(), total: bio.days.length }
  portraits.map[portraitKey(field, value)] = p
  await savePortraits()
  return p
}

export async function deletePortrait(field: ListField, value: string): Promise<void> {
  await loadPortraits()
  delete portraits.map[portraitKey(field, value)]
  await savePortraits()
}

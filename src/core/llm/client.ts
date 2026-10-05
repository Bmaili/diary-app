/**
 * LLM 客户端（规格 7.1）：同一套接口对接 OpenAI 兼容协议（DeepSeek、通义千问、Kimi、智谱、OpenAI 等）与 Anthropic 协议。
 * 两种协议的工具调用格式不同（规格 10.3）：
 * - OpenAI：assistant 消息带 tool_calls，arguments 是 JSON 字符串；结果用 role=tool 的消息回传。
 * - Anthropic：assistant 内容块里有 tool_use（input 是对象）；结果放在 user 消息的 tool_result 块里。
 */
import { AbortedError, http, httpStream } from '../http'

export { AbortedError }

export interface LlmConfig {
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  apiKey: string
  /** 用户在设置里写的补充说明（关于自己、称呼、偏好），附加在系统提示后面 */
  instructions?: string
  /** 以下是服务的高级设置，留空时按各功能的默认值 */
  /** 模型的上下文长度（tokens），问答据此控制每次发送的内容量 */
  contextTokens?: number
  /** 最大输出 tokens，设置后覆盖各功能的默认值（推理模型的思考也算在里面，需要调大） */
  maxOutput?: number
  /** 温度，设置后覆盖各功能的默认值（有的推理模型只接受固定温度） */
  temperature?: number
  timeoutMs?: number
  /** 合并进请求体的额外参数，例如 {"enable_thinking": false} */
  extraBody?: Record<string, unknown>
  /** 问答是否流式输出，默认开 */
  stream?: boolean
}

export const DEFAULT_CONTEXT_TOKENS = 64000

/** 解析“额外参数”输入框：空串为 undefined，不是 JSON 对象时抛错 */
export function parseExtraBody(text: string | undefined): Record<string, unknown> | undefined {
  const t = text?.trim()
  if (!t) return undefined
  let v: unknown
  try {
    v = JSON.parse(t)
  } catch {
    throw new Error('额外参数不是合法的 JSON')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('额外参数要是一个 JSON 对象，例如 {"enable_thinking": false}')
  for (const k of ['model', 'messages', 'system', 'tools']) if (k in (v as object)) throw new Error(`额外参数里不能有 ${k}`)
  return v as Record<string, unknown>
}

/** 把用户补充说明接在系统提示后面。格式要求写在前面并声明优先，避免用户说明打乱 JSON 输出。 */
export function withInstructions(system: string, instructions?: string): string {
  const extra = instructions?.trim()
  if (!extra) return system
  return `${system}\n\n以下是用户提供的背景和偏好，供你理解日记内容和调整表达。若与上面的输出格式要求冲突，以上面的要求为准：\n<user_notes>\n${extra.slice(0, 4000)}\n</user_notes>`
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** 参数不是合法 JSON 时的原文 */
  badArgs?: string
}

/** 随消息发送的图片（base64，不带 data: 前缀），用于看图写描述 */
export interface ImagePart {
  mime: string
  data: string
}

export type ChatMsg =
  | { role: 'user'; content: string; images?: ImagePart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ChatRequest {
  system: string
  messages: ChatMsg[]
  tools?: ToolDef[]
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
  /** 给了就用流式请求，边收边回调文字片段（服务不支持时自动退回普通请求） */
  onText?: (delta: string) => void
  /** 停止生成 */
  signal?: AbortSignal
}

export interface Usage {
  input: number
  output: number
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  stop: string
  /** 服务返回的 token 用量；有的服务不返回 */
  usage?: Usage
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export function openaiUrl(base: string): string {
  const b = base.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`
}

export function anthropicUrl(base: string): string {
  const b = (base.trim() || 'https://api.anthropic.com').replace(/\/+$/, '')
  if (/\/messages$/.test(b)) return b
  return /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`
}

function errorMessage(status: number, body: string): string {
  let detail = ''
  try {
    const j = JSON.parse(body)
    detail = j?.error?.message ?? j?.message ?? j?.error ?? ''
    if (typeof detail !== 'string') detail = JSON.stringify(detail)
  } catch {
    detail = body.slice(0, 200)
  }
  const hint: Record<number, string> = {
    400: '请求被拒绝，可能是模型名不对或不支持工具调用',
    401: 'API Key 不对',
    402: '账户余额不足',
    403: '没有权限使用这个模型',
    404: '接口地址或模型名不对',
    429: '请求太频繁或额度用完了，稍后再试',
  }
  if ((status === 400 || status === 413) && /context|too long|maximum.*token|token.*(limit|exceed)|input length|超出.*(长度|上下文)/i.test(detail)) {
    return `发送的内容超出了模型的上下文长度。请在 AI 服务的高级设置里把“上下文长度”调小一些，或者把问题的时间范围缩小（${detail}）`
  }
  return `${hint[status] ?? `服务返回 ${status}`}${detail ? `（${detail}）` : ''}`
}

function parseArgs(raw: unknown): { args: Record<string, unknown>; bad?: string } {
  if (raw && typeof raw === 'object') return { args: raw as Record<string, unknown> }
  if (typeof raw !== 'string' || !raw.trim()) return { args: {} }
  try {
    const v = JSON.parse(raw)
    return { args: v && typeof v === 'object' ? v : {} }
  } catch {
    return { args: {}, bad: raw }
  }
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  let res
  try {
    res = await http({ url, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), timeoutMs })
  } catch (e) {
    throw new LlmError((e as Error).message)
  }
  if (!res.ok) throw new LlmError(errorMessage(res.status, res.text()), res.status)
  try {
    return res.json()
  } catch {
    throw new LlmError('服务返回的不是 JSON，接口地址可能不对')
  }
}

interface Prepared {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function prepareOpenAI(cfg: LlmConfig, req: ChatRequest): Prepared {
  const messages: unknown[] = [{ role: 'system', content: withInstructions(req.system, cfg.instructions) }]
  for (const m of req.messages) {
    if (m.role === 'user') {
      messages.push({
        role: 'user',
        content: m.images?.length
          ? [...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })), { type: 'text', text: m.content }]
          : m.content,
      })
    } else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: m.content || (m.toolCalls?.length ? null : ''),
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.badArgs ?? JSON.stringify(c.args) } })) }
          : {}),
      })
    } else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
  }
  const body: Record<string, unknown> = { model: cfg.model, messages }
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    body.tool_choice = 'auto'
  }
  const maxTokens = cfg.maxOutput || req.maxTokens
  if (maxTokens) body.max_tokens = maxTokens
  const temperature = cfg.temperature ?? req.temperature
  if (temperature != null) body.temperature = temperature
  Object.assign(body, cfg.extraBody)
  return { url: openaiUrl(cfg.baseUrl), headers: { Authorization: `Bearer ${cfg.apiKey}` }, body }
}

type OpenAIData = {
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function parseOpenAI(data: OpenAIData): ChatResult {
  const choice = data.choices?.[0]
  if (!choice?.message) throw new LlmError('服务没有返回回答')
  const toolCalls = (choice.message.tool_calls ?? []).map((c, i) => {
    const p = parseArgs(c.function?.arguments)
    return { id: c.id || `call_${i}`, name: c.function?.name ?? '', args: p.args, ...(p.bad ? { badArgs: p.bad } : {}) }
  })
  const u = data.usage
  return {
    text: choice.message.content ?? '', toolCalls, stop: choice.finish_reason ?? '',
    ...(u?.prompt_tokens != null ? { usage: { input: u.prompt_tokens, output: u.completion_tokens ?? 0 } } : {}),
  }
}

function prepareAnthropic(cfg: LlmConfig, req: ChatRequest): Prepared {
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content.push(block)
    else messages.push({ role, content: [block] })
  }
  for (const m of req.messages) {
    if (m.role === 'user') {
      for (const i of m.images ?? []) push('user', { type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })
      push('user', { type: 'text', text: m.content })
    } else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args })
    } else push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content })
  }
  const body: Record<string, unknown> = {
    model: cfg.model, max_tokens: cfg.maxOutput || req.maxTokens || 4096, system: withInstructions(req.system, cfg.instructions), messages,
  }
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  const temperature = cfg.temperature ?? req.temperature
  if (temperature != null) body.temperature = temperature
  Object.assign(body, cfg.extraBody)
  return {
    url: anthropicUrl(cfg.baseUrl),
    headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body,
  }
}

type AnthropicUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
const anthropicInput = (u: AnthropicUsage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

function parseAnthropic(data: {
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]
  stop_reason?: string
  usage?: AnthropicUsage
}): ChatResult {
  const blocks = data.content ?? []
  const u = data.usage
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, args: parseArgs(b.input).args })),
    stop: data.stop_reason ?? '',
    ...(u?.input_tokens != null ? { usage: { input: anthropicInput(u), output: u.output_tokens ?? 0 } } : {}),
  }
}

function timeoutOf(cfg: LlmConfig, req: ChatRequest): number {
  return cfg.timeoutMs || req.timeoutMs || 120000
}

async function chatOnce(cfg: LlmConfig, req: ChatRequest): Promise<ChatResult> {
  const anthropic = cfg.protocol === 'anthropic'
  const p = anthropic ? prepareAnthropic(cfg, req) : prepareOpenAI(cfg, req)
  const data = await post(p.url, p.headers, p.body, timeoutOf(cfg, req))
  return anthropic ? parseAnthropic(data as never) : parseOpenAI(data as OpenAIData)
}

// ---------- 流式（SSE） ----------

/** 这次运行里发现不支持流式（或不认 stream_options）的服务，之后不再尝试 */
const noStream = new Set<string>()
const noStreamOptions = new Set<string>()
const keyOf = (cfg: LlmConfig) => `${cfg.protocol} ${cfg.baseUrl} ${cfg.model}`

/** 流式请求被服务拒绝（参数不认识等），可以退回普通请求 */
class StreamRejected extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail)
  }
}

/** SSE 解析器：逐行喂进去，最后得到和普通请求一样的结果 */
export function sseParser(protocol: 'openai' | 'anthropic', onText?: (d: string) => void) {
  let text = ''
  let stop = ''
  let usage: Usage | undefined
  let error = ''
  let events = 0
  const raw: string[] = []
  const oaCalls: { id: string; name: string; args: string }[] = []
  const anBlocks: { type: string; id?: string; name?: string; json: string }[] = []
  const emit = (d: string) => {
    if (!d) return
    text += d
    onText?.(d)
  }
  return {
    line(line: string) {
      if (!line.startsWith('data:')) {
        if (line && !line.startsWith('event:') && !line.startsWith(':') && !line.startsWith('id:') && !line.startsWith('retry:')) raw.push(line)
        return
      }
      const d = line.slice(5).trim()
      if (!d || d === '[DONE]') return
      let j: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        j = JSON.parse(d)
      } catch {
        return
      }
      events++
      if (j.error) {
        error = typeof j.error === 'string' ? j.error : j.error.message ?? JSON.stringify(j.error)
        return
      }
      if (protocol === 'openai') {
        const ch = j.choices?.[0]
        const delta = ch?.delta ?? {}
        if (typeof delta.content === 'string') emit(delta.content)
        for (const tc of delta.tool_calls ?? []) {
          const i = typeof tc.index === 'number' ? tc.index : oaCalls.length
          oaCalls[i] ??= { id: '', name: '', args: '' }
          if (tc.id) oaCalls[i].id = tc.id
          if (tc.function?.name) oaCalls[i].name += tc.function.name
          if (tc.function?.arguments) oaCalls[i].args += tc.function.arguments
        }
        if (ch?.finish_reason) stop = ch.finish_reason
        if (j.usage?.prompt_tokens != null) usage = { input: j.usage.prompt_tokens, output: j.usage.completion_tokens ?? 0 }
      } else {
        switch (j.type) {
          case 'message_start':
            if (j.message?.usage) usage = { input: anthropicInput(j.message.usage), output: j.message.usage.output_tokens ?? 0 }
            break
          case 'content_block_start':
            anBlocks[j.index] = { type: j.content_block?.type, id: j.content_block?.id, name: j.content_block?.name, json: '' }
            if (j.content_block?.type === 'text' && j.content_block.text) emit(j.content_block.text)
            break
          case 'content_block_delta':
            if (j.delta?.type === 'text_delta') emit(j.delta.text ?? '')
            else if (j.delta?.type === 'input_json_delta' && anBlocks[j.index]) anBlocks[j.index].json += j.delta.partial_json ?? ''
            break
          case 'message_delta':
            if (j.delta?.stop_reason) stop = j.delta.stop_reason
            if (j.usage?.output_tokens != null) usage = { input: usage?.input ?? 0, output: j.usage.output_tokens }
            break
        }
      }
    },
    result(): ChatResult {
      if (error) throw new LlmError(`服务返回错误（${error}）`)
      if (!events) {
        // 服务没理会 stream 参数，直接返回了普通 JSON
        const body = raw.join('\n').trim()
        let data: unknown
        try {
          data = JSON.parse(body)
        } catch {
          throw new LlmError('服务返回的不是 JSON，接口地址可能不对')
        }
        const r = protocol === 'anthropic' ? parseAnthropic(data as never) : parseOpenAI(data as OpenAIData)
        if (r.text) onText?.(r.text)
        return r
      }
      const toolCalls: ToolCall[] = protocol === 'openai'
        ? oaCalls.filter(Boolean).map((c, i) => {
          const p = parseArgs(c.args)
          return { id: c.id || `call_${i}`, name: c.name, args: p.args, ...(p.bad ? { badArgs: p.bad } : {}) }
        })
        : anBlocks.filter((b) => b?.type === 'tool_use').map((b) => {
          const p = parseArgs(b.json || '{}')
          return { id: b.id!, name: b.name!, args: p.args, ...(p.bad ? { badArgs: p.bad } : {}) }
        })
      return { text, toolCalls, stop, ...(usage ? { usage } : {}) }
    },
  }
}

async function chatStream(cfg: LlmConfig, req: ChatRequest, withOptions: boolean): Promise<ChatResult> {
  const anthropic = cfg.protocol === 'anthropic'
  const p = anthropic ? prepareAnthropic(cfg, req) : prepareOpenAI(cfg, req)
  p.body.stream = true
  if (!anthropic && withOptions) p.body.stream_options = { include_usage: true }
  const parser = sseParser(cfg.protocol, req.onText)
  const ms = timeoutOf(cfg, req)
  let res
  try {
    res = await httpStream(
      { url: p.url, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...p.headers }, body: JSON.stringify(p.body), timeoutMs: ms, signal: req.signal },
      (l) => parser.line(l),
    )
  } catch (e) {
    if (e instanceof AbortedError) throw e
    throw new LlmError((e as Error).message)
  }
  if (!res.ok) {
    if ([400, 404, 405, 415, 422].includes(res.status)) throw new StreamRejected(res.status, res.errorText)
    throw new LlmError(errorMessage(res.status, res.errorText), res.status)
  }
  return parser.result()
}

export function chat(cfg: LlmConfig, req: ChatRequest): Promise<ChatResult> {
  if (!cfg.apiKey) return Promise.reject(new LlmError('还没有填 API Key'))
  if (!cfg.model) return Promise.reject(new LlmError('还没有填模型名'))
  const key = keyOf(cfg)
  if (!req.onText || cfg.stream === false || noStream.has(key)) {
    return chatOnce(cfg, req).then((r) => {
      if (r.text) req.onText?.(r.text)
      return r
    })
  }
  const fallback = async (): Promise<ChatResult> => {
    noStream.add(key)
    const r = await chatOnce(cfg, req)
    if (r.text) req.onText?.(r.text)
    return r
  }
  return chatStream(cfg, req, !noStreamOptions.has(key)).catch(async (e) => {
    if (!(e instanceof StreamRejected)) throw e
    // 有的服务不认识 stream_options：去掉它再试一次流式
    if (cfg.protocol === 'openai' && !noStreamOptions.has(key) && /stream_options/i.test(e.detail)) {
      noStreamOptions.add(key)
      return chatStream(cfg, req, false).catch((e2) => (e2 instanceof StreamRejected ? fallback() : Promise.reject(e2)))
    }
    return fallback()
  })
}

/** 测试用：清掉“不支持流式”的记录 */
export function resetStreamMemory() {
  noStream.clear()
  noStreamOptions.clear()
}

/** “测试”按钮：带一个工具发请求，确认连得上、并且模型会调用工具（问答必须支持工具调用） */
export async function testConfig(cfg: LlmConfig): Promise<{ toolCalling: boolean; reply: string }> {
  const r = await chat({ ...cfg, instructions: undefined }, {
    system: '你是连接测试助手。',
    messages: [{ role: 'user', content: '请调用 get_time 工具查询当前时间。' }],
    tools: [{ name: 'get_time', description: '返回当前时间', parameters: { type: 'object', properties: {}, required: [] } }],
    maxTokens: 200,
    timeoutMs: 60000,
  })
  return { toolCalling: r.toolCalls.some((c) => c.name === 'get_time'), reply: r.text }
}

/** 从模型输出里取出 JSON（容忍 ```json 代码块和前后的说明文字） */
export function extractJson<T>(text: string): T | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = [fenced?.[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]
  for (const c of candidates) {
    if (!c) continue
    try {
      return JSON.parse(c.trim()) as T
    } catch { /* 试下一个 */ }
  }
  return null
}

export interface Preset {
  name: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  hint: string
}

/** 预置模板只填接口地址，模型名由用户填（规格 7.1） */
export const PRESETS: Preset[] = [
  { name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', hint: '模型名以服务商控制台为准' },
  { name: '通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: '模型名以服务商控制台为准' },
  { name: 'Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', hint: '模型名以服务商控制台为准' },
  { name: '智谱', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', hint: '模型名以服务商控制台为准' },
  { name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', hint: '模型名以服务商控制台为准' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', hint: '模型名以服务商控制台为准' },
  { name: '自定义', protocol: 'openai', baseUrl: '', hint: '任何兼容 OpenAI 接口的服务，例如自建的中转' },
]

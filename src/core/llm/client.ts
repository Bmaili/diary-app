/**
 * LLM 客户端（规格 7.1）：同一套接口对接 OpenAI 兼容协议（DeepSeek、通义千问、Kimi、智谱、OpenAI 等）与 Anthropic 协议。
 * 两种协议的工具调用格式不同（规格 10.3）：
 * - OpenAI：assistant 消息带 tool_calls，arguments 是 JSON 字符串；结果用 role=tool 的消息回传。
 * - Anthropic：assistant 内容块里有 tool_use（input 是对象）；结果放在 user 消息的 tool_result 块里。
 */
import { http } from '../http'

export interface LlmConfig {
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  apiKey: string
  /** 用户在设置里写的补充说明（关于自己、称呼、偏好），附加在系统提示后面 */
  instructions?: string
}

/** 把用户补充说明接在系统提示后面。格式要求写在前面并声明优先，避免用户说明打乱 JSON 输出。 */
export function withInstructions(system: string, instructions?: string): string {
  const extra = instructions?.trim()
  if (!extra) return system
  return `${system}\n\n以下是用户提供的背景和偏好，供你理解日记内容和调整表达。若与上面的输出格式要求冲突，以上面的要求为准：\n<user_notes>\n${extra.slice(0, 2000)}\n</user_notes>`
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

export type ChatMsg =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ChatRequest {
  system: string
  messages: ChatMsg[]
  tools?: ToolDef[]
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
  stop: string
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

async function chatOpenAI(cfg: LlmConfig, req: ChatRequest): Promise<ChatResult> {
  const messages: unknown[] = [{ role: 'system', content: withInstructions(req.system, cfg.instructions) }]
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content })
    else if (m.role === 'assistant') {
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
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.temperature != null) body.temperature = req.temperature
  const data = (await post(openaiUrl(cfg.baseUrl), { Authorization: `Bearer ${cfg.apiKey}` }, body, req.timeoutMs ?? 120000)) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[]
  }
  const choice = data.choices?.[0]
  if (!choice?.message) throw new LlmError('服务没有返回回答')
  const toolCalls = (choice.message.tool_calls ?? []).map((c, i) => {
    const p = parseArgs(c.function?.arguments)
    return { id: c.id || `call_${i}`, name: c.function?.name ?? '', args: p.args, ...(p.bad ? { badArgs: p.bad } : {}) }
  })
  return { text: choice.message.content ?? '', toolCalls, stop: choice.finish_reason ?? '' }
}

async function chatAnthropic(cfg: LlmConfig, req: ChatRequest): Promise<ChatResult> {
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content.push(block)
    else messages.push({ role, content: [block] })
  }
  for (const m of req.messages) {
    if (m.role === 'user') push('user', { type: 'text', text: m.content })
    else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content })
      for (const c of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.args })
    } else push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content })
  }
  const body: Record<string, unknown> = { model: cfg.model, max_tokens: req.maxTokens ?? 4096, system: withInstructions(req.system, cfg.instructions), messages }
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  if (req.temperature != null) body.temperature = req.temperature
  const data = (await post(
    anthropicUrl(cfg.baseUrl),
    { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body,
    req.timeoutMs ?? 120000,
  )) as { content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason?: string }
  const blocks = data.content ?? []
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id!, name: b.name!, args: parseArgs(b.input).args })),
    stop: data.stop_reason ?? '',
  }
}

export function chat(cfg: LlmConfig, req: ChatRequest): Promise<ChatResult> {
  if (!cfg.apiKey) return Promise.reject(new LlmError('还没有填 API Key'))
  if (!cfg.model) return Promise.reject(new LlmError('还没有填模型名'))
  return cfg.protocol === 'anthropic' ? chatAnthropic(cfg, req) : chatOpenAI(cfg, req)
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

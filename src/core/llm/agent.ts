/** 问答的工具调用循环（规格 7.2）：默认最多 10 轮，发送量按模型的上下文长度控制。 */
import { AbortedError, chat, DEFAULT_CONTEXT_TOKENS, withInstructions, type ChatMsg, type LlmConfig, type Usage } from './client'
import { TOOL_DEFS, type DiaryTools } from './tools'

export interface Step {
  tool: string
  args: Record<string, unknown>
  summary: string
}

export interface AskResult {
  answer: string
  steps: Step[]
  /** 回答里出现的日期，界面上可点开 */
  dates: string[]
  /** 这个问题一共调了几次模型、用了多少 token（服务不返回用量时为 0） */
  usage: Usage & { calls: number }
  /** 为了不超出上下文，省略或截断过内容 */
  compacted?: boolean
}

export function systemPrompt(today: string, first: string | null, last: string | null, total: number): string {
  return `你是用户的私人日记助手，帮他回顾和理解自己写下的日记。

今天是 ${today}。日记共 ${total} 篇${first ? `，最早 ${first}，最近 ${last}` : ''}。

工作方式：
- 先用工具查，再回答。不要凭印象编造日记里没有的内容。
- 所有数字（次数、天数、篇数）必须来自工具结果，不要自己数。问“去过几次”“见过几次”时：先用 list_values 找出这个地点或人在元数据里的各种写法，再把这些写法和可能的简称一起交给 count_days，同时匹配元数据和正文。
- 统计单位是“天”：同一天去两次算一次，回答时说明这一点。
- 如果 count_days 返回的 unextracted_in_range 大于 0，说明还有日记没做过 AI 抽取，部分结果只来自正文匹配，可能有遗漏或误判，要在回答里提一句。
- 问几年、一整年这类大跨度的问题时，先用 get_summaries 读总结；缺失的期间再用 search_entries 或 get_entries 补充。
- 日期写成 YYYY-MM-DD。回答的最后单起一行，以“相关日期：”开头列出引用到的日期（太多时列最有代表性的不超过 20 个）。
- 用中文回答，简洁、具体，像朋友帮你翻日记，不要说教。`
}

const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/g

function describe(tool: string, args: Record<string, unknown>, result: unknown): string {
  const r = result as Record<string, unknown>
  switch (tool) {
    case 'get_stats': return `看了一下日记概况（${r.total} 篇）`
    case 'list_values': return `查了${({ places: '地点', people: '人物', tags: '标签' } as Record<string, string>)[String(args.field)] ?? ''}词表${args.query ? `里的“${args.query}”` : ''}，找到 ${r.total} 个`
    case 'count_days': return `统计了 ${(args.terms as string[] | undefined)?.map((t) => `“${t}”`).join('、')}：${r.days} 天`
    case 'search_entries': return `搜索“${args.query ?? ''}”：${r.total} 篇`
    case 'get_entries': return `读了 ${r.returned} 篇日记`
    case 'get_summaries': return `读了 ${(r.summaries as unknown[] | undefined)?.length ?? 0} 份${args.kind === 'yearly' ? '年度' : '月度'}总结`
    default: return tool
  }
}

/** 粗估 token 数：汉字约 1 个，其他字符约 2.5 个一个。宁可估多，不要估少。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x2e80) cjk++
  return Math.ceil(cjk + (text.length - cjk) / 2.5)
}

function msgTokens(m: ChatMsg): number {
  const calls = m.role === 'assistant' && m.toolCalls?.length ? JSON.stringify(m.toolCalls) : ''
  return estimateTokens(m.content) + estimateTokens(calls) + 8
}

export const OMITTED = '{"omitted":"这是较早的查询结果，为了不超出上下文已省略。需要的话用更小的范围重新调用工具。"}'

/**
 * 让消息总量不超过预算（规格 7.2，2026-10-04 加入）。依次：
 * 1. 从最早的开始，把模型已经看过的工具结果换成一句“已省略”（工具消息本身要保留，协议要求每个调用都有结果）；
 * 2. 丢掉最早的历史问答；
 * 3. 还超就截断最长的那条工具结果。
 * 返回是否动过消息。
 */
export function fitContext(messages: ChatMsg[], budget: number, historyLen: number): { changed: boolean; history: number } {
  let total = messages.reduce((a, m) => a + msgTokens(m), 0)
  let changed = false
  let history = historyLen
  if (total <= budget) return { changed, history }
  // 最新一批工具结果模型还没看过，不整条省略，留到第 3 步截断
  let lastCall = -1
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.toolCalls?.length) lastCall = i
  })
  for (const m of messages.slice(0, Math.max(0, lastCall))) {
    if (total <= budget) break
    if (m.role === 'tool' && m.content.length > OMITTED.length * 2) {
      total -= msgTokens(m)
      m.content = OMITTED
      total += msgTokens(m)
      changed = true
    }
  }
  while (total > budget && history > 0) {
    const [q, a] = messages.splice(0, 2)
    total -= msgTokens(q) + msgTokens(a)
    history -= 2
    changed = true
  }
  if (total > budget) {
    const tools = messages.filter((m): m is Extract<ChatMsg, { role: 'tool' }> => m.role === 'tool')
    const big = tools.sort((x, y) => y.content.length - x.content.length)[0]
    if (big) {
      const over = total - budget
      // 按最保守的比例（1 字 1 token）换算要砍掉的字数
      const keep = Math.max(200, big.content.length - over - 100)
      big.content = `${big.content.slice(0, keep)}…（结果太长，后面的已截断。请缩小日期范围或减少条数再查）`
      changed = true
    }
  }
  return { changed, history }
}

export async function ask(opts: {
  cfg: LlmConfig
  tools: DiaryTools
  question: string
  /** 之前的问答（只含文字，不含工具往来） */
  history: { q: string; a: string }[]
  system: string
  onStep?: (s: Step) => void
  maxRounds?: number
  /** 带上最近几轮问答，默认 10 */
  historyTurns?: number
  /** 流式输出：每一轮开始时调用 onRound（界面清掉上一轮的半截文字），收到文字片段时调用 onText */
  onRound?: () => void
  onText?: (delta: string) => void
  signal?: AbortSignal
}): Promise<AskResult> {
  const messages: ChatMsg[] = []
  const turns = opts.historyTurns ?? 10
  for (const h of turns > 0 ? opts.history.slice(-turns) : []) {
    messages.push({ role: 'user', content: h.q })
    messages.push({ role: 'assistant', content: h.a })
  }
  let historyLen = messages.length
  messages.push({ role: 'user', content: opts.question })
  const steps: Step[] = []
  const usage: Usage = { input: 0, output: 0 }
  let calls = 0
  let compacted = false
  const rounds = opts.maxRounds ?? 10
  const maxOut = opts.cfg.maxOutput || 2048
  const fixed = estimateTokens(withInstructions(opts.system, opts.cfg.instructions)) + estimateTokens(JSON.stringify(TOOL_DEFS))
  const budget = Math.max(2000, (opts.cfg.contextTokens || DEFAULT_CONTEXT_TOKENS) - maxOut - fixed - 1000)
  const used = () => messages.reduce((a, m) => a + msgTokens(m), 0)
  const done = (answer: string, dates: string[]): AskResult => ({
    answer, steps, dates, usage: { ...usage, calls }, ...(compacted ? { compacted } : {}),
  })
  for (let i = 0; i < rounds; i++) {
    const last = i === rounds - 1
    const fit = fitContext(messages, budget, historyLen)
    historyLen = fit.history
    compacted ||= fit.changed
    if (opts.signal?.aborted) throw new AbortedError()
    opts.onRound?.()
    const r = await chat(opts.cfg, {
      system: opts.system, messages, tools: last ? undefined : TOOL_DEFS, maxTokens: 2048, onText: opts.onText, signal: opts.signal,
    })
    calls++
    if (r.usage) {
      usage.input += r.usage.input
      usage.output += r.usage.output
    }
    if (!r.toolCalls.length) {
      const dates = [...new Set([...r.text.matchAll(DATE_RE)].map((m) => m[1]))].sort()
      return done(r.text.trim(), dates)
    }
    messages.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls })
    for (const c of r.toolCalls) {
      let result: unknown
      // 读原文时按剩余预算限制字数（按 1 字 1 token 保守换算，留一半给后续）
      const args = c.name === 'get_entries'
        ? { ...c.args, max_chars: Math.min(Number(c.args.max_chars) || 12000, Math.max(2000, Math.floor((budget - used()) / 2))) }
        : c.args
      try {
        result = c.badArgs != null ? { error: `参数不是合法的 JSON：${c.badArgs.slice(0, 200)}` } : await opts.tools.run(c.name, args)
      } catch (e) {
        result = { error: (e as Error).message }
      }
      const step = { tool: c.name, args: c.args, summary: describe(c.name, c.args, result) }
      steps.push(step)
      opts.onStep?.(step)
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: JSON.stringify(result) })
    }
  }
  return done('查了很多轮还没有得出结论，换个更具体的问法试试。', [])
}

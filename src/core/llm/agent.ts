/** 问答的工具调用循环（规格 7.2）：最多 10 轮。 */
import { chat, type ChatMsg, type LlmConfig } from './client'
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

export async function ask(opts: {
  cfg: LlmConfig
  tools: DiaryTools
  question: string
  /** 之前的问答（只含文字，不含工具往来） */
  history: { q: string; a: string }[]
  system: string
  onStep?: (s: Step) => void
  maxRounds?: number
}): Promise<AskResult> {
  const messages: ChatMsg[] = []
  for (const h of opts.history.slice(-6)) {
    messages.push({ role: 'user', content: h.q })
    messages.push({ role: 'assistant', content: h.a })
  }
  messages.push({ role: 'user', content: opts.question })
  const steps: Step[] = []
  const rounds = opts.maxRounds ?? 10
  for (let i = 0; i < rounds; i++) {
    const last = i === rounds - 1
    const r = await chat(opts.cfg, { system: opts.system, messages, tools: last ? undefined : TOOL_DEFS, maxTokens: 2048 })
    if (!r.toolCalls.length) {
      const dates = [...new Set([...r.text.matchAll(DATE_RE)].map((m) => m[1]))].sort()
      return { answer: r.text.trim(), steps, dates }
    }
    messages.push({ role: 'assistant', content: r.text, toolCalls: r.toolCalls })
    for (const c of r.toolCalls) {
      let result: unknown
      try {
        result = c.badArgs != null ? { error: `参数不是合法的 JSON：${c.badArgs.slice(0, 200)}` } : await opts.tools.run(c.name, c.args)
      } catch (e) {
        result = { error: (e as Error).message }
      }
      const step = { tool: c.name, args: c.args, summary: describe(c.name, c.args, result) }
      steps.push(step)
      opts.onStep?.(step)
      messages.push({ role: 'tool', toolCallId: c.id, name: c.name, content: JSON.stringify(result) })
    }
  }
  return { answer: '查了很多轮还没有得出结论，换个更具体的问法试试。', steps, dates: [] }
}

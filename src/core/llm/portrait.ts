/**
 * 小传里“请 AI 写几句”（2026-10-15 加入，规格 7.7）：把提到这个人（地方、标签）的日记发给模型，写两三句。
 * 数字由代码算好放进消息里，模型只负责写。格式要求在 PORTRAIT_FIXED（代码附加，用户改不掉）。
 */
import { chatText, LlmError, type LlmConfig } from './client'
import { PORTRAIT_FIXED, PROMPTS } from './prompts'
import type { ListField } from '../types'

export interface PortraitInput {
  field: ListField
  value: string
  /** 提到它的日子（AI 能读的），新的在前；text 是正文 */
  entries: { date: string; text: string; mood?: number }[]
  /** 一共几天、第一次和最近一次 */
  total: number
  first: string
  last: string
}

const KIND: Record<ListField, string> = { people: '人', places: '地方', tags: '主题' }
const MOODS = ['很差', '不好', '一般', '不错', '很好']

/**
 * 发给模型的内容：按新到旧放日记，每篇最多 per 个字，总共不超过 budget 个字。
 * 篇数多时隔几篇取一篇，让各个时期都有。
 */
export function portraitMessage(p: PortraitInput, budget = 14000, per = 500): { text: string; used: number } {
  let list = p.entries
  const avg = list.reduce((n, e) => n + Math.min(per, e.text.length) + 30, 0)
  if (avg > budget) {
    const keep = Math.max(1, Math.floor((list.length * budget) / avg))
    const step = list.length / keep
    list = Array.from({ length: keep }, (_, i) => list[Math.floor(i * step)])
  }
  const lines = [
    `要写的${KIND[p.field]}：${p.value}`,
    `日记里一共写到 ${p.total} 天，第一次是 ${p.first}，最近一次是 ${p.last}。下面是其中 ${list.length} 天的日记（新的在前，长的截断了）：`,
    '',
  ]
  let used = 0
  for (const e of list) {
    const t = e.text.replace(/\s+/g, ' ').trim()
    const body = t.length > per ? `${t.slice(0, per)}…` : t
    lines.push(`【${e.date}${e.mood ? ` 心情${MOODS[e.mood - 1]}` : ''}】${body}`)
    used++
  }
  return { text: lines.join('\n'), used }
}

export function cleanPortrait(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[#>*\-\s]+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^[“"「]+|[”"」]+$/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export async function writePortrait(cfg: LlmConfig, p: PortraitInput, rules: string = PROMPTS.portrait.text): Promise<{ text: string; used: number }> {
  const budget = cfg.contextTokens ? Math.max(4000, Math.min(30000, Math.floor(cfg.contextTokens * 0.6))) : 14000
  const m = portraitMessage(p, budget)
  const r = await chatText(cfg, {
    system: `${rules.trim()}\n\n${PORTRAIT_FIXED}`,
    messages: [{ role: 'user', content: m.text }],
    maxTokens: 1200,
    temperature: 0.7,
  })
  const text = cleanPortrait(r.text)
  if (!text) throw new LlmError('模型没有写出内容')
  return { text, used: m.used }
}

/**
 * 灯下首屏、输入框上面的一句问候（2026-10-19 加入，规格 7.3）。纯函数，不调模型。
 *
 * 三处来的句子，按份额抽：
 * - 人物自己的口吻，按早上 / 白天 / 傍晚 / 夜里分开（personas.ts），55%；自定义人物没有这一份；
 * - 节令：节日节气、七十二候、时辰、交节（hints.ts 的 seasonalLines，去掉催人写的），30%；
 * - 你的日记：“两年前的今天，你在西湖。”这类（diaryFacts.ts，规则和首页小提示一样），15%。
 * 没有素材的那一份让给其他的。avoid 是首页正在显示的那句小提示，不重复。
 * 换句节奏和首页小提示共用一个种子（hintService.ts），再加上人物：换了人物，问候跟着换。
 */
import { hash, seasonalLines, slotOf } from './hints'
import { greetingLines, greetSlot } from './llm/personas'

export interface GreetingContext {
  persona: string
  date: string
  now: Date
  cutoffHour?: number
  seed: string
  /** diaryFacts(...).personal；设置里关了“小提示引用日记”时传空 */
  personal?: string[]
  avoid?: string
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pickGreeting(c: GreetingContext): string {
  const r = rng(hash(`greet|${c.seed}|${c.persona}`))
  const not = (lines: string[]) => lines.filter((t) => t && t !== c.avoid)
  const layers = [
    { w: 0.55, lines: not(greetingLines(c.persona, greetSlot(slotOf(c.now.getHours(), c.cutoffHour)))) },
    { w: 0.3, lines: not(seasonalLines(c.date, c.now, c.cutoffHour)) },
    { w: 0.15, lines: not(c.personal ?? []) },
  ].filter((l) => l.lines.length)
  if (!layers.length) return '灯下坐坐，想聊点什么？'
  let x = r() * layers.reduce((t, l) => t + l.w, 0)
  const layer = layers.find((l) => (x -= l.w) < 0) ?? layers[layers.length - 1]
  return layer.lines[Math.floor(r() * layer.lines.length)]
}

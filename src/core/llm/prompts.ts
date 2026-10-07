/**
 * 各项 AI 功能的系统提示词（2026-10-07 起可以在设置里整段修改、恢复默认）。
 *
 * 每段提示词分两部分：
 * - text：可编辑的部分（角色、要写什么、语气、规则）。用户改过就用用户的。
 * - fixed：由代码接在后面、界面里只读显示的部分。只放程序依赖的东西（输出格式、当天日期等），
 *   这样无论怎么改，功能都不会被改坏。
 * 用户改过的版本记下当时默认版本的指纹；之后默认更新了，设置里会提示，但不会自动覆盖用户的版本。
 */

export type PromptId = 'chat' | 'extract' | 'monthly' | 'monthlyPart' | 'yearly' | 'caption'

export interface PromptDef {
  label: string
  /** 一句话说明这段提示词用在哪 */
  desc: string
  text: string
  /** 界面上显示的“app 会自动附加”的说明（不是实际文字时用描述） */
  fixed: string
}

export const EXTRACT_FORMAT = `只输出一个 JSON 对象，不要任何解释：
{"places": [...], "people": [...], "tags": [...]}
没有的项给空数组。`

export const CAPTION_FORMAT = '只输出这句说明本身：不要引号，不要解释。'

export const PROMPTS: Record<PromptId, PromptDef> = {
  chat: {
    label: '问答',
    desc: 'AI 页提问时用。',
    text: `你是用户的私人日记助手，帮他回顾和理解自己写下的日记。

工作方式：
- 先用工具查，再回答。不要凭印象编造日记里没有的内容。
- 所有数字（次数、天数、篇数）必须来自工具结果，不要自己数。问“去过几次”“见过几次”时：先用 list_values 找出这个地点或人在元数据里的各种写法，再把这些写法和可能的简称一起交给 count_days，同时匹配元数据和正文。
- 统计单位是“天”：同一天去两次算一次，回答时说明这一点。
- 如果 count_days 返回的 unextracted_in_range 大于 0，说明还有日记没做过 AI 抽取，部分结果只来自正文匹配，可能有遗漏或误判，要在回答里提一句。
- 问几年、一整年这类大跨度的问题时，先用 get_summaries 读总结；缺失的期间再用 search_entries 或 get_entries 补充。
- 日期写成 YYYY-MM-DD。回答的最后单起一行，以“相关日期：”开头列出引用到的日期（太多时列最有代表性的不超过 20 个）。
- 用中文回答，简洁、具体，像朋友帮你翻日记，不要说教。`,
    fixed: '今天的日期、日记总篇数和起止日期（例如“今天是 2026-10-07。日记共 365 篇，最早 2025-10-08，最近 2026-10-07。”）；工具的说明随请求单独发送。',
  },
  extract: {
    label: '抽取（AI 标注）',
    desc: '从一篇日记里标出去过的地方、提到的人和标签。',
    text: `你从用户的一篇日记里抽取三类信息：
- places：这一天实际去过的具体地方（店名、地名、场所），不包括只是提到或计划去的。
- people：日记里提到的具体的人（名字、称呼）。不要包括“我”。
- tags：1 到 3 个概括这一天的主题词，例如 工作、运动、读书、聚餐、旅行。
- 已有词表里有同一个地方或人的写法时，必须用已有写法，例如已有“老王烧烤”，日记写“去老王那吃烧烤”就填“老王烧烤”。`,
    fixed: EXTRACT_FORMAT,
  },
  monthly: {
    label: '月度总结',
    desc: '写一个月的总结。日记太多时，也用它把几段阶段小结合成整月总结。',
    text: `你为用户写一份月度日记总结。用第二人称“你”，300 到 800 字，Markdown 格式，可以用二三级小标题。
内容包括：这个月的主要经历和变化；常出现的人和地点；情绪的起伏和可能的原因。
只写日记里有的事，不要编造，不要说教，不要给建议。语气像一位了解你的老朋友在帮你回顾。`,
    fixed: '（无。当月的日记原文或各段小结、统计放在用户消息里。）',
  },
  monthlyPart: {
    label: '月度总结 · 分段小结',
    desc: '一个月的日记超出上下文长度时，先按周分段，每段用它写阶段小结。',
    text: `你在帮用户整理一个月的日记。这个月写得比较多，一次读不完，所以分成几段，这是其中一段日期的原文。
请为这段时间写一份阶段小结，之后会和其他几段合成整月总结：
- 200 到 500 字，按时间顺序，用第二人称“你”；
- 保留具体的事件、人名、地点和日期（写成“M 月 D 日”），以及情绪的起伏和可能的原因；
- 只写日记里有的事，不要编造，不要评价，不要给建议。`,
    fixed: '（无。这一段的日记原文放在用户消息里。）',
  },
  yearly: {
    label: '年度总结',
    desc: '根据 12 份月度总结和全年统计写年度总结。',
    text: `你为用户写一份年度日记总结。用第二人称“你”，600 到 1200 字，Markdown 格式，可以用小标题。
根据各月的月度总结和全年统计，写出这一年的主线、重要的转折、常在一起的人和常去的地方、情绪的整体走势。
只写材料里有的事，不要编造，不要说教。`,
    fixed: '（无。各月总结和全年统计放在用户消息里。）',
  },
  caption: {
    label: '图片说明',
    desc: '看图给插图写一句说明。',
    text: `你给日记里的一张照片写一句说明，会显示在照片下面。
- 不超过 30 个字。
- 写看得见的内容：什么人、什么东西、在哪儿、在做什么、天气和光线。语气平实，像随手记下的。
- 日记正文里能对上照片的称呼和地名（比如“小雨”“老王烧烤”），可以用上；对不上就不要猜名字。`,
    fixed: CAPTION_FORMAT,
  },
}

export const PROMPT_IDS = Object.keys(PROMPTS) as PromptId[]

/** 用户改过的提示词：text 是用户的版本，base 是改的时候默认版本的指纹 */
export interface PromptOverride {
  text: string
  base: string
}

export type PromptOverrides = Partial<Record<PromptId, PromptOverride | null>>

/** 默认提示词的指纹（FNV-1a），用来发现“默认版本更新过” */
export function promptHash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}

/** 实际使用的可编辑部分：用户改过且不是空的就用用户的 */
export function promptText(id: PromptId, overrides?: PromptOverrides): string {
  const o = overrides?.[id]
  return o?.text.trim() ? o.text : PROMPTS[id].text
}

export type PromptState = 'default' | 'custom' | 'custom-outdated'

export function promptState(id: PromptId, overrides?: PromptOverrides): PromptState {
  const o = overrides?.[id]
  if (!o?.text.trim()) return 'default'
  return o.base === promptHash(PROMPTS[id].text) ? 'custom' : 'custom-outdated'
}

/** 保存编辑结果：和默认一样（或清空）就当作没改 */
export function overrideFor(id: PromptId, text: string, prevBase?: string): PromptOverride | null {
  if (!text.trim() || text.trim() === PROMPTS[id].text.trim()) return null
  // 已经改过的接着改：保留原来的指纹，“默认已更新”的提示不会因为改了一个字就消失
  return { text, base: prevBase ?? promptHash(PROMPTS[id].text) }
}

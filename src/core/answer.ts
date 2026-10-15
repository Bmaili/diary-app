/**
 * 问答回答的后处理（2026-10-15 加入，规格 7.3）。都是纯函数，界面层只负责把结果画出来。
 *
 * - 提到的日子：回答末尾“相关日期：…”那一行拿出来，改画成日记小笺；没有这一行时用正文里出现的日期。
 * - 原文引文：模型按 QUOTE_RULES 把原句写成引用块。代码逐字核对——在那一天（或任何一篇 AI 能读的日记）的
 *   正文里找得到才排成引文，找不到就当普通文字，免得把模型编的话当成你写过的。
 * - 人名地名：回答里出现词表里的人和地点，第一次出现处可以点开小传。
 */

const DATE = /\d{4}-\d{2}-\d{2}/g

/** 拆出“相关日期”那一行。dates 按出现顺序去重 */
export function splitRelated(md: string): { body: string; dates: string[] } {
  const lines = md.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l) continue
    const m = /^(?:\*\*)?相关日期(?:\*\*)?\s*[：:]/.exec(l)
    if (!m) break
    const dates = [...new Set(l.match(DATE) ?? [])]
    return { body: lines.slice(0, i).join('\n').trimEnd(), dates }
  }
  return { body: md, dates: [] }
}

/** 小笺要列的日子：有“相关日期”用它，没有就用正文里出现的日期（按先后） */
export function answerDates(md: string): string[] {
  const { body, dates } = splitRelated(md)
  return dates.length ? dates : [...new Set(body.match(DATE) ?? [])]
}

/** 核对引文用的规范化：去掉空白、引号和书名号以外的标记符号，全角半角标点统一 */
export function normQuote(s: string): string {
  return s
    .replace(/[\s　]+/g, '')
    .replace(/[“”"「」『』‘’'`*_~#>]/g, '')
    .replace(/，/g, ',').replace(/。/g, '.').replace(/！/g, '!').replace(/？/g, '?').replace(/：/g, ':').replace(/；/g, ';')
    .replace(/（/g, '(').replace(/）/g, ')')
}

/**
 * 引文在原文里找不找得到：按省略号分段，每段（去掉首尾标点后至少 2 个字）都要按顺序出现在原文里。
 */
export function quoteFound(quote: string, source: string): boolean {
  const src = normQuote(source)
  const parts = quote
    .split(/……|\.\.\.|…/)
    .map((p) => normQuote(p).replace(/^[,.!?:;、]+|[,.!?:;、]+$/g, ''))
    .filter((p) => p.length > 0)
  if (!parts.length || parts.join('').length < 4) return false
  let from = 0
  for (const p of parts) {
    if (p.length < 2) continue
    const i = src.indexOf(p, from)
    if (i < 0) return false
    from = i + p.length
  }
  return true
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 处理回答里的引用块（连续的“> ”行）：最后一行是“—— YYYY-MM-DD”时是那一天的引文。
 * find(text, date?) 返回找到原文的那一天（找不到返回 null）。
 * 找得到：换成 <blockquote class="yin">…<cite>日子</cite></blockquote>；找不到：去掉引用格式，当普通段落。
 */
export function markQuotes(md: string, find: (text: string, date?: string) => string | null, dayLabel: (date: string) => string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    if (!/^\s{0,3}>/.test(lines[i])) {
      out.push(lines[i++])
      continue
    }
    const block: string[] = []
    while (i < lines.length && /^\s{0,3}>/.test(lines[i])) block.push(lines[i++].replace(/^\s{0,3}>\s?/, ''))
    let date: string | undefined
    const last = block[block.length - 1]?.trim() ?? ''
    const cite = /^(?:——|--|—|－－|-)\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(last)
    if (cite) {
      date = cite[1]
      block.pop()
    }
    const text = block.join('\n').trim().replace(/^[“"「]+|[”"」]+$/g, '').trim()
    if (!text) continue
    const day = find(text, date)
    if (day) {
      out.push(`<blockquote class="yin"><p>“${esc(text).replace(/\n+/g, '<br>')}”</p><cite><a href="#/entry/${day}">${esc(dayLabel(day))}</a></cite></blockquote>`, '')
    } else {
      // 不是原文：去掉引用格式，按普通文字显示
      out.push(text, '')
    }
  }
  return out.join('\n')
}

/**
 * 回答（已渲染的 HTML）里第一次出现的人名、地名换成可点的链接。
 * 只看标签之外的文字，不碰已经在链接、代码、标题里的；长名字优先，免得“西湖”抢了“西湖边茶馆”。
 */
export function linkNames(html: string, names: { field: 'people' | 'places'; value: string }[]): string {
  const list = names
    .filter((n) => n.value.trim().length >= 2 && !/[<>&"]/.test(n.value))
    .sort((a, b) => b.value.length - a.value.length)
  if (!list.length) return html
  const used = new Set<string>()
  const parts = html.split(/(<[^>]+>)/)
  let skip = 0
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]
    if (p.startsWith('<')) {
      const m = /^<(\/?)(a|code|pre|h[1-6]|cite)\b/i.exec(p)
      if (m) skip += m[1] ? -1 : 1
      continue
    }
    if (skip > 0 || !p) continue
    // 先找出这一段里每个名字第一次出现的位置，互不重叠
    const hits: { at: number; len: number; n: (typeof list)[number] }[] = []
    for (const n of list) {
      if (used.has(n.value)) continue
      let at = p.indexOf(n.value)
      while (at >= 0 && hits.some((h) => at < h.at + h.len && h.at < at + n.value.length)) at = p.indexOf(n.value, at + 1)
      if (at < 0) continue
      hits.push({ at, len: n.value.length, n })
      used.add(n.value)
    }
    if (!hits.length) continue
    hits.sort((a, b) => a.at - b.at)
    let s = ''
    let from = 0
    for (const h of hits) {
      s += p.slice(from, h.at) + `<a href="#/who/${h.n.field}/${encodeURIComponent(h.n.value)}" class="who">${p.slice(h.at, h.at + h.len)}</a>`
      from = h.at + h.len
    }
    parts[k] = s + p.slice(from)
  }
  return parts.join('')
}

/** 收藏的问题上次答了什么：回答第一句，去掉 Markdown，最多 n 个字 */
export function briefOf(answer: string, n = 26): string {
  const { body } = splitRelated(answer)
  const plain = body
    .replace(/\[\[chart:[^\]]*\]\]/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/[#*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const first = /^[^。！？!?\n]+[。！？!?]?/.exec(plain)?.[0] ?? plain
  return first.length > n ? `${first.slice(0, n)}…` : first
}

const CN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const cnSmall = (n: number) => (n < 10 ? CN[n] : n < 20 ? `十${n % 10 ? CN[n % 10] : ''}` : `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ''}`)

/** 小笺、引文上的日子：今年的写“九月八日”，别的年份前面加年份“二〇二五年九月八日” */
export function cnDay(date: string, thisYear: string): string {
  const md = `${cnSmall(Number(date.slice(5, 7)))}月${cnSmall(Number(date.slice(8, 10)))}日`
  const y = date.slice(0, 4)
  return y === thisYear ? md : `${[...y].map((d) => CN[Number(d)]).join('')}年${md}`
}

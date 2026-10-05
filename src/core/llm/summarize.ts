/** 月度与年度总结（规格 7.4）。 */
import type { DiaryIndex } from '../diaryIndex'
import type { DiaryRepo } from '../repo'
import type { FileStore } from '../types'
import { isoLocal } from '../time'
import {
  monthSourceHash, readSummary, writeSummary, yearSourceHash, type SummaryDoc,
} from '../summaries'
import { chat, DEFAULT_CONTEXT_TOKENS, withInstructions, type LlmConfig } from './client'
import { estimateTokens } from './agent'

const MOOD = ['很差', '不好', '一般', '不错', '很好']

const MONTH_SYSTEM = `你为用户写一份月度日记总结。用第二人称“你”，300 到 800 字，Markdown 格式，可以用二三级小标题。
内容包括：这个月的主要经历和变化；常出现的人和地点；情绪的起伏和可能的原因。
只写日记里有的事，不要编造，不要说教，不要给建议。语气像一位了解你的老朋友在帮你回顾。`

const YEAR_SYSTEM = `你为用户写一份年度日记总结。用第二人称“你”，600 到 1200 字，Markdown 格式，可以用小标题。
根据各月的月度总结和全年统计，写出这一年的主线、重要的转折、常在一起的人和常去的地方、情绪的整体走势。
只写材料里有的事，不要编造，不要说教。`

/** 一篇日记在总结输入里的样子：日期、元数据一行、正文 */
async function entryBlock(repo: DiaryRepo, date: string, fallback: string): Promise<string> {
  const doc = await repo.readEntry(date).catch(() => null)
  const m = doc?.meta
  const meta = [
    m?.mood ? `心情：${MOOD[m.mood - 1]}` : '',
    m?.weather?.text ? `天气：${m.weather.text}` : '',
    m?.location?.name || m?.location?.address ? `地点：${m.location?.name ?? m.location?.address}` : '',
    m?.people?.length ? `人物：${m.people.join('、')}` : '',
    m?.places?.length ? `去过：${m.places.join('、')}` : '',
    m?.tags?.length ? `标签：${m.tags.join('、')}` : '',
  ].filter(Boolean).join('；')
  return `## ${date}${meta ? `\n（${meta}）` : ''}\n${doc?.body ?? fallback}`
}

const PART_SYSTEM = `你在帮用户整理一个月的日记。这个月写得比较多，一次读不完，所以分成几段，这是其中一段日期的原文。
请为这段时间写一份阶段小结，之后会和其他几段合成整月总结：
- 200 到 500 字，按时间顺序，用第二人称“你”；
- 保留具体的事件、人名、地点和日期（写成“M 月 D 日”），以及情绪的起伏和可能的原因；
- 只写日记里有的事，不要编造，不要评价，不要给建议。`

export function monthStats(index: DiaryIndex, ym: string): string {
  const rows = index.month(Number(ym.slice(0, 4)), Number(ym.slice(5, 7))).filter((r) => !r.aiExclude)
  const moods = [0, 0, 0, 0, 0]
  for (const r of rows) if (r.mood) moods[r.mood - 1]++
  const top = (field: 'places' | 'people' | 'tags') => {
    const c = new Map<string, number>()
    for (const r of rows) for (const v of r[field]) c.set(v, (c.get(v) ?? 0) + 1)
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([v, n]) => `${v} ${n}`).join('、') || '无记录'
  }
  return `共 ${rows.length} 篇。心情（天数）：${MOOD.map((l, i) => `${l} ${moods[i]}`).join('、')}。
最常去的地方（天数）：${top('places')}
最常提到的人（天数）：${top('people')}
常用标签（天数）：${top('tags')}`
}

/** 按周（周一开始）分组的键 */
function weekOf(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

export interface Chunk { from: string; to: string; blocks: string[] }

/**
 * 把一个月的日记切成若干段，每段不超过预算（按 token 估算）。
 * 尽量按整周切；一周放不下就按天切；单篇放不下就截断这一篇。
 */
export function chunkEntries(items: { date: string; block: string }[], budget: number): Chunk[] {
  const cost = (b: string) => estimateTokens(b) + 4
  const fit = (it: { date: string; block: string }) => {
    if (cost(it.block) <= budget) return it
    // 截断：按 1 字 1 token 保守换算
    return { ...it, block: `${it.block.slice(0, Math.max(200, budget - 60))}\n……（这篇太长，后面的已截断）` }
  }
  const weeks: { date: string; block: string }[][] = []
  for (const it of items.map(fit)) {
    const last = weeks[weeks.length - 1]
    if (last && weekOf(last[0].date) === weekOf(it.date)) last.push(it)
    else weeks.push([it])
  }
  const out: Chunk[] = []
  let cur: { date: string; block: string }[] = []
  let used = 0
  const flush = () => {
    if (!cur.length) return
    out.push({ from: cur[0].date, to: cur[cur.length - 1].date, blocks: cur.map((c) => c.block) })
    cur = []
    used = 0
  }
  for (const w of weeks) {
    const wc = w.reduce((a, it) => a + cost(it.block), 0)
    if (used + wc <= budget) {
      cur.push(...w)
      used += wc
      continue
    }
    flush()
    for (const it of w) {
      if (used + cost(it.block) > budget) flush()
      cur.push(it)
      used += cost(it.block)
    }
  }
  flush()
  return out
}

const md = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`

/**
 * 月度总结。整月日记放得进模型的上下文时一次写完；放不进时（2026-10-04 加入）先按周分段写阶段小结，
 * 再把各段小结和代码算出的统计合成整月总结。
 */
export async function generateMonthly(
  cfg: LlmConfig, repo: DiaryRepo, index: DiaryIndex, ym: string, now = new Date(),
  onProgress?: (msg: string) => void,
): Promise<SummaryDoc> {
  const month = index.month(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)))
  const rows = month.filter((r) => !r.aiExclude).reverse()
  if (!rows.length) throw new Error(month.length ? `${ym} 的日记都设置了不让 AI 读` : `${ym} 没有日记`)
  const items: { date: string; block: string }[] = []
  for (const r of rows) items.push({ date: r.date, block: await entryBlock(repo, r.date, r.text) })
  const maxOut = cfg.maxOutput || 2000
  const ctx = cfg.contextTokens || DEFAULT_CONTEXT_TOKENS
  const budgetFor = (system: string) => Math.max(1500, ctx - maxOut - estimateTokens(withInstructions(system, cfg.instructions)) - 1000)
  const all = items.map((i) => i.block).join('\n\n')
  const { hash, count } = await monthSourceHash(index, ym)

  let text: string
  let parts = 1
  if (estimateTokens(all) + 50 <= budgetFor(MONTH_SYSTEM)) {
    const r = await chat(cfg, {
      system: MONTH_SYSTEM,
      messages: [{ role: 'user', content: `这是 ${ym} 的全部 ${rows.length} 篇日记：\n\n${all}` }],
      maxTokens: 2000,
      timeoutMs: 180000,
    })
    text = r.text
  } else {
    const chunks = chunkEntries(items, budgetFor(PART_SYSTEM) - 50)
    parts = chunks.length
    const notes: string[] = []
    for (const [i, c] of chunks.entries()) {
      onProgress?.(`日记较多，分 ${chunks.length} 段读：第 ${i + 1} 段（${md(c.from)}–${md(c.to)}）`)
      const r = await chat(cfg, {
        system: PART_SYSTEM,
        messages: [{ role: 'user', content: `这是 ${ym} 中 ${c.from} 到 ${c.to} 的 ${c.blocks.length} 篇日记：\n\n${c.blocks.join('\n\n')}` }],
        maxTokens: 1200,
        timeoutMs: 180000,
      })
      notes.push(`### ${md(c.from)}–${md(c.to)}\n${r.text.trim()}`)
    }
    onProgress?.('把几段合成整月总结')
    const r = await chat(cfg, {
      system: MONTH_SYSTEM,
      messages: [{
        role: 'user',
        content: `${ym} 的日记较多，已经按日期分成 ${chunks.length} 段写了阶段小结。请根据这些小结和下面的统计，写这个月的总结（不要逐段复述）。\n\n统计：\n${monthStats(index, ym)}\n\n各段小结：\n\n${notes.join('\n\n')}`,
      }],
      maxTokens: 2000,
      timeoutMs: 180000,
    })
    text = r.text
  }
  const doc: SummaryDoc = {
    meta: {
      type: 'monthly-summary', period: ym, generated_at: isoLocal(now), model: cfg.model, source_count: count, source_hash: hash, locked: false,
      ...(parts > 1 ? { parts } : {}),
    },
    body: text.trim(),
    extra: (await readSummary(repo.store, ym))?.extra ?? [],
  }
  await writeSummary(repo, doc)
  return doc
}

export function yearStats(index: DiaryIndex, year: string) {
  const rows = index.aiRows().filter((r) => r.date.startsWith(year))
  const moods = rows.map((r) => r.mood).filter((m): m is number => m != null)
  const top = (field: 'places' | 'people') => {
    const c = new Map<string, number>()
    for (const r of rows) for (const v of r[field]) c.set(v, (c.get(v) ?? 0) + 1)
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, days]) => ({ value, days }))
  }
  return {
    entries: rows.length,
    moodAvg: moods.length ? Math.round((moods.reduce((a, b) => a + b, 0) / moods.length) * 10) / 10 : null,
    topPlaces: top('places'),
    topPeople: top('people'),
  }
}

/** 年度总结：先补齐缺少的月度总结，再基于 12 份月度总结和全年统计生成 */
export async function generateYearly(
  cfg: LlmConfig, repo: DiaryRepo, index: DiaryIndex, store: FileStore, year: string,
  onProgress?: (msg: string) => void, now = new Date(),
): Promise<SummaryDoc> {
  const months = [...new Set(index.aiRows().filter((r) => r.date.startsWith(year)).map((r) => r.date.slice(0, 7)))].sort()
  if (!months.length) throw new Error(`${year} 年没有日记`)
  const texts: string[] = []
  for (const ym of months) {
    let s = await readSummary(store, ym)
    if (!s) {
      onProgress?.(`先生成 ${Number(ym.slice(5))} 月的总结`)
      s = await generateMonthly(cfg, repo, index, ym, now, (m) => onProgress?.(`${Number(ym.slice(5))} 月：${m}`))
    }
    texts.push(`## ${ym}\n${s.body}`)
  }
  const st = yearStats(index, year)
  const statText = `全年写了 ${st.entries} 篇${st.moodAvg != null ? `，平均心情 ${st.moodAvg}（1 很差，5 很好）` : ''}。
最常去的地方（天数）：${st.topPlaces.map((p) => `${p.value} ${p.days}`).join('、') || '无记录'}
最常提到的人（天数）：${st.topPeople.map((p) => `${p.value} ${p.days}`).join('、') || '无记录'}`
  onProgress?.(`正在写 ${year} 年的总结`)
  const r = await chat(cfg, {
    system: YEAR_SYSTEM,
    messages: [{ role: 'user', content: `${year} 年统计：\n${statText}\n\n各月总结：\n\n${texts.join('\n\n')}` }],
    maxTokens: 3000,
    timeoutMs: 180000,
  })
  const { hash, count } = await yearSourceHash(store, year)
  const doc: SummaryDoc = {
    meta: { type: 'yearly-summary', period: year, generated_at: isoLocal(now), model: cfg.model, source_count: count, source_hash: hash, locked: false },
    body: r.text.trim(),
    extra: (await readSummary(store, year))?.extra ?? [],
  }
  await writeSummary(repo, doc)
  return doc
}

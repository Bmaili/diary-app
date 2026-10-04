/** 月度与年度总结（规格 7.4）。 */
import type { DiaryIndex } from '../diaryIndex'
import type { DiaryRepo } from '../repo'
import type { FileStore } from '../types'
import { isoLocal } from '../time'
import {
  monthSourceHash, readSummary, writeSummary, yearSourceHash, type SummaryDoc,
} from '../summaries'
import { chat, type LlmConfig } from './client'

const MOOD = ['很差', '不好', '一般', '不错', '很好']

const MONTH_SYSTEM = `你为用户写一份月度日记总结。用第二人称“你”，300 到 800 字，Markdown 格式，可以用二三级小标题。
内容包括：这个月的主要经历和变化；常出现的人和地点；情绪的起伏和可能的原因。
只写日记里有的事，不要编造，不要说教，不要给建议。语气像一位了解你的老朋友在帮你回顾。`

const YEAR_SYSTEM = `你为用户写一份年度日记总结。用第二人称“你”，600 到 1200 字，Markdown 格式，可以用小标题。
根据各月的月度总结和全年统计，写出这一年的主线、重要的转折、常在一起的人和常去的地方、情绪的整体走势。
只写材料里有的事，不要编造，不要说教。`

export async function generateMonthly(cfg: LlmConfig, repo: DiaryRepo, index: DiaryIndex, ym: string, now = new Date()): Promise<SummaryDoc> {
  const rows = index.month(Number(ym.slice(0, 4)), Number(ym.slice(5, 7))).slice().reverse()
  if (!rows.length) throw new Error(`${ym} 没有日记`)
  const parts: string[] = []
  for (const r of rows) {
    const doc = await repo.readEntry(r.date).catch(() => null)
    const m = doc?.meta
    const meta = [
      m?.mood ? `心情：${MOOD[m.mood - 1]}` : '',
      m?.weather?.text ? `天气：${m.weather.text}` : '',
      m?.location?.name || m?.location?.address ? `地点：${m.location?.name ?? m.location?.address}` : '',
      m?.people?.length ? `人物：${m.people.join('、')}` : '',
      m?.places?.length ? `去过：${m.places.join('、')}` : '',
      m?.tags?.length ? `标签：${m.tags.join('、')}` : '',
    ].filter(Boolean).join('；')
    parts.push(`## ${r.date}${meta ? `\n（${meta}）` : ''}\n${doc?.body ?? r.text}`)
  }
  const { hash, count } = await monthSourceHash(index, ym)
  const r = await chat(cfg, {
    system: MONTH_SYSTEM,
    messages: [{ role: 'user', content: `这是 ${ym} 的全部 ${rows.length} 篇日记：\n\n${parts.join('\n\n')}` }],
    maxTokens: 2000,
    timeoutMs: 180000,
  })
  const doc: SummaryDoc = {
    meta: { type: 'monthly-summary', period: ym, generated_at: isoLocal(now), model: cfg.model, source_count: count, source_hash: hash, locked: false },
    body: r.text.trim(),
    extra: (await readSummary(repo.store, ym))?.extra ?? [],
  }
  await writeSummary(repo, doc)
  return doc
}

export function yearStats(index: DiaryIndex, year: string) {
  const rows = index.all().filter((r) => r.date.startsWith(year))
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
  const months = [...new Set(index.all().filter((r) => r.date.startsWith(year)).map((r) => r.date.slice(0, 7)))].sort()
  if (!months.length) throw new Error(`${year} 年没有日记`)
  const texts: string[] = []
  for (const ym of months) {
    let s = await readSummary(store, ym)
    if (!s) {
      onProgress?.(`先生成 ${Number(ym.slice(5))} 月的总结`)
      s = await generateMonthly(cfg, repo, index, ym, now)
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

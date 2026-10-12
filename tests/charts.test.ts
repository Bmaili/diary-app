import { afterEach, describe, expect, it } from 'vitest'
import { DiaryRepo } from '../src/core/repo'
import { DiaryIndex } from '../src/core/diaryIndex'
import { generateTestEntries } from '../src/core/testData'
import { DiaryTools } from '../src/core/llm/tools'
import { ask, systemPrompt } from '../src/core/llm/agent'
import { chartRefs, kindsFor, monthlyCounts, pickKind, splitAnswer, type ChartData, type DatesChart, type GroupsChart } from '../src/core/llm/charts'
import type { LlmConfig } from '../src/core/llm/client'
import { NodeStore } from './nodeStore'
import { lastToolResult, startLlmMock, type LlmMock, type Script } from './mocks/llmServer'

describe('回答里的图表标记', () => {
  it('拆成文字段和图表段，容忍全角括号和冒号', () => {
    const t = '今年心情还行。\n\n[[chart:ab1]]\n\n下雨天差一些：\n【【chart：ab2：mood】】\n相关日期：2026-01-05'
    expect(splitAnswer(t)).toEqual([
      { md: '今年心情还行。\n\n' },
      { chart: 'ab1' },
      { md: '\n\n下雨天差一些：\n' },
      { chart: 'ab2', kind: 'mood' },
      { md: '\n相关日期：2026-01-05' },
    ])
    expect(chartRefs(t)).toEqual(['ab1', 'ab2'])
    expect(splitAnswer('没有图')).toEqual([{ md: '没有图' }])
  })
})

describe('图表画法', () => {
  const groups = (by: GroupsChart['group_by'], n = 1, moods = true): GroupsChart => ({
    type: 'groups', title: 't', group_by: by,
    series: Array.from({ length: n }, (_, i) => ({
      label: `s${i}`,
      groups: [{ key: 'a', label: 'a', days: 2, avg_mood: 3, ...(moods ? { moods: [0, 0, 2, 0, 0] } : {}) }],
    })),
  })
  it('默认画法：时间和心情用柱状图，类别用排行，日期用日历格子', () => {
    expect(pickKind(groups('month'))).toBe('bar')
    expect(pickKind(groups('mood'))).toBe('bar')
    expect(pickKind(groups('person'))).toBe('rank')
    expect(pickKind(groups('weekday'))).toBe('rank')
    const dates: DatesChart = { type: 'dates', title: 't', from: '2026-01-01', to: '2026-10-01', dates: [{ date: '2026-01-05', mood: 3 }] }
    expect(pickKind(dates)).toBe('heatmap')
  })
  it('画不了的类型退回默认：多组不画心情构成，日历格子只给按天统计', () => {
    expect(pickKind(groups('month', 2), 'mood')).toBe('bar')
    expect(pickKind(groups('month'), 'heatmap')).toBe('bar')
    expect(kindsFor(groups('day'))).toContain('heatmap')
    expect(pickKind(groups('month', 1, false), 'mood')).toBe('bar')
    expect(pickKind(groups('month'), 'line')).toBe('line')
    expect(pickKind(groups('month'), 'pie')).toBe('bar')
  })
  it('跨度超过 36 个月的日期只能按月画柱状图，月份补齐', () => {
    const c: DatesChart = { type: 'dates', title: 't', from: '2022-01-01', to: '2026-10-01', dates: [{ date: '2022-01-05', mood: null }, { date: '2022-01-09', mood: 2 }, { date: '2022-03-01', mood: null }] }
    expect(kindsFor(c)).toEqual(['bar'])
    const m = monthlyCounts(c)
    expect(m.slice(0, 3).map((g) => [g.key, g.days])).toEqual([['2022-01', 2], ['2022-02', 0], ['2022-03', 1]])
    expect(m.at(-1)!.key).toBe('2026-10')
  })
})

describe('问答循环里的图表', () => {
  let mock: LlmMock
  afterEach(() => mock?.close())
  const cfg = (): LlmConfig => ({ protocol: 'openai', baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm', apiKey: 'k' })

  it('统计结果带 chart_id，回答里引用的才存下来，数字来自工具结果', async () => {
    const store = await NodeStore.temp()
    const repo = new DiaryRepo(store)
    await repo.init()
    await generateTestEntries(repo, { count: 120, endDate: '2026-10-04', seed: 3 })
    const index = new DiaryIndex(repo, store)
    await index.load()
    const tools = new DiaryTools(index, repo, store)
    let seen = ''
    const model: Script = ({ turns, system }) => {
      expect(system).toContain('[[chart:chart_id]]')
      const calls = turns.filter((t) => t.role === 'assistant' && t.toolCalls).flatMap((t) => t.toolCalls!)
      if (!calls.length) return { toolCalls: [{ name: 'aggregate', args: { group_by: 'month', from: '2026-07', to: '2026-10' } }] }
      if (calls.length === 1) {
        seen = String(lastToolResult(turns)!.chart_id)
        return { toolCalls: [{ name: 'search_entries', args: { query: '的' } }] }
      }
      return { text: `这几个月的心情如下：\n\n[[chart:${seen}:line]]\n\n[[chart:zz9]]\n相关日期：2026-10-04` }
    }
    mock = await startLlmMock(model)
    const live: string[] = []
    const r = await ask({
      cfg: cfg(), tools, question: '最近几个月心情怎么样？', history: [],
      system: systemPrompt('2026-10-04', null, null, index.size), onChart: (id) => live.push(id),
    })
    expect(seen).toMatch(/^[a-z]{2}1$/)
    expect(live).toEqual([seen])
    // 编造的编号不存，引用到的存下来
    expect(Object.keys(r.charts!)).toEqual([seen])
    const c = r.charts![seen] as ChartData & GroupsChart
    expect(c.group_by).toBe('month')
    expect(c.series[0].groups.map((g) => g.key)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10'])
    const july = index.aiRows().filter((x) => x.date.startsWith('2026-07')).length
    expect(c.series[0].groups[0].days).toBe(july)
    expect(r.steps[0].summary).toBe('做了分组统计（按月）')
    expect(c.title).toBe('按月')
  })

  it('count_days 的结果画成日期图，带上每天的心情', async () => {
    const store = await NodeStore.temp()
    const repo = new DiaryRepo(store)
    await repo.init()
    await generateTestEntries(repo, { count: 60, endDate: '2026-10-04', seed: 5 })
    const index = new DiaryIndex(repo, store)
    await index.load()
    const tools = new DiaryTools(index, repo, store)
    const r = tools.count_days({ terms: ['的'], from: '2026-09' })
    const c = tools.chart('count_days', { terms: ['的'], from: '2026-09' }, r) as DatesChart
    expect(c.type).toBe('dates')
    expect(c.from).toBe('2026-09-01')
    expect(c.dates.length).toBe((r as { days: number }).days)
    expect(c.dates.every((d) => d.mood === (index.get(d.date)?.mood ?? null))).toBe(true)
    expect(tools.chart('count_days', { terms: ['不存在的词xyz'] }, tools.count_days({ terms: ['不存在的词xyz'] }))).toBeNull()
    expect(tools.chart('search_entries', {}, {})).toBeNull()
  })
})

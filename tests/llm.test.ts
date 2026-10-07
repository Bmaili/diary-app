import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo, entryPath } from '../src/core/repo'
import { DiaryIndex } from '../src/core/diaryIndex'
import { generateTestEntries } from '../src/core/testData'
import { parseEntry, setListFieldManually } from '../src/core/entryFile'
import { addDays } from '../src/core/time'
import { anthropicUrl, chat, extractJson, openaiUrl, testConfig, type LlmConfig } from '../src/core/llm/client'
import { DiaryTools } from '../src/core/llm/tools'
import { ask, estimateTokens, systemPrompt } from '../src/core/llm/agent'
import { extractAndSave, runBatch, type BatchState } from '../src/core/llm/extract'
import { chunkEntries, generateMonthly, generateYearly } from '../src/core/llm/summarize'
import { readSummary, summaryStatus, writeSummary } from '../src/core/summaries'
import { mergeValues } from '../src/core/vocab'
import { NodeStore } from './nodeStore'
import { lastToolResult, startLlmMock, type LlmMock, type Script } from './mocks/llmServer'

async function setup() {
  const store = await NodeStore.temp()
  const repo = new DiaryRepo(store)
  await repo.init()
  const index = new DiaryIndex(repo, store)
  return { store, repo, index, tools: new DiaryTools(index, repo, store) }
}

let mock: LlmMock
afterEach(() => mock?.close())
const cfg = (protocol: 'openai' | 'anthropic', over: Partial<LlmConfig> = {}): LlmConfig => ({
  protocol,
  baseUrl: protocol === 'openai' ? `http://127.0.0.1:${mock.port}/v1` : `http://127.0.0.1:${mock.port}`,
  model: 'test-model',
  apiKey: 'sk-test',
  ...over,
})

describe('协议适配', () => {
  it('接口地址补全', () => {
    expect(openaiUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(openaiUrl('https://x.com/v1/chat/completions')).toBe('https://x.com/v1/chat/completions')
    expect(anthropicUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(anthropicUrl('https://proxy.example.com/v1')).toBe('https://proxy.example.com/v1/messages')
  })

  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}：工具调用往返，报文格式正确`, async () => {
      mock = await startLlmMock(({ turns }) => {
        const r = lastToolResult(turns)
        return r ? { text: `一共 ${r.total} 篇。` } : { toolCalls: [{ name: 'get_stats', args: {} }] }
      }, { key: 'sk-test' })
      const { repo, index, tools } = await setup()
      await repo.saveEntry({ meta: { date: '2026-10-04' }, body: 'x', extra: [] })
      await index.load()
      const r = await ask({ cfg: cfg(protocol), tools, question: '我写了几篇？', history: [{ q: '你好', a: '你好！' }], system: 'SYS' })
      expect(r.answer).toBe('一共 1 篇。')
      expect(r.steps.map((s) => s.tool)).toEqual(['get_stats'])

      const second = mock.requests[1]
      if (protocol === 'openai') {
        expect(second.path).toBe('/v1/chat/completions')
        expect(second.headers.authorization).toBe('Bearer sk-test')
        const msgs = second.body.messages as Record<string, unknown>[]
        expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' })
        const asst = msgs.find((m) => m.tool_calls) as { tool_calls: { function: { arguments: unknown } }[] }
        expect(typeof asst.tool_calls[0].function.arguments).toBe('string')
        expect(msgs.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
        expect((second.body.tools as { type: string }[])[0].type).toBe('function')
      } else {
        expect(second.path).toBe('/v1/messages')
        expect(second.headers['x-api-key']).toBe('sk-test')
        expect(second.headers['anthropic-version']).toBe('2023-06-01')
        expect(second.body.system).toBe('SYS')
        expect(second.body.max_tokens).toBeGreaterThan(0)
        const msgs = second.body.messages as { role: string; content: { type: string }[] }[]
        expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
        expect(msgs[3].content[0].type).toBe('tool_use')
        expect(msgs[4].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' })
        expect((second.body.tools as Record<string, unknown>[])[0]).toHaveProperty('input_schema')
      }
    })

    it(`${protocol}：“测试”按钮能识别是否支持工具调用`, async () => {
      mock = await startLlmMock(({ tools }) => (tools.includes('get_time') ? { toolCalls: [{ name: 'get_time', args: {} }] } : { text: 'hi' }))
      expect((await testConfig(cfg(protocol))).toolCalling).toBe(true)
      mock.script = () => ({ text: '我不会用工具' })
      expect((await testConfig(cfg(protocol))).toolCalling).toBe(false)
    })
  }

  it('错误信息', async () => {
    mock = await startLlmMock(() => ({ text: 'x' }), { key: 'right' })
    await expect(chat(cfg('openai'), { system: '', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/API Key 不对/)
    await expect(chat(cfg('openai', { apiKey: '' }), { system: '', messages: [] })).rejects.toThrow(/还没有填 API Key/)
  })

  it('从模型输出里取 JSON', () => {
    expect(extractJson('好的：\n```json\n{"a":[1]}\n```')).toEqual({ a: [1] })
    expect(extractJson('结果是 {"a": 2} 。')).toEqual({ a: 2 })
    expect(extractJson('没有')).toBeNull()
  })
})

describe('验收：计数测试集（规格阶段 4）', () => {
  /**
   * 365 篇日记中有 17 天去过“老王烧烤”：
   * - 9 天元数据里写的是全名；
   * - 3 天元数据里用的是简称“老王家”；
   * - 5 天只在正文里提到，没有做过 AI 抽取。
   * 另有几天提到了一个叫“老王”的人，但没去烧烤店，不应计入。
   */
  async function dataset() {
    const s = await setup()
    await generateTestEntries(s.repo, { count: 365, endDate: '2026-10-04', seed: 7 })
    const visits: string[] = []
    const write = async (i: number, body: string, places?: string[], extracted = true) => {
      const date = addDays('2026-10-04', -i * 20 - 3)
      const doc = parseEntry((await s.store.readText(entryPath(date)))!, date)
      doc.body = body
      if (places) doc.meta.places = places
      else delete doc.meta.places
      if (extracted) doc.meta.ai = { extracted_at: '2026-10-04T23:00:00+08:00', model: 'x', fields: ['places'] }
      else delete doc.meta.ai
      await s.repo.saveEntry(doc, new Date(2026, 9, 4, 22, 0))
      return date
    }
    for (let i = 0; i < 9; i++) visits.push(await write(i, `晚上和阿杰去老王烧烤吃串，聊到很晚。`, ['老王烧烤']))
    for (let i = 9; i < 12; i++) visits.push(await write(i, `又去了老王家，老板送了两瓶汽水。`, ['老王家']))
    for (let i = 12; i < 17; i++) visits.push(await write(i, `下班顺路去老王烧烤买了点烤串带回家。`, undefined, false))
    await write(17, '给老王打了个电话，他说下个月搬家。', undefined, true)
    await write(18, '老王来找我借书。', undefined, false)
    await s.index.load()
    return { ...s, visits: visits.sort() }
  }

  /** 一个“会用工具”的模型：先查词表，再把全部写法交给 count_days，按工具结果作答 */
  const smartModel: Script = ({ turns }) => {
    const tools = turns.filter((t) => t.role === 'assistant' && t.toolCalls).flatMap((t) => t.toolCalls!)
    const result = lastToolResult(turns)
    if (!tools.length) return { toolCalls: [{ name: 'list_values', args: { field: 'places', query: '老王' } }] }
    if (tools.length === 1) {
      const names = (result!.values as { value: string }[]).map((v) => v.value)
      return { toolCalls: [{ name: 'count_days', args: { terms: [...names, '老王烧烤'], from: '2025-10-05', to: '2026-10-04' } }] }
    }
    const dates = (result!.dates as { date: string }[]).map((d) => d.date)
    const caveat = (result!.unextracted_in_range as number) > 0 ? '有些日记还没做过 AI 抽取，部分结果来自正文匹配。' : ''
    return { text: `过去一年你去了老王烧烤 ${result!.days} 天（同一天去两次算一次）。${caveat}\n相关日期：${dates.join('、')}` }
  }

  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}：问“过去一年去了几次”，回答 17 并列出 17 个日期`, async () => {
      const d = await dataset()
      mock = await startLlmMock(smartModel)
      const r = await ask({
        cfg: cfg(protocol), tools: d.tools, question: '过去一年我去过几次老王烧烤？', history: [],
        system: systemPrompt('2026-10-04', '2025-10-05', '2026-10-04', d.index.size),
      })
      expect(r.answer).toContain('17 天')
      expect(r.dates).toEqual(d.visits)
      expect(r.answer).toContain('还没做过 AI 抽取')
      expect(r.steps.map((s) => s.summary)).toEqual(['查了地点词表里的“老王”，找到 2 个', '统计了 “老王烧烤”、“老王家”、“老王烧烤”：17 天'])
    })
  }

  it('count_days 本身：合并写法、同一天只算一次、说明来源', async () => {
    const d = await dataset()
    const r = d.tools.count_days({ terms: ['老王烧烤', '老王家'] }) as { days: number; text_only_days: number; dates: { via: string[] }[] }
    expect(r.days).toBe(17)
    expect(r.text_only_days).toBe(5)
    // 只数元数据时是 12 天
    expect((d.tools.count_days({ terms: ['老王烧烤', '老王家'], match_text: false }) as { days: number }).days).toBe(12)
  })
})

describe('抽取（规格 7.4）', () => {
  const model: Script = ({ turns }) => {
    const text = turns.at(-1)!.text!
    expect(text).toContain('已有词表')
    return { text: '```json\n{"places":["江边公园"],"people":["小王"],"tags":["运动","散步"]}\n```' }
  }

  it('验收：手动改过 tags 的日记，批量抽取后 tags 不变', async () => {
    mock = await startLlmMock(model)
    const s = await setup()
    await s.repo.saveEntry({ meta: { date: '2026-10-03' }, body: '去江边公园跑步，遇到小王。', extra: [] })
    const doc = (await s.repo.readEntry('2026-10-03'))!
    setListFieldManually(doc.meta, 'tags', ['我自己的标签'])
    await s.repo.saveEntry(doc)
    await s.repo.saveEntry({ meta: { date: '2026-10-04' }, body: '又去跑步。', extra: [] })
    await s.index.load()
    expect(s.index.needsExtraction().length).toBe(2)

    const state: BatchState = { running: false, paused: false, done: 0, total: 0, failed: [] }
    await runBatch({ cfg: cfg('openai'), repo: s.repo, index: s.index, dates: s.index.needsExtraction().map((r) => r.date), state, onSaved: (d) => s.index.refresh(d) })
    const a = (await s.repo.readEntry('2026-10-03'))!.meta
    expect(a.tags).toEqual(['我自己的标签'])
    expect(a.places).toEqual(['江边公园'])
    expect(a.people).toEqual(['小王'])
    expect(a.ai?.fields).toEqual(['people', 'places'])
    expect(a.locked).toEqual(['tags'])
    // 写回后不再是“待抽取”，updated 没变
    expect(s.index.needsExtraction()).toEqual([])
  })

  it('验收：批量抽取中途被杀，重开后从中断处继续', async () => {
    mock = await startLlmMock(model)
    const s = await setup()
    await generateTestEntries(s.repo, { count: 12, endDate: '2026-09-30' })
    await s.index.load()
    const state: BatchState = { running: false, paused: false, done: 0, total: 0, failed: [] }
    let saved = 0
    // 做完 5 篇时“被杀”：之后的请求都失败，相当于进程没了
    await runBatch({
      cfg: cfg('openai'), repo: s.repo, index: s.index, dates: s.index.needsExtraction().map((r) => r.date), state, concurrency: 1,
      onSaved: async (d) => {
        await s.index.refresh(d)
        if (++saved === 5) mock.failNext = 1000
      },
    })
    // 重开：从文件重新建索引，待处理的只剩 7 篇
    const fresh = new DiaryIndex(s.repo, s.store)
    await fresh.load()
    expect(fresh.needsExtraction().length).toBe(7)
    mock.failNext = 0
    const before = mock.requests.length
    await runBatch({ cfg: cfg('openai'), repo: s.repo, index: fresh, dates: fresh.needsExtraction().map((r) => r.date), state, onSaved: (d) => fresh.refresh(d) })
    expect(fresh.needsExtraction().length).toBe(0)
    expect(mock.requests.length - before).toBe(7)
  })

  it('抽取后又改了日记，会重新变成待抽取', async () => {
    mock = await startLlmMock(model)
    const s = await setup()
    await s.repo.saveEntry({ meta: { date: '2026-10-04' }, body: 'a', extra: [] }, new Date(2026, 9, 4, 20, 0))
    await s.index.load()
    await extractAndSave(cfg('openai'), s.repo, s.index, '2026-10-04', new Date(2026, 9, 4, 21, 0))
    await s.index.refresh('2026-10-04')
    expect(s.index.needsExtraction()).toEqual([])
    const doc = (await s.repo.readEntry('2026-10-04'))!
    doc.body += '，又补了一句'
    await s.repo.saveEntry(doc, new Date(2026, 9, 4, 22, 0))
    await s.index.refresh('2026-10-04')
    expect(s.index.needsExtraction().map((r) => r.date)).toEqual(['2026-10-04'])
  })
})

describe('总结（规格 7.5）', () => {
  beforeEach(async () => {
    mock = await startLlmMock(({ turns }) => ({ text: `总结：${turns.at(-1)!.text!.slice(0, 20)}` }))
  })

  it('验收：生成月度总结后改一篇当月日记，总结显示“源内容已变”', async () => {
    const s = await setup()
    await s.repo.saveEntry({ meta: { date: '2026-09-10' }, body: '九月十日', extra: [] })
    await s.repo.saveEntry({ meta: { date: '2026-09-20' }, body: '九月二十日', extra: [] })
    await s.index.load()
    const sum = await generateMonthly(cfg('anthropic'), s.repo, s.index, '2026-09')
    expect(sum.meta.source_count).toBe(2)
    expect(await s.store.readText('diary/summaries/monthly/2026-09.md')).toMatch(/^---\ntype: monthly-summary\nperiod: 2026-09\n/)
    expect(await summaryStatus(s.store, s.index, '2026-09')).toBe('fresh')
    const doc = (await s.repo.readEntry('2026-09-10'))!
    doc.body += '，补充'
    await s.repo.saveEntry(doc)
    await s.index.refresh('2026-09-10')
    expect(await summaryStatus(s.store, s.index, '2026-09')).toBe('stale')
  })

  it('验收：手动编辑总结后处于锁定状态', async () => {
    const s = await setup()
    await s.repo.saveEntry({ meta: { date: '2026-09-10' }, body: '九月十日', extra: [] })
    await s.index.load()
    const sum = await generateMonthly(cfg('openai'), s.repo, s.index, '2026-09')
    sum.body = '我自己改写的总结'
    sum.meta.locked = true
    await writeSummary(s.repo, sum)
    expect(await summaryStatus(s.store, s.index, '2026-09')).toBe('locked')
    expect((await readSummary(s.store, '2026-09'))!.body).toBe('我自己改写的总结')
  })

  it('一个月的日记放不进上下文时，按周分段写小结再合成，每次请求都不超出', async () => {
    const s = await setup()
    // 30 篇，每篇约 1500 字；上下文只有 16000 tokens
    for (let d = 1; d <= 30; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`
      await s.repo.saveEntry({ meta: { date, mood: (d % 5) + 1, places: d % 3 ? ['图书馆'] : ['江边公园'] }, body: `${d} 日。${'今天写了很多字。'.repeat(190)}`, extra: [] })
    }
    await s.index.load()
    const steps: string[] = []
    const sum = await generateMonthly(cfg('openai', { contextTokens: 16000 }), s.repo, s.index, '2026-09', new Date(), (m) => steps.push(m))
    const n = mock.requests.length
    expect(n).toBeGreaterThan(2)
    expect(sum.meta.parts).toBe(n - 1)
    expect(steps.at(-1)).toBe('把几段合成整月总结')
    expect(steps[0]).toMatch(/^日记较多，分 \d+ 段读：第 1 段（9 月 1 日–9 月 \d+ 日）$/)
    for (const r of mock.requests) expect(estimateTokens(JSON.stringify(r.body.messages))).toBeLessThan(16000)
    // 每段的日期连续、不重不漏
    const covered = mock.requests.slice(0, -1).flatMap((r) => [...JSON.stringify(r.body.messages).matchAll(/## (2026-09-\d\d)/g)].map((m) => m[1]))
    expect(covered).toEqual(Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`))
    // 合成的那次带上各段小结和代码算的统计
    const last = (mock.requests.at(-1)!.body.messages as { content: string }[]).at(-1)!.content
    expect(last).toContain('最常去的地方（天数）：图书馆 20、江边公园 10')
    expect(last).toContain('### 9 月 1 日–')
    expect(await s.store.readText('diary/summaries/monthly/2026-09.md')).toMatch(/\nparts: \d+\n/)
  })

  it('放得下时只请求一次，不写 parts', async () => {
    const s = await setup()
    await s.repo.saveEntry({ meta: { date: '2026-09-10' }, body: '九月十日', extra: [] })
    await s.index.load()
    const sum = await generateMonthly(cfg('openai'), s.repo, s.index, '2026-09')
    expect(mock.requests).toHaveLength(1)
    expect(sum.meta.parts).toBeUndefined()
  })

  it('分段：整周放得下就按周，单篇太长就截断', () => {
    const items = ['2026-09-01', '2026-09-02', '2026-09-07', '2026-09-08', '2026-09-09'].map((date) => ({ date, block: `## ${date}\n${'字'.repeat(300)}` }))
    const chunks = chunkEntries(items, 700)
    // 9-01、9-02 是同一周（周二、周三），9-07 起是下一周
    expect(chunks.map((c) => [c.from, c.to])).toEqual([['2026-09-01', '2026-09-02'], ['2026-09-07', '2026-09-08'], ['2026-09-09', '2026-09-09']])
    const long = chunkEntries([{ date: '2026-09-01', block: '字'.repeat(5000) }], 1000)
    expect(long[0].blocks[0]).toContain('已截断')
    expect(estimateTokens(long[0].blocks[0])).toBeLessThanOrEqual(1000)
  })

  it('年度总结会先补齐缺少的月度总结', async () => {
    const s = await setup()
    for (const d of ['2025-01-05', '2025-03-08', '2025-03-09', '2025-11-30']) await s.repo.saveEntry({ meta: { date: d, mood: 4, places: ['图书馆'] }, body: d, extra: [] })
    await s.index.load()
    const steps: string[] = []
    const y = await generateYearly(cfg('openai'), s.repo, s.index, s.store, '2025', (m) => steps.push(m))
    expect(steps).toEqual(['先生成 1 月的总结', '先生成 3 月的总结', '先生成 11 月的总结', '正在写 2025 年的总结'])
    expect(y.meta.source_count).toBe(3)
    const lastReq = mock.requests.at(-1)!.body.messages as { content: string }[]
    expect(lastReq.at(-1)!.content).toContain('最常去的地方（天数）：图书馆 4')
    expect(await summaryStatus(s.store, s.index, '2025')).toBe('fresh')
  })
})

describe('词表合并', () => {
  it('把几个写法合并成一个，改写所有涉及的文件，不改变锁定状态', async () => {
    const s = await setup()
    await s.repo.saveEntry({ meta: { date: '2026-10-01', places: ['老王家', '公司'], location: { name: '老王家', lat: 1, lng: 2, crs: 'wgs84' } }, body: 'a', extra: [] })
    await s.repo.saveEntry({ meta: { date: '2026-10-02', places: ['老王烧烤'], locked: ['places'] }, body: 'b', extra: [] })
    await s.repo.saveEntry({ meta: { date: '2026-10-03', places: ['公司'] }, body: 'c', extra: [] })
    await s.index.load()
    const touched: string[] = []
    const n = await mergeValues(s.repo, s.index, 'places', ['老王家'], '老王烧烤', async (d) => {
      touched.push(d)
    })
    expect(n).toBe(1)
    expect(touched).toEqual(['2026-10-01'])
    const a = (await s.repo.readEntry('2026-10-01'))!.meta
    expect(a.places).toEqual(['老王烧烤', '公司'])
    expect(a.location?.name).toBe('老王烧烤')
    expect(a.locked).toBeUndefined()
    expect((await s.repo.readEntry('2026-10-02'))!.meta.locked).toEqual(['places'])
  })
})

describe('补充说明随请求发送', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}：说明接在系统提示后面`, async () => {
      let seen = ''
      mock = await startLlmMock(({ system }) => {
        seen = system
        return { text: 'ok' }
      })
      await chat(cfg(protocol, { instructions: '老地方=兰州拉面' }), { system: '基础提示', messages: [{ role: 'user', content: 'hi' }] })
      expect(seen.startsWith('基础提示')).toBe(true)
      expect(seen).toContain('老地方=兰州拉面')
    })
  }
  it('连接测试不带说明', async () => {
    let seen = ''
    mock = await startLlmMock(({ system }) => {
      seen = system
      return { toolCalls: [{ name: 'get_time', args: {} }] }
    })
    await testConfig(cfg('openai', { instructions: '不应出现' }))
    expect(seen).not.toContain('不应出现')
  })
})

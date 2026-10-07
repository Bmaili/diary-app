/**
 * AI 输出的健壮性（2026-10-07）：JSON 约束解码与退回、推理模型的思考、空输出与截断、问答最后一轮、可编辑提示词。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo } from '../src/core/repo'
import { DiaryIndex } from '../src/core/diaryIndex'
import { chat, chatJson, chatText, extractJson, resetStreamMemory, stripThink, type LlmConfig } from '../src/core/llm/client'
import { extractEntry } from '../src/core/llm/extract'
import { generateMonthly } from '../src/core/llm/summarize'
import { readSummary } from '../src/core/summaries'
import { ask, systemPrompt } from '../src/core/llm/agent'
import { overrideFor, promptHash, PROMPTS, promptState, promptText } from '../src/core/llm/prompts'
import { DiaryTools } from '../src/core/llm/tools'
import { NodeStore } from './nodeStore'
import { startLlmMock, type LlmMock } from './mocks/llmServer'

let mock: LlmMock
beforeEach(() => resetStreamMemory())
afterEach(() => mock?.close())
const cfg = (protocol: 'openai' | 'anthropic', over: Partial<LlmConfig> = {}): LlmConfig => ({
  protocol,
  baseUrl: protocol === 'openai' ? `http://127.0.0.1:${mock.port}/v1` : `http://127.0.0.1:${mock.port}`,
  model: 'test-model',
  apiKey: 'sk-test',
  ...over,
})
const doc = { meta: { date: '2026-10-07' }, body: '和阿杰去老王烧烤。', extra: [] }
const vocab = { places: ['老王烧烤'], people: [], tags: [] }
const X = { places: ['老王烧烤'], people: ['阿杰'], tags: ['聚餐'] }
const sysOf = (body: Record<string, unknown>) =>
  typeof body.system === 'string' ? body.system : ((body.messages as { role: string; content: string }[])[0].content)

describe('JSON 约束解码', () => {
  it('openai：请求带 response_format: json_object', async () => {
    mock = await startLlmMock(() => ({ text: JSON.stringify(X) }))
    expect(await extractEntry(cfg('openai'), doc, vocab)).toEqual(X)
    expect(mock.requests[0].body.response_format).toEqual({ type: 'json_object' })
    expect(sysOf(mock.requests[0].body)).toContain('只输出一个 JSON 对象')
  })

  it('openai：服务不认 response_format（400）时去掉再请求，之后不再带', async () => {
    mock = await startLlmMock(({ body }) => ({ text: body.response_format ? 'x' : JSON.stringify(X) }))
    mock.failNext = 1
    mock.failWith = { status: 400, message: 'response_format is not supported' }
    expect(await extractEntry(cfg('openai'), doc, vocab)).toEqual(X)
    await extractEntry(cfg('openai'), doc, vocab)
    expect(mock.requests.map((r) => !!r.body.response_format)).toEqual([true, false, false])
  })

  it('anthropic：强制调用一个参数就是结果的工具', async () => {
    mock = await startLlmMock(({ tools }) => (tools.includes('save_extraction') ? { toolCalls: [{ name: 'save_extraction', args: X }] } : { text: '?' }))
    expect(await extractEntry(cfg('anthropic'), doc, vocab)).toEqual(X)
    const body = mock.requests[0].body
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'save_extraction' })
    expect((body.tools as { name: string; input_schema: { required: string[] } }[])[0].input_schema.required).toEqual(['places', 'people', 'tags'])
  })

  it('取不到 JSON 时把输出发回去请它只输出 JSON；还是不行就报错并带上它返回的开头', async () => {
    let n = 0
    mock = await startLlmMock(() => (++n === 1 ? { text: '好的，我来分析这篇日记。' } : { text: JSON.stringify(X) }))
    expect(await extractEntry(cfg('openai'), doc, vocab)).toEqual(X)
    const second = mock.requests[1].body.messages as { role: string; content: string }[]
    expect(second[second.length - 1].content).toContain('只输出那个 JSON 对象')

    mock.script = () => ({ text: '我觉得这天过得不错。' })
    await expect(extractEntry(cfg('openai'), doc, vocab)).rejects.toThrow('它返回的开头是：“我觉得这天过得不错。”')
  })

  it('从思考过程、代码块和说明文字里取 JSON', () => {
    expect(extractJson('<think>先想想 {不是json}</think>\n{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('结果如下：\n```json\n{"a":[1,2]}\n```\n以上。')).toEqual({ a: [1, 2] })
    expect(extractJson('结果：{"a":"含 } 括号"} 完')).toEqual({ a: '含 } 括号' })
    expect(extractJson('{坏的} 然后 {"b":2}')).toEqual({ b: 2 })
    expect(extractJson('[1,2]')).toBeNull()
  })

  it('写到一半被截断的 JSON：加大输出上限重来', async () => {
    mock = await startLlmMock(({ body }) => (Number(body.max_tokens) < 4000 ? { text: '{"places":["老王', finish: 'length' } : { text: JSON.stringify(X) }))
    const r = await chatJson(cfg('openai'), { system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 2000, json: { name: 'r', schema: {} } })
    expect(r.value).toEqual(X)
    expect(mock.requests.map((q) => q.body.max_tokens)).toEqual([2000, 4000])
  })
})

describe('推理模型与空输出', () => {
  it('思考把输出额度用完、正文为空：自动加倍重试一次', async () => {
    mock = await startLlmMock(({ body }) => (Number(body.max_tokens) < 2000 ? { reasoning: '想了很久……', text: '', finish: 'length' } : { text: '写好了。' }))
    const r = await chatText(cfg('openai'), { system: 'S', messages: [{ role: 'user', content: 'x' }], maxTokens: 1000 })
    expect(r.text).toBe('写好了。')
    expect(mock.requests.map((q) => q.body.max_tokens)).toEqual([1000, 2000])
  })

  it('手动设了最大输出就不自动重试，报错说明原因', async () => {
    mock = await startLlmMock(() => ({ reasoning: '想了很久……', text: '', finish: 'length' }))
    await expect(chatText(cfg('openai', { maxOutput: 500 }), { system: 'S', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toThrow(/输出上限（500 tokens），思考过程把额度用完了.*最大输出/)
    expect(mock.requests).toHaveLength(1)
  })

  it('空内容不再存成一份空总结', async () => {
    const store = await NodeStore.temp()
    const repo = new DiaryRepo(store)
    await repo.init()
    await repo.saveEntry({ meta: { date: '2026-09-03' }, body: '去江边。', extra: [] })
    const index = new DiaryIndex(repo, store)
    await index.load()
    mock = await startLlmMock(() => ({ text: '' }))
    await expect(generateMonthly(cfg('anthropic'), repo, index, '2026-09')).rejects.toThrow('空内容')
    expect(await readSummary(store, '2026-09')).toBeNull()
  })

  it('正文里的 <think> 思考过程不显示、不保存（流式和普通）', async () => {
    expect(stripThink('<think>嗯 {x}</think>\n\n答案')).toBe('答案')
    expect(stripThink('<thi', true)).toBe('')
    expect(stripThink('<think>还在想', true)).toBe('')
    mock = await startLlmMock(() => ({ text: '<think>先查一下{}</think>你去了三次。' }))
    const deltas: string[] = []
    const r = await chat(cfg('openai'), { system: 'S', messages: [{ role: 'user', content: 'x' }], onText: (d) => deltas.push(d) })
    expect(deltas.join('')).toBe('你去了三次。')
    expect(r.text).toBe('你去了三次。')
    expect(r.thought).toBe(true)
    const r2 = await chat(cfg('openai', { stream: false }), { system: 'S', messages: [{ role: 'user', content: 'x' }] })
    expect(r2.text).toBe('你去了三次。')
  })
})

describe('问答的最后一轮', () => {
  const tools = { run: async () => ({ total: 1 }) } as unknown as DiaryTools
  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}：不许再调用工具，并提醒它直接回答`, async () => {
      mock = await startLlmMock(({ body }) => {
        const noMore = protocol === 'openai' ? !body.tools : (body.tool_choice as { type?: string })?.type === 'none'
        return noMore ? { text: '根据查到的，一共 1 篇。' } : { toolCalls: [{ name: 'get_stats', args: {} }] }
      })
      const r = await ask({ cfg: cfg(protocol), tools, question: '几篇？', history: [], system: 'S', maxRounds: 2 })
      expect(r.answer).toBe('根据查到的，一共 1 篇。')
      const last = mock.requests[1].body
      if (protocol === 'anthropic') expect((last.tools as unknown[]).length).toBeGreaterThan(0)
      expect(JSON.stringify(last.messages)).toContain('不要再调用工具')
    })
  }

  it('回答是空的时报错，而不是显示一个空白回答', async () => {
    mock = await startLlmMock(() => ({ text: '' }))
    await expect(ask({ cfg: cfg('openai'), tools, question: '几篇？', history: [], system: 'S' })).rejects.toThrow('空内容')
  })
})

describe('可编辑的系统提示词', () => {
  it('没改用默认；改了用改的；和默认一样或清空等于没改', () => {
    expect(promptText('monthly', {})).toBe(PROMPTS.monthly.text)
    const o = overrideFor('monthly', '写得短一点。')!
    expect(promptText('monthly', { monthly: o })).toBe('写得短一点。')
    expect(promptState('monthly', { monthly: o })).toBe('custom')
    expect(overrideFor('monthly', PROMPTS.monthly.text + '\n')).toBeNull()
    expect(overrideFor('monthly', '  ')).toBeNull()
    expect(promptText('monthly', { monthly: { text: ' ', base: 'x' } })).toBe(PROMPTS.monthly.text)
  })

  it('默认版本更新过时提示；接着改不会让提示消失', () => {
    const old = { text: '旧的改法', base: promptHash('以前的默认') }
    expect(promptState('chat', { chat: old })).toBe('custom-outdated')
    expect(overrideFor('chat', '旧的改法，再加一句', old.base)!.base).toBe(old.base)
  })

  it('抽取：用改过的提示词，输出格式仍由代码接在后面', async () => {
    mock = await startLlmMock(() => ({ text: JSON.stringify(X) }))
    await extractEntry(cfg('openai'), doc, vocab, '标签只用 工作、运动、聚餐。')
    const sys = sysOf(mock.requests[0].body)
    expect(sys.startsWith('标签只用 工作、运动、聚餐。')).toBe(true)
    expect(sys).toContain('{"places": [...], "people": [...], "tags": [...]}')
  })

  it('问答：改过的提示词后面接上今天的日期和日记概况', () => {
    const s = systemPrompt('2026-10-07', '2025-01-01', '2026-10-07', 300, '你是我的日记助手。')
    expect(s).toBe('你是我的日记助手。\n\n今天是 2026-10-07。日记共 300 篇，最早 2025-01-01，最近 2026-10-07。')
  })
})

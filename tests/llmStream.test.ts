import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AbortedError, chat, resetStreamMemory, sseParser, type LlmConfig } from '../src/core/llm/client'
import { ask } from '../src/core/llm/agent'
import type { DiaryTools } from '../src/core/llm/tools'
import { lastToolResult, startLlmMock, type LlmMock } from './mocks/llmServer'

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
const msg = [{ role: 'user' as const, content: 'hi' }]

describe('流式输出', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}：文字分几块到达，结果和用量完整`, async () => {
      mock = await startLlmMock(() => ({ text: '你这个月去了三次江边公园。' }))
      const deltas: string[] = []
      const r = await chat(cfg(protocol), { system: 'S', messages: msg, onText: (d) => deltas.push(d) })
      expect(deltas.length).toBeGreaterThan(1)
      expect(deltas.join('')).toBe('你这个月去了三次江边公园。')
      expect(r.text).toBe('你这个月去了三次江边公园。')
      expect(r.usage).toEqual({ input: 100, output: 10 })
      expect(mock.requests[0].body.stream).toBe(true)
    })

    it(`${protocol}：工具调用的参数分块到达后拼完整`, async () => {
      mock = await startLlmMock(() => ({ toolCalls: [{ name: 'count_days', args: { terms: ['老王烧烤', '老王'], from: '2026-01-01' } }] }))
      const r = await chat(cfg(protocol), { system: 'S', messages: msg, onText: () => {} })
      expect(r.toolCalls).toHaveLength(1)
      expect(r.toolCalls[0].name).toBe('count_days')
      expect(r.toolCalls[0].args).toEqual({ terms: ['老王烧烤', '老王'], from: '2026-01-01' })
      expect(r.toolCalls[0].id).toMatch(/^call_/)
    })
  }

  it('问答循环：每一轮开始时通知界面，最后一轮的文字流式显示', async () => {
    mock = await startLlmMock(({ turns }) => (lastToolResult(turns) ? { text: '一共 3 篇。' } : { text: '我查一下。', toolCalls: [{ name: 'get_stats', args: {} }] }))
    const tools = { run: async () => ({ total: 3 }) } as unknown as DiaryTools
    let shown = ''
    let rounds = 0
    const r = await ask({
      cfg: cfg('openai'), tools, question: '几篇？', history: [], system: 'S',
      onRound: () => {
        rounds++
        shown = ''
      },
      onText: (d) => (shown += d),
    })
    expect(rounds).toBe(2)
    expect(shown).toBe('一共 3 篇。')
    expect(r.answer).toBe('一共 3 篇。')
    expect(r.usage).toEqual({ input: 200, output: 20, calls: 2 })
  })

  it('服务不支持流式（400）时自动改用普通请求，之后不再尝试', async () => {
    mock = await startLlmMock(() => ({ text: '好的' }))
    mock.streamMode = 'reject'
    const got: string[] = []
    const r = await chat(cfg('openai'), { system: 'S', messages: msg, onText: (d) => got.push(d) })
    expect(r.text).toBe('好的')
    expect(got).toEqual(['好的'])
    expect(mock.requests.map((q) => !!q.body.stream)).toEqual([true, false])
    await chat(cfg('openai'), { system: 'S', messages: msg, onText: () => {} })
    expect(mock.requests.map((q) => !!q.body.stream)).toEqual([true, false, false])
  })

  it('不认识 stream_options 时去掉它再流式请求一次', async () => {
    mock = await startLlmMock(() => ({ text: '好的呀' }))
    mock.streamMode = 'rejectOptions'
    const got: string[] = []
    const r = await chat(cfg('openai'), { system: 'S', messages: msg, onText: (d) => got.push(d) })
    expect(r.text).toBe('好的呀')
    expect(got.length).toBeGreaterThan(1)
    expect(mock.requests.map((q) => [!!q.body.stream, !!q.body.stream_options])).toEqual([[true, true], [true, false]])
  })

  it('服务忽略 stream 参数直接返回 JSON 时也能用', async () => {
    mock = await startLlmMock(() => ({ text: '整段返回' }))
    mock.streamMode = 'ignore'
    const got: string[] = []
    const r = await chat(cfg('anthropic'), { system: 'S', messages: msg, onText: (d) => got.push(d) })
    expect(r.text).toBe('整段返回')
    expect(got).toEqual(['整段返回'])
  })

  it('关掉流式时发普通请求', async () => {
    mock = await startLlmMock(() => ({ text: 'x' }))
    await chat(cfg('openai', { stream: false }), { system: 'S', messages: msg, onText: () => {} })
    expect(mock.requests[0].body.stream).toBeUndefined()
  })

  it('停止：已收到的文字留下，抛出“已停止”', async () => {
    mock = await startLlmMock(() => ({ text: '第一段，第二段，第三段。' }))
    mock.chunkDelay = 150
    const ctl = new AbortController()
    let shown = ''
    const p = chat(cfg('openai'), {
      system: 'S', messages: msg, signal: ctl.signal,
      onText: (d) => {
        shown += d
        ctl.abort()
      },
    })
    await expect(p).rejects.toBeInstanceOf(AbortedError)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan('第一段，第二段，第三段。'.length)
  })

  it('SSE 里的错误事件变成能看懂的报错', () => {
    const p = sseParser('openai')
    p.line('data: {"error":{"message":"余额不足"}}')
    expect(() => p.result()).toThrow('余额不足')
  })
})

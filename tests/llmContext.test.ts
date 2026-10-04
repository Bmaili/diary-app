import { afterEach, describe, expect, it } from 'vitest'
import { DiaryRepo } from '../src/core/repo'
import { DiaryIndex } from '../src/core/diaryIndex'
import { chat, parseExtraBody, type ChatMsg, type LlmConfig } from '../src/core/llm/client'
import { DiaryTools } from '../src/core/llm/tools'
import { ask, estimateTokens, fitContext, OMITTED } from '../src/core/llm/agent'
import { NodeStore } from './nodeStore'
import { startLlmMock, type LlmMock } from './mocks/llmServer'

let mock: LlmMock
afterEach(() => mock?.close())
const cfg = (protocol: 'openai' | 'anthropic', over: Partial<LlmConfig> = {}): LlmConfig => ({
  protocol,
  baseUrl: protocol === 'openai' ? `http://127.0.0.1:${mock.port}/v1` : `http://127.0.0.1:${mock.port}`,
  model: 'test-model',
  apiKey: 'sk-test',
  ...over,
})

describe('上下文控制', () => {
  it('估算：汉字按 1 个 token，其他字符约 2.5 个一个', () => {
    expect(estimateTokens('今天去了健身房')).toBe(7)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('超出预算时先省略较早的工具结果，最新一批保留', () => {
    const big = '字'.repeat(3000)
    const msgs: ChatMsg[] = [
      { role: 'user', content: '旧问题' },
      { role: 'assistant', content: '旧回答' },
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'get_entries', args: {} }] },
      { role: 'tool', toolCallId: 'a', name: 'get_entries', content: big },
      { role: 'assistant', content: '', toolCalls: [{ id: 'b', name: 'get_entries', args: {} }] },
      { role: 'tool', toolCallId: 'b', name: 'get_entries', content: big },
    ]
    const r = fitContext(msgs, 4000, 2)
    expect(r).toEqual({ changed: true, history: 2 })
    expect((msgs[4] as { content: string }).content).toBe(OMITTED)
    expect((msgs[6] as { content: string }).content).toBe(big)
  })

  it('还不够就丢掉历史问答，再截断最新的结果', () => {
    const msgs: ChatMsg[] = [
      { role: 'user', content: '旧'.repeat(500) },
      { role: 'assistant', content: '答'.repeat(500) },
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'get_entries', args: {} }] },
      { role: 'tool', toolCallId: 'a', name: 'get_entries', content: '字'.repeat(5000) },
    ]
    const r = fitContext(msgs, 2000, 2)
    expect(r.history).toBe(0)
    expect(msgs[0]).toEqual({ role: 'user', content: '新问题' })
    const tool = msgs[2] as { content: string }
    expect(tool.content).toContain('已截断')
    expect(msgs.reduce((a, m) => a + estimateTokens(m.content) + estimateTokens(m.role === 'assistant' && m.toolCalls ? JSON.stringify(m.toolCalls) : '') + 8, 0)).toBeLessThanOrEqual(2000)
  })

  it('问答循环：按上下文长度限制读原文，并累计 token 用量', async () => {
    const store = await NodeStore.temp()
    const repo = new DiaryRepo(store)
    await repo.init()
    for (let d = 1; d <= 20; d++) {
      await repo.saveEntry({ meta: { date: `2026-09-${String(d).padStart(2, '0')}` }, body: `第 ${d} 天。${'很长的日记。'.repeat(300)}`, extra: [] })
    }
    const index = new DiaryIndex(repo, store)
    await index.load()
    let round = 0
    mock = await startLlmMock(() => {
      round++
      return round <= 6 ? { toolCalls: [{ name: 'get_entries', args: { from: '2026-09-01', to: '2026-09-30', max_chars: 40000 } }] } : { text: '读完了。' }
    })
    const r = await ask({
      cfg: cfg('openai', { contextTokens: 12000 }), tools: new DiaryTools(index, repo, store),
      question: '九月都写了什么？', history: [], system: 'SYS',
    })
    expect(r.answer).toBe('读完了。')
    expect(r.usage).toEqual({ input: 700, output: 70, calls: 7 })
    // 每次发出去的消息都没有超过上下文长度
    for (const req of mock.requests) {
      const text = JSON.stringify((req.body.messages as unknown[]))
      expect(estimateTokens(text)).toBeLessThan(12000)
    }
    expect(r.compacted).toBe(true)
  })
})

describe('高级设置', () => {
  for (const protocol of ['openai', 'anthropic'] as const) {
    it(`${protocol}：最大输出、温度、额外参数写进请求；用量取自服务返回`, async () => {
      mock = await startLlmMock(() => ({ text: 'ok' }))
      const r = await chat(cfg(protocol, { maxOutput: 8000, temperature: 1, extraBody: { enable_thinking: false } }), {
        system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 600, temperature: 0,
      })
      const body = mock.requests[0].body
      expect(body.max_tokens).toBe(8000)
      expect(body.temperature).toBe(1)
      expect(body.enable_thinking).toBe(false)
      expect(r.usage).toEqual({ input: 100, output: 10 })
    })
  }

  it('没设置时按功能的默认值', async () => {
    mock = await startLlmMock(() => ({ text: 'ok' }))
    await chat(cfg('openai'), { system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 600, temperature: 0 })
    expect(mock.requests[0].body.max_tokens).toBe(600)
    expect(mock.requests[0].body.temperature).toBe(0)
  })

  it('额外参数要是 JSON 对象，不能覆盖基本字段', () => {
    expect(parseExtraBody('')).toBeUndefined()
    expect(parseExtraBody(' {"enable_thinking": false} ')).toEqual({ enable_thinking: false })
    expect(() => parseExtraBody('{oops')).toThrow('不是合法的 JSON')
    expect(() => parseExtraBody('[1]')).toThrow('JSON 对象')
    expect(() => parseExtraBody('{"messages": []}')).toThrow('messages')
  })

  it('超出上下文的报错换成能看懂的提示', async () => {
    mock = await startLlmMock(() => ({ text: 'ok' }))
    mock.failNext = 1
    mock.failWith = { status: 400, message: "This model's maximum context length is 65536 tokens. However, you requested 70000 tokens." }
    await expect(chat(cfg('openai'), { system: 'S', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow('超出了模型的上下文长度')
  })
})

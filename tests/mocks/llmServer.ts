/**
 * 模拟 LLM 服务，同时支持 OpenAI 兼容协议（/v1/chat/completions）和 Anthropic 协议（/v1/messages）。
 * 回答由测试提供的“剧本”函数决定：剧本看到的是统一格式的对话，返回文字或工具调用。
 * 同时记录原始请求，用来检查两种协议的报文格式。
 */
import http from 'node:http'

export interface Turn {
  role: 'user' | 'assistant' | 'tool'
  text?: string
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[]
  toolCallId?: string
}

export type Script = (ctx: { system: string; turns: Turn[]; tools: string[]; body: Record<string, unknown> }) => {
  text?: string
  toolCalls?: { name: string; args: Record<string, unknown> }[]
  /** 推理模型的思考过程（OpenAI 兼容协议的 reasoning_content） */
  reasoning?: string
  /** 结束原因，默认 stop / end_turn / tool_calls；'length' 表示到了输出上限 */
  finish?: 'length'
}

export interface LlmMock {
  port: number
  requests: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[]
  script: Script
  /** 让接下来的 n 次请求失败 */
  failNext: number
  /** 失败时的状态码和错误信息，默认 500 boom */
  failWith?: { status: number; message: string }
  /**
   * 收到 stream: true 时怎么办：
   * sse（默认，分几块按 SSE 返回）、reject（400，不支持流式）、ignore（忽略，照常返回 JSON）、
   * rejectOptions（不认识 stream_options 时 400）
   */
  streamMode?: 'sse' | 'reject' | 'ignore' | 'rejectOptions'
  /** 每块之间的间隔（毫秒），用来测停止 */
  chunkDelay?: number
  close: () => Promise<void>
}

export async function startLlmMock(script: Script, opts: { key?: string } = {}): Promise<LlmMock> {
  let n = 0
  const mock: LlmMock = {
    port: 0,
    requests: [],
    script,
    failNext: 0,
    close: () => new Promise((r) => server.close(() => r())),
  }
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    mock.requests.push({ path: req.url!, headers: req.headers, body })
    const json = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data))
    if (mock.failNext > 0) {
      mock.failNext--
      return json(mock.failWith?.status ?? 500, { error: { message: mock.failWith?.message ?? 'boom' } })
    }
    const anthropic = req.url!.endsWith('/v1/messages')
    const auth = anthropic ? req.headers['x-api-key'] : String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (opts.key && auth !== opts.key) return json(401, { error: { message: 'invalid key' } })

    const turns: Turn[] = []
    let system = ''
    if (anthropic) {
      system = body.system
      for (const m of body.messages) {
        for (const b of m.content) {
          if (b.type === 'text') turns.push({ role: m.role, text: b.text })
          if (b.type === 'tool_use') turns.push({ role: 'assistant', toolCalls: [{ id: b.id, name: b.name, args: b.input }] })
          if (b.type === 'tool_result') turns.push({ role: 'tool', toolCallId: b.tool_use_id, text: b.content })
        }
      }
    } else {
      for (const m of body.messages) {
        if (m.role === 'system') system = m.content
        else if (m.role === 'tool') turns.push({ role: 'tool', toolCallId: m.tool_call_id, text: m.content })
        else
          turns.push({
            role: m.role,
            // 带图片时 content 是数组（文字块 + 图片块）
            text: Array.isArray(m.content) ? m.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('') : (m.content ?? ''),
            toolCalls: m.tool_calls?.map((c: { id: string; function: { name: string; arguments: string } }) => ({ id: c.id, name: c.function.name, args: JSON.parse(c.function.arguments) })),
          })
      }
    }
    const tools = (body.tools ?? []).map((t: { name?: string; function?: { name: string } }) => t.name ?? t.function!.name)
    const out = mock.script({ system, turns, tools, body })
    const calls = (out.toolCalls ?? []).map((c) => ({ ...c, id: `call_${++n}` }))
    const mode = mock.streamMode ?? 'sse'
    if (body.stream && mode === 'reject') return json(400, { error: { message: 'stream is not supported' } })
    if (body.stream && mode === 'rejectOptions' && body.stream_options) return json(400, { error: { message: 'Unrecognized request argument: stream_options' } })
    if (body.stream && mode !== 'ignore') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const text = out.text ?? ''
      const pieces = text ? [text.slice(0, Math.ceil(text.length / 3)), text.slice(Math.ceil(text.length / 3), Math.ceil((2 * text.length) / 3)), text.slice(Math.ceil((2 * text.length) / 3))].filter(Boolean) : []
      const send = async (ev: unknown, name?: string) => {
        if (res.destroyed) return
        res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(ev)}\n\n`)
        if (mock.chunkDelay) await new Promise((r) => setTimeout(r, mock.chunkDelay))
      }
      if (anthropic) {
        await send({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }, 'message_start')
        let i = 0
        if (pieces.length) {
          await send({ type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }, 'content_block_start')
          for (const p of pieces) await send({ type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: p } }, 'content_block_delta')
          await send({ type: 'content_block_stop', index: i++ }, 'content_block_stop')
        }
        for (const c of calls) {
          await send({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }, 'content_block_start')
          const js = JSON.stringify(c.args)
          await send({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: js.slice(0, 5) } }, 'content_block_delta')
          await send({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: js.slice(5) } }, 'content_block_delta')
          await send({ type: 'content_block_stop', index: i++ }, 'content_block_stop')
        }
        await send({ type: 'message_delta', delta: { stop_reason: out.finish ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, 'message_delta')
        await send({ type: 'message_stop' }, 'message_stop')
      } else {
        if (out.reasoning) await send({ choices: [{ index: 0, delta: { reasoning_content: out.reasoning } }] })
        for (const p of pieces) await send({ choices: [{ index: 0, delta: { content: p } }] })
        for (const [i, c] of calls.entries()) {
          const js = JSON.stringify(c.args)
          await send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: js.slice(0, 5) } }] } }] })
          await send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: js.slice(5) } }] } }] })
        }
        await send({ choices: [{ index: 0, delta: {}, finish_reason: out.finish ?? (calls.length ? 'tool_calls' : 'stop') }] })
        if (body.stream_options) await send({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })
        if (!res.destroyed) res.write('data: [DONE]\n\n')
      }
      return res.end()
    }
    if (anthropic) {
      json(200, {
        content: [
          ...(out.reasoning ? [{ type: 'thinking', thinking: out.reasoning }] : []),
          ...(out.text ? [{ type: 'text', text: out.text }] : []),
          ...calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
        ],
        stop_reason: out.finish ? 'max_tokens' : calls.length ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
      })
    } else {
      json(200, {
        choices: [{
          message: {
            role: 'assistant',
            content: out.text ?? null,
            ...(out.reasoning ? { reasoning_content: out.reasoning } : {}),
            ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
          },
          finish_reason: out.finish ?? (calls.length ? 'tool_calls' : 'stop'),
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      })
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  mock.port = (server.address() as { port: number }).port
  return mock
}

/** 最后一条工具结果（已解析） */
export function lastToolResult(turns: Turn[]): Record<string, unknown> | null {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].role === 'tool') return JSON.parse(turns[i].text!)
  return null
}

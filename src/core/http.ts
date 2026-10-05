/**
 * 统一的 HTTP 层。默认用 fetch（浏览器调试、单元测试）；真机启动时换成原生实现（platform/nativeHttp.ts），
 * 原生请求不受浏览器跨域限制，并能正确收发二进制。
 */
export interface HttpRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  /** 字符串（JSON、文本）或二进制 */
  body?: string | Uint8Array
  /** 期望的响应体类型 */
  responseType?: 'text' | 'bytes'
  timeoutMs?: number
}

export interface HttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  text: () => string
  json: <T = unknown>() => T
  bytes: () => Uint8Array
}

export class NetworkError extends Error {}

export type HttpImpl = (req: HttpRequest) => Promise<HttpResponse>

export const fetchImpl: HttpImpl = async (req) => {
  const ctl = new AbortController()
  const ms = req.timeoutMs ?? 30000
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: req.headers,
      body: req.body as BodyInit | undefined,
      signal: ctl.signal,
    })
    const buf = new Uint8Array(await res.arrayBuffer())
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    const text = () => new TextDecoder().decode(buf)
    return { status: res.status, ok: res.ok, headers, text, json: <T>() => JSON.parse(text()) as T, bytes: () => buf }
  } catch (e) {
    const name = (e as Error).name
    throw new NetworkError(name === 'AbortError' ? `连接超时（${ms / 1000} 秒）` : `网络错误：${(e as Error).message}`)
  } finally {
    clearTimeout(t)
  }
}

let impl: HttpImpl = fetchImpl

export function setHttpImpl(i: HttpImpl) {
  impl = i
}

export function http(req: HttpRequest): Promise<HttpResponse> {
  return impl(req)
}

// ---------- 流式响应（AI 问答逐字显示，2026-10-04 加入） ----------

export interface StreamRequest extends HttpRequest {
  signal?: AbortSignal
}

export interface StreamResult {
  status: number
  ok: boolean
  /** 出错（非 2xx）时的响应体 */
  errorText: string
}

/** 按行回调响应体（SSE 用）。非 2xx 时不回调，响应体放在 errorText 里。timeoutMs 是两次收到数据之间的最长等待。 */
export type StreamImpl = (req: StreamRequest, onLine: (line: string) => void) => Promise<StreamResult>

export class AbortedError extends Error {
  constructor() {
    super('已停止')
  }
}

export const fetchStreamImpl: StreamImpl = async (req, onLine) => {
  const ctl = new AbortController()
  const ms = req.timeoutMs ?? 30000
  let timedOut = false
  let t = setTimeout(() => ((timedOut = true), ctl.abort()), ms)
  const bump = () => {
    clearTimeout(t)
    t = setTimeout(() => ((timedOut = true), ctl.abort()), ms)
  }
  const onAbort = () => ctl.abort()
  req.signal?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(req.url, { method: req.method ?? 'POST', headers: req.headers, body: req.body as BodyInit | undefined, signal: ctl.signal })
    if (!res.ok) return { status: res.status, ok: false, errorText: await res.text() }
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      bump()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ''))
        buf = buf.slice(i + 1)
      }
    }
    buf += dec.decode()
    if (buf) onLine(buf.replace(/\r$/, ''))
    return { status: res.status, ok: true, errorText: '' }
  } catch (e) {
    if (req.signal?.aborted) throw new AbortedError()
    if (timedOut) throw new NetworkError(`连接超时（${ms / 1000} 秒没有收到数据）`)
    throw new NetworkError(`网络错误：${(e as Error).message}`)
  } finally {
    clearTimeout(t)
    req.signal?.removeEventListener('abort', onAbort)
  }
}

let streamImpl: StreamImpl = fetchStreamImpl

export function setStreamImpl(i: StreamImpl) {
  streamImpl = i
}

export function httpStream(req: StreamRequest, onLine: (line: string) => void): Promise<StreamResult> {
  if (req.signal?.aborted) return Promise.reject(new AbortedError())
  return streamImpl(req, onLine)
}

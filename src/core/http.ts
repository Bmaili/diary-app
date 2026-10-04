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

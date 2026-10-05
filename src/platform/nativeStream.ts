/**
 * 真机上的流式 HTTP：调用本工程的原生插件 HttpStream（android/.../HttpStreamPlugin.java）。
 * 原生请求不受网页跨域限制；每收到一行通过 "line" 事件送回来。
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { AbortedError, NetworkError, type StreamImpl } from '../core/http'

interface HttpStreamPlugin {
  request(o: { id: string; url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<{ status: number; body?: string }>
  cancel(o: { id: string }): Promise<void>
  addListener(ev: 'line', fn: (e: { id: string; line: string }) => void): Promise<PluginListenerHandle>
}

const HttpStream = registerPlugin<HttpStreamPlugin>('HttpStream')
const handlers = new Map<string, (line: string) => void>()
let listening: Promise<PluginListenerHandle> | null = null
let seq = 0

export const nativeStreamImpl: StreamImpl = async (req, onLine) => {
  listening ??= HttpStream.addListener('line', (e) => handlers.get(e.id)?.(e.line))
  await listening
  const id = `s${Date.now()}_${++seq}`
  handlers.set(id, onLine)
  const onAbort = () => void HttpStream.cancel({ id }).catch(() => {})
  req.signal?.addEventListener('abort', onAbort)
  const ms = req.timeoutMs ?? 30000
  try {
    const r = await HttpStream.request({
      id, url: req.url, method: req.method ?? 'POST', headers: req.headers ?? {},
      body: typeof req.body === 'string' ? req.body : undefined, timeoutMs: ms,
    })
    return { status: r.status, ok: r.status >= 200 && r.status < 300, errorText: r.body ?? '' }
  } catch (e) {
    if (req.signal?.aborted) throw new AbortedError()
    const err = e as { message?: string; code?: string }
    throw new NetworkError(err.code === 'TIMEOUT' ? `连接超时（${ms / 1000} 秒没有收到数据）` : `网络错误：${err.message ?? String(e)}`)
  } finally {
    handlers.delete(id)
    req.signal?.removeEventListener('abort', onAbort)
  }
}

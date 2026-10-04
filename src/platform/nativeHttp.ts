/**
 * 真机上的 HTTP：直接调用 Capacitor 原生 HTTP 插件。
 * 不使用它对 window.fetch 的自动替换，因为那个替换会把二进制请求体当文本解码，损坏图片。
 * - 二进制请求体以 base64 传给原生层（dataType: 'file'），由原生解码后发送；
 * - 需要二进制响应时用 responseType: 'arraybuffer'，原生层返回 base64；
 * - JSON 响应会被原生层解析成对象，这里再转回文本，保持与 fetch 版一致。
 */
import { CapacitorHttp } from '@capacitor/core'
import { fromBase64, toBase64, utf8 } from '../core/bytes'
import { NetworkError, type HttpImpl } from '../core/http'

export const nativeHttpImpl: HttpImpl = async (req) => {
  const headers = { ...(req.headers ?? {}) }
  let data: unknown
  let dataType: string | undefined
  if (req.body instanceof Uint8Array) {
    data = toBase64(req.body)
    dataType = 'file'
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/octet-stream'
  } else if (typeof req.body === 'string') {
    data = req.body
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'text/plain; charset=utf-8'
  }
  const ms = req.timeoutMs ?? 30000
  let res
  try {
    res = await CapacitorHttp.request({
      url: req.url,
      method: req.method ?? 'GET',
      headers,
      data,
      dataType: dataType as never,
      responseType: req.responseType === 'bytes' ? 'arraybuffer' : 'text',
      connectTimeout: ms,
      readTimeout: ms,
    })
  } catch (e) {
    const msg = (e as Error).message ?? String(e)
    throw new NetworkError(/timeout|timed out/i.test(msg) ? `连接超时（${ms / 1000} 秒）` : `网络错误：${msg}`)
  }
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = String(v)
  const raw = res.data
  const asText = () => (typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw))
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: lower,
    text: () => (req.responseType === 'bytes' && typeof raw === 'string' && res.status < 300 ? new TextDecoder().decode(fromBase64(raw)) : asText()),
    json: <T>() => (typeof raw === 'object' && raw !== null ? (raw as T) : (JSON.parse(asText()) as T)),
    bytes: () => (req.responseType === 'bytes' && typeof raw === 'string' && res.status < 300 ? fromBase64(raw) : utf8(asText())),
  }
}

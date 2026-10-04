/** 字节、编码与哈希工具，基于 WebCrypto，在 WebView 和 Node 中都能用。 */

const enc = new TextEncoder()
const dec = new TextDecoder()

export const utf8 = (s: string): Uint8Array => enc.encode(s)
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b)

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s+/g, ''))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function hex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

const asBuf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const b = typeof data === 'string' ? utf8(data) : data
  return hex(await crypto.subtle.digest('SHA-256', asBuf(b)))
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-1', asBuf(data)))
}

export async function hmacSha256(key: Uint8Array | string, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw', asBuf(typeof key === 'string' ? utf8(key) : key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, asBuf(utf8(msg))))
}

/** 与 encodeURIComponent 相同，另外编码 !'()*（RFC 3986） */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

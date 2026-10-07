/**
 * 阿里云 OSS（规格 6.3），使用 V4 签名（OSS4-HMAC-SHA256）。
 * 签名算法与阿里云官方 SDK ali-oss 的 authorizationV4 逐字节一致（见 tests/oss.test.ts）。
 */
import { hex, hmacSha256, sha256Hex, uriEncode } from '../bytes'
import type { HttpResponse } from '../http'
import { call, contentTypeOf, pool, RemoteError, type RemoteFile, type RemoteStore, type Upload } from './remote'

export interface OssConfig {
  /** 如 oss-cn-hangzhou.aliyuncs.com，可带 https:// */
  endpoint: string
  bucket: string
  /** 路径前缀，默认 diary/ */
  prefix: string
  accessKeyId: string
  accessKeySecret: string
}

export function normalizeEndpoint(ep: string): { host: string; scheme: string } {
  const m = /^(https?):\/\//i.exec(ep.trim())
  const scheme = m ? m[1].toLowerCase() : 'https'
  const host = ep.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return { host, scheme }
}

/** 从 Endpoint 推出地域，例如 oss-cn-hangzhou.aliyuncs.com → cn-hangzhou */
export function regionOf(endpoint: string): string {
  const host = normalizeEndpoint(endpoint).host
  const m = /^oss-([a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com/i.exec(host)
  if (!m) throw new RemoteError('Endpoint 格式不对，应形如 oss-cn-hangzhou.aliyuncs.com', undefined, false)
  return m[1]
}

export function normalizePrefix(p: string): string {
  const s = p.trim().replace(/^\/+/, '')
  return s && !s.endsWith('/') ? s + '/' : s
}

/** x-oss-date 格式：20250328T101048Z */
export function ossDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export interface SignInput {
  method: string
  bucket: string
  key: string
  query: Record<string, string | null>
  headers: Record<string, string>
}

/** 构造规范请求（规格见阿里云文档“实现 V4 签名算法以构建 Authorization 请求头”） */
export function canonicalRequest(i: SignInput): string {
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(i.headers)) headers[k.toLowerCase()] = v
  const uri = uriEncode(`/${i.bucket}/${i.key}`).replace(/%2F/g, '/')
  const query = Object.keys(i.query)
    .map((k) => [uriEncode(k), i.query[k]] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => (v == null ? k : `${k}=${uriEncode(v)}`))
    .join('&')
  const signed = Object.keys(headers)
    .filter((h) => h === 'content-type' || h === 'content-md5' || h.startsWith('x-oss-'))
    .sort()
  const canonHeaders = signed.map((h) => `${h}:${headers[h].trim()}\n`).join('')
  return [i.method.toUpperCase(), uri, query, canonHeaders, '', headers['x-oss-content-sha256'] || 'UNSIGNED-PAYLOAD'].join('\n')
}

export async function authorization(cfg: OssConfig, i: SignInput, region: string): Promise<string> {
  const stamp = i.headers['x-oss-date']
  const day = stamp.slice(0, 8)
  const scope = `${day}/${region}/oss/aliyun_v4_request`
  const toSign = ['OSS4-HMAC-SHA256', stamp, scope, await sha256Hex(canonicalRequest(i))].join('\n')
  let k = await hmacSha256(`aliyun_v4${cfg.accessKeySecret}`, day)
  k = await hmacSha256(k, region)
  k = await hmacSha256(k, 'oss')
  k = await hmacSha256(k, 'aliyun_v4_request')
  const sig = hex(await hmacSha256(k, toSign))
  return `OSS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope},Signature=${sig}`
}

function xmlValues(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]))
  return out
}
const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

export class OssStore implements RemoteStore {
  readonly id = 'oss' as const
  readonly label = '阿里云 OSS'
  private region: string
  private prefix: string

  constructor(private cfg: OssConfig, private now: () => Date = () => new Date()) {
    this.region = regionOf(cfg.endpoint)
    this.prefix = normalizePrefix(cfg.prefix ?? 'diary/')
  }

  private async request(
    method: string,
    key: string,
    opts: { query?: Record<string, string | null>; body?: Uint8Array; contentType?: string; bytes?: boolean } = {},
  ): Promise<HttpResponse> {
    const { host, scheme } = normalizeEndpoint(this.cfg.endpoint)
    const headers: Record<string, string> = {
      'x-oss-content-sha256': 'UNSIGNED-PAYLOAD',
      'x-oss-date': ossDate(this.now()),
    }
    if (opts.contentType) headers['content-type'] = opts.contentType
    const query = opts.query ?? {}
    headers.authorization = await authorization(this.cfg, { method, bucket: this.cfg.bucket, key, query, headers }, this.region)
    const qs = Object.entries(query)
      .map(([k, v]) => (v == null ? uriEncode(k) : `${uriEncode(k)}=${uriEncode(v)}`))
      .join('&')
    const path = key.split('/').map(uriEncode).join('/')
    const url = `${scheme}://${this.cfg.bucket}.${host}/${path}${qs ? '?' + qs : ''}`
    const res = await call({ url, method, headers, body: opts.body, responseType: opts.bytes ? 'bytes' : 'text' })
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = res.text()
      const code = xmlValues(text, 'Code')[0]
      const msg = xmlValues(text, 'Message')[0]
      const hint: Record<string, string> = {
        InvalidAccessKeyId: 'AccessKey ID 不存在',
        SignatureDoesNotMatch: 'AccessKey Secret 不对',
        AccessDenied: '这个 AccessKey 没有该 Bucket 的权限',
        NoSuchBucket: 'Bucket 不存在，或 Endpoint 地域不对',
      }
      throw new RemoteError(
        `OSS 返回 ${res.status}${code ? ` ${code}` : ''}${hint[code] ? `：${hint[code]}` : msg ? `：${msg}` : ''}`,
        res.status,
        res.status >= 500 || res.status === 429,
      )
    }
    return res
  }

  async list(): Promise<RemoteFile[]> {
    const out: RemoteFile[] = []
    let token: string | null = null
    do {
      const query: Record<string, string | null> = { 'list-type': '2', prefix: this.prefix, 'max-keys': '1000' }
      if (token) query['continuation-token'] = token
      const xml = (await this.request('GET', '', { query })).text()
      const blocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []
      for (const b of blocks) {
        const key = xmlValues(b, 'Key')[0]
        if (!key || key.endsWith('/')) continue
        out.push({ path: key.slice(this.prefix.length), size: Number(xmlValues(b, 'Size')[0] ?? 0) })
      }
      token = xmlValues(xml, 'IsTruncated')[0] === 'true' ? (xmlValues(xml, 'NextContinuationToken')[0] ?? null) : null
    } while (token)
    return out
  }

  async apply(uploads: Upload[], deletes: string[], onDone: (p: string, k: 'upload' | 'delete') => Promise<void>) {
    await pool(uploads, 4, async (u) => {
      await this.request('PUT', this.prefix + u.path, { body: u.bytes, contentType: contentTypeOf(u.path) })
      await onDone(u.path, 'upload')
    })
    await pool(deletes, 4, async (p) => {
      await this.request('DELETE', this.prefix + p)
      await onDone(p, 'delete')
    })
  }

  async get(path: string): Promise<Uint8Array | null> {
    try {
      return (await this.request('GET', this.prefix + path, { bytes: true })).bytes()
    } catch (e) {
      if (e instanceof RemoteError && e.status === 404) return null
      throw e
    }
  }

  async downloadAll(onFile: (path: string, bytes: Uint8Array) => Promise<void>, onProgress?: (d: number, t: number) => void) {
    const files = await this.list()
    let done = 0
    await pool(files, 6, async (f) => {
      const res = await this.request('GET', this.prefix + f.path, { bytes: true })
      await onFile(f.path, res.bytes())
      onProgress?.(++done, files.length)
    })
    return files.length
  }

  async test(): Promise<void> {
    const key = `${this.prefix}.connection-test-${Date.now()}.txt`
    await this.request('PUT', key, { body: new TextEncoder().encode('ok'), contentType: 'text/plain' })
    await this.request('DELETE', key)
  }
}

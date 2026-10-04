/**
 * 模拟阿里云 OSS：内存存储对象，并用阿里云官方 SDK（ali-oss）的 authorizationV4 校验每个请求的签名。
 * 客户端请求 https://<bucket>.<endpoint>/<key> 时，测试把它改写成 http://127.0.0.1:<port>/<bucket>/<key>。
 */
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const signUtils = require('ali-oss/lib/common/signUtils.js')

export interface OssMock {
  port: number
  objects: Map<string, { body: Buffer; type: string }>
  requests: { method: string; key: string }[]
  /** 让接下来的 n 个请求返回 500 */
  failNext: (n: number) => void
  close: () => Promise<void>
}

export async function startOssMock(opts: { bucket: string; region: string; id: string; secret: string }): Promise<OssMock> {
  const objects = new Map<string, { body: Buffer; type: string }>()
  const requests: { method: string; key: string }[] = []
  let failures = 0
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url!, 'http://x')
    const parts = url.pathname.split('/').slice(1)
    const bucket = decodeURIComponent(parts[0])
    const key = parts.slice(1).map(decodeURIComponent).join('/')
    requests.push({ method: req.method!, key })
    if (failures > 0) {
      failures--
      res.writeHead(500).end('<Error><Code>InternalError</Code></Error>')
      return
    }
    const queries: Record<string, string> = {}
    url.searchParams.forEach((v, k) => (queries[k] = v))
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
    const expected = signUtils.authorizationV4(opts.id, opts.secret, opts.region, req.method, { headers, queries }, bucket, key || undefined)
    if (bucket !== opts.bucket) {
      res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>')
      return
    }
    if (headers.authorization !== expected) {
      res.writeHead(403).end(`<Error><Code>SignatureDoesNotMatch</Code><Message>expected ${expected}</Message></Error>`)
      return
    }
    if (req.method === 'PUT') {
      objects.set(key, { body, type: headers['content-type'] ?? '' })
      res.writeHead(200, { ETag: '"x"' }).end()
    } else if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204).end()
    } else if (req.method === 'GET' && key) {
      const o = objects.get(key)
      if (!o) res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>')
      else res.writeHead(200, { 'Content-Type': o.type }).end(o.body)
    } else if (req.method === 'GET') {
      // ListObjectsV2，每页最多 max-keys 个
      const prefix = queries.prefix ?? ''
      const max = Number(queries['max-keys'] ?? 1000)
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = queries['continuation-token'] ? Number(queries['continuation-token']) : 0
      const page = all.slice(start, start + max)
      const truncated = start + max < all.length
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
      res.writeHead(200, { 'Content-Type': 'application/xml' }).end(
        `<?xml version="1.0"?><ListBucketResult><IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${start + max}</NextContinuationToken>` : '') +
          page.map((k) => `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k)!.body.length}</Size></Contents>`).join('') +
          `</ListBucketResult>`,
      )
    } else res.writeHead(405).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    port,
    objects,
    requests,
    failNext: (n) => (failures = n),
    close: () => new Promise((r) => server.close(() => r())),
  }
}

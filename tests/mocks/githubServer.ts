/** 模拟 GitHub REST API 中同步用到的部分：Git Data API、Contents API（空仓库初始化）、zipball。 */
import http from 'node:http'
import crypto from 'node:crypto'
import JSZip from 'jszip'

const sha = (s: string | Buffer) => crypto.createHash('sha1').update(s).digest('hex')
const blobSha = (b: Buffer) => sha(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b]))

export interface GitHubMock {
  port: number
  /** 当前分支上的文件：路径 → 内容 */
  files: () => Map<string, Buffer>
  commits: () => { message: string }[]
  failZipball: boolean
  close: () => Promise<void>
}

export async function startGitHubMock(opts: { owner: string; repo: string; token: string; branch?: string }): Promise<GitHubMock> {
  const branch = opts.branch ?? 'main'
  const blobs = new Map<string, Buffer>()
  const trees = new Map<string, Map<string, string>>() // tree sha → (path → blob sha)
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>()
  const order: string[] = []
  let head: string | null = null

  const saveTree = (m: Map<string, string>) => {
    const s = sha(JSON.stringify([...m].sort()))
    trees.set(s, m)
    return s
  }
  const commit = (tree: string, parents: string[], message: string) => {
    const s = sha(tree + parents.join() + message + order.length)
    commits.set(s, { tree, parents, message })
    order.push(s)
    return s
  }

  const mock: GitHubMock = {
    port: 0,
    files: () => {
      const out = new Map<string, Buffer>()
      if (!head) return out
      for (const [p, b] of trees.get(commits.get(head)!.tree)!) out.set(p, blobs.get(b)!)
      return out
    },
    commits: () => order.map((s) => ({ message: commits.get(s)!.message })),
    failZipball: false,
    close: () => new Promise((r) => server.close(() => r())),
  }

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
    const send = (status: number, data?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(data === undefined ? '' : JSON.stringify(data))
    }
    if (req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { message: 'Bad credentials' })
    const url = new URL(req.url!, 'http://x')
    const base = `/repos/${opts.owner}/${opts.repo}`
    if (!url.pathname.startsWith(base)) return send(404, { message: 'Not Found' })
    const p = url.pathname.slice(base.length)
    const m = (re: RegExp) => re.exec(p)

    if (p === '' && req.method === 'GET') return send(200, { private: true, permissions: { push: true } })
    if (m(/^\/git\/ref\/heads\/(.+)$/) && req.method === 'GET') {
      if (!head) return send(409, { message: 'Git Repository is empty.' })
      if (decodeURIComponent(m(/^\/git\/ref\/heads\/(.+)$/)![1]) !== branch) return send(404, { message: 'Not Found' })
      return send(200, { object: { sha: head } })
    }
    let r: RegExpExecArray | null
    if ((r = m(/^\/git\/commits\/(\w+)$/)) && req.method === 'GET') {
      const c = commits.get(r[1])
      return c ? send(200, { sha: r[1], tree: { sha: c.tree } }) : send(404, { message: 'Not Found' })
    }
    if ((r = m(/^\/git\/trees\/(\w+)$/)) && req.method === 'GET') {
      const t = trees.get(r[1])
      if (!t) return send(404, { message: 'Not Found' })
      return send(200, {
        truncated: false,
        tree: [...t].map(([path, s]) => ({ path, mode: '100644', type: 'blob', sha: s, size: blobs.get(s)!.length })),
      })
    }
    if (p === '/git/blobs' && req.method === 'POST') {
      const b = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8')
      const s = blobSha(b)
      blobs.set(s, b)
      return send(201, { sha: s })
    }
    if ((r = m(/^\/git\/blobs\/(\w+)$/)) && req.method === 'GET') {
      const b = blobs.get(r[1])
      return b ? send(200, { content: b.toString('base64'), encoding: 'base64' }) : send(404, { message: 'Not Found' })
    }
    if (p === '/git/trees' && req.method === 'POST') {
      const t = new Map(trees.get(body.base_tree) ?? [])
      for (const e of body.tree) {
        if (e.sha === null) {
          if (!t.has(e.path)) return send(422, { message: `path ${e.path} does not exist` })
          t.delete(e.path)
        } else {
          if (!blobs.has(e.sha)) return send(422, { message: 'blob not found' })
          t.set(e.path, e.sha)
        }
      }
      return send(201, { sha: saveTree(t) })
    }
    if (p === '/git/commits' && req.method === 'POST') return send(201, { sha: commit(body.tree, body.parents, body.message) })
    if ((r = m(/^\/git\/refs\/heads\/(.+)$/)) && req.method === 'PATCH') {
      const c = commits.get(body.sha)
      if (!c) return send(422, { message: 'Object does not exist' })
      if (!body.force && head && !c.parents.includes(head)) return send(422, { message: 'Update is not a fast forward' })
      head = body.sha
      return send(200, { object: { sha: head } })
    }
    if ((r = m(/^\/contents\/(.+)$/)) && req.method === 'PUT') {
      const path = r[1].split('/').map(decodeURIComponent).join('/')
      const b = Buffer.from(body.content, 'base64')
      const s = blobSha(b)
      blobs.set(s, b)
      const t = new Map(head ? trees.get(commits.get(head)!.tree)! : [])
      t.set(path, s)
      head = commit(saveTree(t), head ? [head] : [], body.message)
      return send(201, { content: { sha: s } })
    }
    if ((r = m(/^\/zipball\/(\w+)$/)) && req.method === 'GET') {
      if (mock.failZipball) return send(500, { message: 'boom' })
      const c = commits.get(r[1])
      if (!c) return send(404, { message: 'Not Found' })
      const zip = new JSZip()
      for (const [path, s] of trees.get(c.tree)!) zip.file(`${opts.owner}-${opts.repo}-${r[1].slice(0, 7)}/${path}`, blobs.get(s)!)
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      res.writeHead(200, { 'Content-Type': 'application/zip' }).end(buf)
      return
    }
    send(404, { message: `no route ${req.method} ${p}` })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  mock.port = (server.address() as { port: number }).port
  return mock
}

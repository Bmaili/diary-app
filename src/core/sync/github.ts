/**
 * GitHub 私有仓库（规格 6.4）。用 Git Data API：
 * 读分支 ref → 为改动的文件建 blob → 基于当前 tree 建新 tree（删除的文件 sha 为 null）→ 建 commit → 更新 ref。
 * 平时一次同步就是一个 commit；要传的文件很多时（第一次同步、开关加密）每 100 个文件或 20 MB 提交一次，
 * 网络断了也只丢正在传的那一批（2026-10-19 起）。
 */
import { fromBase64, toBase64 } from '../bytes'
import { call, pool, RemoteError, type RemoteFile, type RemoteStore, type Upload } from './remote'

export interface GitHubConfig {
  owner: string
  repo: string
  branch: string
  token: string
  /** 默认 https://api.github.com，可填自建反代 */
  apiBase: string
  /** 仓库内的路径前缀，默认为空（放在仓库根目录） */
  prefix: string
}

interface TreeEntry { path: string; mode: string; type: string; sha: string; size?: number }

/** 分批提交：每批最多这么多文件、这么多字节 */
export const BATCH_FILES = 100
export const BATCH_BYTES = 20 * 1024 * 1024

/** 用完了每小时的请求次数：说清楚几点以后再试（reset 是秒级时间戳） */
function rateLimited(reset?: string): RemoteError {
  const t = Number(reset) * 1000
  const at = Number.isFinite(t) && t > Date.now()
    ? new Date(t).toTimeString().slice(0, 5)
    : ''
  return new RemoteError(
    `GitHub 每小时最多允许 5000 次请求，这次已经用完了。${at ? `${at} 以后` : '过一个小时'}再试，已经下好的不用重下`,
    403, false,
  )
}

export class GitHubStore implements RemoteStore {
  readonly id = 'github' as const
  readonly label = 'GitHub'
  private base: string
  private prefix: string

  constructor(private cfg: GitHubConfig) {
    this.base = (cfg.apiBase || 'https://api.github.com').replace(/\/+$/, '')
    const p = (cfg.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
    this.prefix = p ? p + '/' : ''
  }

  private get repoPath() {
    return `/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`
  }

  private async api<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> {
    const res = await call({
      url: this.base + path,
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok && !okStatuses.includes(res.status)) {
      let msg = ''
      try {
        msg = res.json<{ message?: string }>().message ?? ''
      } catch { /* 非 JSON */ }
      const hint: Record<number, string> = {
        401: 'Token 无效或已过期',
        403: 'Token 没有这个仓库的 Contents 读写权限，或触发了频率限制',
        404: '仓库不存在，或 Token 看不到这个仓库',
      }
      throw new RemoteError(`GitHub 返回 ${res.status}：${hint[res.status] ?? msg}`, res.status, res.status >= 500 || res.status === 429)
    }
    const text = res.text()
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T }
  }

  /** 分支最新的 commit 与 tree；空仓库返回 null */
  private async head(): Promise<{ commit: string; tree: string } | null> {
    const ref = await this.api<{ object: { sha: string } }>('GET', `${this.repoPath}/git/ref/heads/${encodeURIComponent(this.cfg.branch)}`, undefined, [404, 409])
    if (ref.status === 404 || ref.status === 409) {
      // 404 可能是分支不存在，也可能是仓库不存在；后者让它在 list/test 时以明确的错误暴露
      if (ref.status === 404) await this.api('GET', this.repoPath)
      return null
    }
    const commit = await this.api<{ tree: { sha: string } }>('GET', `${this.repoPath}/git/commits/${ref.data.object.sha}`)
    return { commit: ref.data.object.sha, tree: commit.data.tree.sha }
  }

  private async tree(sha: string): Promise<TreeEntry[]> {
    const t = await this.api<{ tree: TreeEntry[]; truncated: boolean }>('GET', `${this.repoPath}/git/trees/${sha}?recursive=1`)
    if (t.data.truncated) throw new RemoteError('仓库文件太多，GitHub 返回的列表被截断', undefined, false)
    return t.data.tree.filter((e) => e.type === 'blob' && e.path.startsWith(this.prefix))
  }

  async list(): Promise<RemoteFile[]> {
    const h = await this.head()
    if (!h) return []
    return (await this.tree(h.tree)).map((e) => ({ path: e.path.slice(this.prefix.length), size: e.size ?? 0, etag: e.sha }))
  }

  /**
   * 下载一个 blob 的原始内容（2026-10-19 起要 raw，不再是 base64 的 JSON，省一半流量和内存）。
   * 自建反代不认 raw 时退回 JSON。用完每小时的请求次数时报清楚几点以后再试。
   */
  private async blob(sha: string): Promise<Uint8Array> {
    const res = await call({
      url: `${this.base}${this.repoPath}/git/blobs/${sha}`,
      headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
      responseType: 'bytes',
      timeoutMs: 120000,
    })
    if (!res.ok) {
      if (res.status === 429 || (res.status === 403 && res.headers['x-ratelimit-remaining'] === '0')) throw rateLimited(res.headers['x-ratelimit-reset'])
      throw new RemoteError(`GitHub 返回 ${res.status}`, res.status, res.status >= 500)
    }
    if ((res.headers['content-type'] ?? '').includes('json')) {
      const j = JSON.parse(new TextDecoder().decode(res.bytes())) as { content?: string; encoding?: string }
      return j.encoding === 'base64' || j.content ? fromBase64((j.content ?? '').replace(/\s/g, '')) : res.bytes()
    }
    return res.bytes()
  }

  /** 空仓库没有任何 commit，Git Data API 用不了；先用 Contents API 写第一个文件建立首个 commit（后面的批次里会再传一次，内容一样） */
  private async bootstrap(first: Upload): Promise<boolean> {
    const body = await first.read()
    if (!body) return false
    await this.api('PUT', `${this.repoPath}/contents/${(this.prefix + first.path).split('/').map(encodeURIComponent).join('/')}`, {
      message: 'sync: 初始化',
      content: toBase64(body),
      branch: this.cfg.branch,
    })
    return true
  }

  async apply(uploads: Upload[], deletes: string[], onDone: (p: string, k: 'upload' | 'delete') => Promise<void>) {
    if (!uploads.length && !deletes.length) return
    let h = await this.head()
    if (!h) {
      if (!uploads.length) return
      // 第一个文件刚好被删了就换下一个
      let ok = false
      for (const u of uploads) if ((ok = await this.bootstrap(u))) break
      if (!ok) return
      h = await this.head()
      if (!h) throw new RemoteError('初始化仓库失败')
    }
    const existing = new Set((await this.tree(h.tree)).map((e) => e.path))
    const gone = deletes.filter((d) => existing.has(this.prefix + d))
    // 分批：每批最多 BATCH_FILES 个文件或 BATCH_BYTES 字节；删除放在第一批
    const batches: Upload[][] = []
    let cur: Upload[] = []
    let bytes = 0
    for (const u of uploads) {
      if (cur.length && (cur.length >= BATCH_FILES || bytes + u.size > BATCH_BYTES)) {
        batches.push(cur)
        cur = []
        bytes = 0
      }
      cur.push(u)
      bytes += u.size
    }
    if (cur.length || !batches.length) batches.push(cur)
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]
      const entries: { path: string; mode: string; type: string; sha: string | null }[] = []
      const sent: string[] = []
      // 一次只读一个文件的内容：建好 blob 就只留下它的 sha
      await pool(batch, 4, async (u) => {
        const body = await u.read()
        if (!body) return
        const b = await this.api<{ sha: string }>('POST', `${this.repoPath}/git/blobs`, { content: toBase64(body), encoding: 'base64' })
        entries.push({ path: this.prefix + u.path, mode: '100644', type: 'blob', sha: b.data.sha })
        sent.push(u.path)
      })
      const del = bi === 0 ? gone : []
      for (const d of del) entries.push({ path: this.prefix + d, mode: '100644', type: 'blob', sha: null })
      if (entries.length) {
        const tree: { data: { sha: string } } = await this.api<{ sha: string }>('POST', `${this.repoPath}/git/trees`, { base_tree: h.tree, tree: entries })
        const n = entries.length
        const day = new Date().toISOString().slice(0, 10)
        const part = batches.length > 1 ? `, ${bi + 1}/${batches.length}` : ''
        const commit: { data: { sha: string } } = await this.api<{ sha: string }>('POST', `${this.repoPath}/git/commits`, {
          message: `sync: ${day} (${n} ${n === 1 ? 'file' : 'files'}${part})`,
          tree: tree.data.sha,
          parents: [h.commit],
        })
        await this.api('PATCH', `${this.repoPath}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, { sha: commit.data.sha, force: false })
        h = { commit: commit.data.sha, tree: tree.data.sha }
      }
      for (const p of sent) await onDone(p, 'upload')
      // 云端本来就没有的，也算删好了
      if (bi === 0) for (const d of deletes) await onDone(d, 'delete')
    }
  }

  async get(path: string): Promise<Uint8Array | null> {
    const h = await this.head()
    if (!h) return null
    const e = (await this.tree(h.tree)).find((x) => x.path === this.prefix + path)
    if (!e) return null
    return this.blob(e.sha)
  }

  /**
   * 恢复：逐个下载 blob（2026-10-19 起）。以前先整包下载 zipball 再在内存里解开，照片多了会内存不足闪退。
   * GitHub 每小时最多 5000 次请求，文件特别多时会中途停下；已经下好的由调用方记着，下次跳过（skip）。
   */
  async downloadAll(
    onFile: (path: string, bytes: Uint8Array, etag?: string) => Promise<void>,
    onProgress?: (d: number, t: number) => void,
    skip?: (path: string, etag?: string) => boolean,
  ) {
    const h = await this.head()
    if (!h) return 0
    const entries = await this.tree(h.tree)
    let done = 0
    const todo = entries.filter((e) => !(skip?.(e.path.slice(this.prefix.length), e.sha) && ++done))
    if (done) onProgress?.(done, entries.length)
    await pool(todo, 4, async (e) => {
      await onFile(e.path.slice(this.prefix.length), await this.blob(e.sha), e.sha)
      onProgress?.(++done, entries.length)
    })
    return entries.length
  }

  async test(): Promise<void> {
    const repo = await this.api<{ permissions?: { push?: boolean }; private?: boolean }>('GET', this.repoPath)
    if (repo.data.permissions && !repo.data.permissions.push) throw new RemoteError('Token 对这个仓库只有读权限，需要 Contents 读写', 403, false)
    await this.head()
  }
}

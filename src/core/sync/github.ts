/**
 * GitHub 私有仓库（规格 6.3）。一次同步 = 一个 commit，用 Git Data API：
 * 读分支 ref → 为改动的文件建 blob → 基于当前 tree 建新 tree（删除的文件 sha 为 null）→ 建 commit → 更新 ref。
 */
import JSZip from 'jszip'
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
    return (await this.tree(h.tree)).map((e) => ({ path: e.path.slice(this.prefix.length), size: e.size ?? 0 }))
  }

  /** 空仓库没有任何 commit，Git Data API 用不了；先用 Contents API 写一个文件建立首个 commit */
  private async bootstrap(first: Upload): Promise<void> {
    await this.api('PUT', `${this.repoPath}/contents/${(this.prefix + first.path).split('/').map(encodeURIComponent).join('/')}`, {
      message: 'sync: 初始化',
      content: toBase64(first.bytes),
      branch: this.cfg.branch,
    })
  }

  async apply(uploads: Upload[], deletes: string[], onDone: (p: string, k: 'upload' | 'delete') => Promise<void>) {
    if (!uploads.length && !deletes.length) return
    let h = await this.head()
    if (!h) {
      if (!uploads.length) return
      await this.bootstrap(uploads[0])
      h = await this.head()
      if (!h) throw new RemoteError('初始化仓库失败')
    }
    const existing = new Set((await this.tree(h.tree)).map((e) => e.path))
    const entries: { path: string; mode: string; type: string; sha: string | null }[] = []
    await pool(uploads, 4, async (u) => {
      const b = await this.api<{ sha: string }>('POST', `${this.repoPath}/git/blobs`, { content: toBase64(u.bytes), encoding: 'base64' })
      entries.push({ path: this.prefix + u.path, mode: '100644', type: 'blob', sha: b.data.sha })
    })
    for (const d of deletes) {
      if (existing.has(this.prefix + d)) entries.push({ path: this.prefix + d, mode: '100644', type: 'blob', sha: null })
    }
    if (entries.length) {
      const tree = await this.api<{ sha: string }>('POST', `${this.repoPath}/git/trees`, { base_tree: h.tree, tree: entries })
      const n = uploads.length + deletes.length
      const day = new Date().toISOString().slice(0, 10)
      const commit = await this.api<{ sha: string }>('POST', `${this.repoPath}/git/commits`, {
        message: `sync: ${day} (${n} ${n === 1 ? 'file' : 'files'})`,
        tree: tree.data.sha,
        parents: [h.commit],
      })
      await this.api('PATCH', `${this.repoPath}/git/refs/heads/${encodeURIComponent(this.cfg.branch)}`, { sha: commit.data.sha, force: false })
    }
    for (const u of uploads) await onDone(u.path, 'upload')
    for (const d of deletes) await onDone(d, 'delete')
  }

  /** 恢复：优先整包下载（一个请求）；失败时逐个下载 blob */
  async downloadAll(onFile: (path: string, bytes: Uint8Array) => Promise<void>, onProgress?: (d: number, t: number) => void) {
    const h = await this.head()
    if (!h) return 0
    const entries = await this.tree(h.tree)
    try {
      const res = await call({
        url: `${this.base}${this.repoPath}/zipball/${h.commit}`,
        headers: { Authorization: `Bearer ${this.cfg.token}`, Accept: 'application/vnd.github+json' },
        responseType: 'bytes',
        timeoutMs: 120000,
      })
      if (!res.ok) throw new Error(String(res.status))
      const zip = await JSZip.loadAsync(res.bytes())
      const want = new Set(entries.map((e) => e.path))
      const files = Object.values(zip.files).filter((f) => !f.dir)
      let done = 0
      for (const f of files) {
        // 压缩包里每个路径都带着 “owner-repo-sha/” 这一层
        const inRepo = f.name.slice(f.name.indexOf('/') + 1)
        if (!want.has(inRepo)) continue
        await onFile(inRepo.slice(this.prefix.length), await f.async('uint8array'))
        onProgress?.(++done, entries.length)
      }
      if (done === entries.length) return done
    } catch { /* 改为逐个下载 */ }
    let done = 0
    await pool(entries, 6, async (e) => {
      const b = await this.api<{ content: string }>('GET', `${this.repoPath}/git/blobs/${e.sha}`)
      await onFile(e.path.slice(this.prefix.length), fromBase64(b.data.content))
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

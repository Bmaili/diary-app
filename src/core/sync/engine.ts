/**
 * 同步引擎（规格 6.1）：本地 diary/ 到云端的单向镜像。
 *
 * - 每个后端一份清单：路径 → 上次成功上传时内容的 sha256，存在 sync/ 下（不在 diary/ 里）。
 * - 待同步 = 本地与清单的差异，随时可从文件算出，app 被杀也不会丢。
 * - 本地文件的哈希按（修改时间, 大小）缓存，避免每次都读全部文件。
 */
import type { FileStore } from '../types'
import { fromBase64, sha256Hex } from '../bytes'
import { ROOT, type DiaryRepo } from '../repo'
import type { RemoteStore, Upload } from './remote'

const SYNC_DIR = 'sync'
const HASH_CACHE = `${SYNC_DIR}/local-hashes.json`
const manifestPath = (id: string) => `${SYNC_DIR}/manifest-${id}.json`

export type Manifest = Record<string, string>

interface LocalFile { path: string; hash: string }

export interface Plan {
  uploads: string[]
  deletes: string[]
}

export class SyncEngine {
  private hashCache: Record<string, { mtime: number; size: number; hash: string }> | null = null
  private busy = new Map<string, Promise<unknown>>()

  constructor(private repo: DiaryRepo, private store: FileStore) {}

  async readManifest(id: string): Promise<Manifest> {
    const t = await this.store.readText(manifestPath(id))
    if (!t) return {}
    try {
      return JSON.parse(t) as Manifest
    } catch {
      return {}
    }
  }

  async writeManifest(id: string, m: Manifest): Promise<void> {
    await this.store.mkdirp(SYNC_DIR)
    await this.store.writeText(manifestPath(id), JSON.stringify(m))
  }

  async clearManifest(id: string): Promise<void> {
    await this.store.remove(manifestPath(id)).catch(() => {})
  }

  /** diary/ 下全部文件及其内容哈希。路径相对于 diary/。 */
  async localFiles(): Promise<LocalFile[]> {
    if (!this.hashCache) {
      try {
        this.hashCache = JSON.parse((await this.store.readText(HASH_CACHE)) ?? '{}')
      } catch {
        this.hashCache = {}
      }
    }
    const cache = this.hashCache!
    const out: LocalFile[] = []
    let changed = false
    const walk = async (dir: string) => {
      for (const f of await this.store.list(dir)) {
        const full = `${dir}/${f.name}`
        if (f.type === 'directory') {
          await walk(full)
          continue
        }
        const rel = full.slice(ROOT.length + 1)
        const c = cache[rel]
        let hash: string
        if (c && c.mtime === f.mtime && c.size === f.size) hash = c.hash
        else {
          const b64 = await this.store.readBase64(full)
          if (b64 == null) continue
          hash = await sha256Hex(fromBase64(b64))
          cache[rel] = { mtime: f.mtime, size: f.size, hash }
          changed = true
        }
        out.push({ path: rel, hash })
      }
    }
    await walk(ROOT)
    const live = new Set(out.map((f) => f.path))
    for (const k of Object.keys(cache)) {
      if (!live.has(k)) {
        delete cache[k]
        changed = true
      }
    }
    if (changed) {
      await this.store.mkdirp(SYNC_DIR)
      await this.store.writeText(HASH_CACHE, JSON.stringify(cache))
    }
    return out
  }

  async plan(id: string): Promise<Plan> {
    const [local, manifest] = await Promise.all([this.localFiles(), this.readManifest(id)])
    const uploads = local.filter((f) => manifest[f.path] !== f.hash).map((f) => f.path)
    const live = new Set(local.map((f) => f.path))
    const deletes = Object.keys(manifest).filter((p) => !live.has(p))
    return { uploads, deletes }
  }

  async pending(id: string): Promise<number> {
    const p = await this.plan(id)
    return p.uploads.length + p.deletes.length
  }

  /**
   * 同步到一个后端。同一后端同时只跑一个任务（规格 6.1 第 4 条）；
   * 上传前再读一次文件，用实际上传的内容计算哈希，防止上传过程中文件被改。
   */
  sync(remote: RemoteStore, onProgress?: (done: number, total: number) => void): Promise<{ uploaded: number; deleted: number }> {
    const running = this.busy.get(remote.id)
    if (running) return running as Promise<{ uploaded: number; deleted: number }>
    const job = (async () => {
      const { uploads, deletes } = await this.plan(remote.id)
      const total = uploads.length + deletes.length
      if (!total) return { uploaded: 0, deleted: 0 }
      const manifest = await this.readManifest(remote.id)
      const items: Upload[] = []
      for (const path of uploads) {
        const b64 = await this.store.readBase64(`${ROOT}/${path}`)
        if (b64 == null) continue
        const bytes = fromBase64(b64)
        items.push({ path, bytes, hash: await sha256Hex(bytes) })
      }
      const hashOf = new Map(items.map((u) => [u.path, u.hash]))
      let done = 0
      let dirty = 0
      const persist = async (force = false) => {
        if (force || ++dirty >= 20) {
          dirty = 0
          await this.writeManifest(remote.id, manifest)
        }
      }
      try {
        await remote.apply(items, deletes, async (path, kind) => {
          if (kind === 'upload') manifest[path] = hashOf.get(path)!
          else delete manifest[path]
          onProgress?.(++done, total)
          await persist()
        })
      } finally {
        await persist(true)
      }
      return { uploaded: items.length, deleted: deletes.length }
    })()
    this.busy.set(remote.id, job)
    return job.finally(() => this.busy.delete(remote.id))
  }

  /** 各后端互不影响地同步：一个失败不影响另一个（规格第 6 节） */
  async syncAll(remotes: RemoteStore[]): Promise<Record<string, { ok: boolean; uploaded?: number; deleted?: number; error?: string }>> {
    const results = await Promise.allSettled(remotes.map((r) => this.sync(r)))
    const out: Record<string, { ok: boolean; uploaded?: number; deleted?: number; error?: string }> = {}
    results.forEach((r, i) => {
      out[remotes[i].id] = r.status === 'fulfilled' ? { ok: true, ...r.value } : { ok: false, error: (r.reason as Error).message }
    })
    return out
  }

  isBusy(id: string): boolean {
    return this.busy.has(id)
  }

  get repoRef() {
    return this.repo
  }
}

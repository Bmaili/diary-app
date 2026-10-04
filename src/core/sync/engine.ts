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
import { isMeta, remotePathOf, type SyncCrypto } from './crypto'

const SYNC_DIR = 'sync'
const HASH_CACHE = `${SYNC_DIR}/local-hashes.json`
const manifestPath = (id: string) => `${SYNC_DIR}/manifest-${id}.json`
const statePath = (id: string) => `${SYNC_DIR}/state-${id}.json`

/** 清单：本地路径（相对 diary/，加密时也不带 .age）→ 上次上传时明文内容的 sha256 */
export type Manifest = Record<string, string>

interface LocalFile { path: string; hash: string; bytes?: number }

export interface Plan {
  uploads: string[]
  deletes: string[]
}

export interface SyncOpts {
  /** 不为空表示这个后端开了加密 */
  crypto?: SyncCrypto | null
}

export interface BackendSyncState {
  /** 'plain' 或 'age:<公钥>'。和当前设置不一致时，下次同步会按新形态全部重传并清理旧文件 */
  mode: string
  /** 换了形态后，旧形态的云端文件还没清理 */
  cleanup?: boolean
  /** 上次核对云端的时间 */
  lastCheck?: number
  lastCheckResult?: CheckResult
}

export interface CheckResult {
  remoteFiles: number
  /** 云端缺失、下次同步会补传的文件 */
  missing: string[]
  /** 云端大小和本地不一致（被改过或损坏），下次同步会覆盖 */
  changed: string[]
  /** 删掉的旧形态文件（开关加密后留下的） */
  removed: string[]
}

export const modeOf = (opts: SyncOpts = {}) => (opts.crypto ? `age:${opts.crypto.keys.recipient}` : 'plain')

export class SyncEngine {
  private hashCache: Record<string, { mtime: number; size: number; hash: string; bytes?: number }> | null = null
  private busy = new Map<string, Promise<unknown>>()
  private checks = new Map<string, Promise<unknown>>()

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

  /** 没有状态文件（升级前的数据）视为明文 */
  async readState(id: string): Promise<BackendSyncState> {
    try {
      const t = await this.store.readText(statePath(id))
      if (t) return { mode: 'plain', ...JSON.parse(t) }
    } catch { /* 当作默认 */ }
    return { mode: 'plain' }
  }

  async writeState(id: string, st: BackendSyncState): Promise<void> {
    await this.store.mkdirp(SYNC_DIR)
    await this.store.writeText(statePath(id), JSON.stringify(st))
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
        let bytes: number | undefined
        if (c && c.mtime === f.mtime && c.size === f.size) {
          hash = c.hash
          bytes = c.bytes
        } else {
          const b64 = await this.store.readBase64(full)
          if (b64 == null) continue
          const data = fromBase64(b64)
          hash = await sha256Hex(data)
          bytes = data.length
          cache[rel] = { mtime: f.mtime, size: f.size, hash, bytes }
          changed = true
        }
        out.push({ path: rel, hash, bytes })
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

  /** 本地文件加上（加密时）云端说明文件 */
  private async wanted(opts: SyncOpts): Promise<{ files: LocalFile[]; meta: Map<string, Uint8Array> }> {
    const files = await this.localFiles()
    const meta = new Map<string, Uint8Array>()
    if (opts.crypto) {
      for (const m of await opts.crypto.metaFiles()) {
        meta.set(m.path, m.bytes)
        files.push({ path: m.path, hash: m.hash, bytes: m.bytes.length })
      }
    }
    return { files, meta }
  }

  async plan(id: string, opts: SyncOpts = {}): Promise<Plan> {
    const [{ files }, manifest, st] = await Promise.all([this.wanted(opts), this.readManifest(id), this.readState(id)])
    // 形态变了：清单作废，全部重传
    const m = st.mode === modeOf(opts) ? manifest : {}
    const uploads = files.filter((f) => m[f.path] !== f.hash).map((f) => f.path)
    const live = new Set(files.map((f) => f.path))
    const deletes = Object.keys(m).filter((p) => !live.has(p))
    return { uploads, deletes }
  }

  async pending(id: string, opts: SyncOpts = {}): Promise<number> {
    const p = await this.plan(id, opts)
    return p.uploads.length + p.deletes.length
  }

  /**
   * 同步到一个后端。同一后端同时只跑一个任务（规格 6.1 第 4 条）；
   * 上传前再读一次文件，用实际上传的内容计算哈希，防止上传过程中文件被改。
   * 开了加密时上传 xxx.age，清单仍按本地路径和明文哈希记录。
   */
  sync(remote: RemoteStore, onProgress?: (done: number, total: number) => void, opts: SyncOpts = {}): Promise<{ uploaded: number; deleted: number }> {
    const running = this.busy.get(remote.id)
    if (running) return running as Promise<{ uploaded: number; deleted: number }>
    const job = (async () => {
      await this.checks.get(remote.id)?.catch(() => {})
      const mode = modeOf(opts)
      let st = await this.readState(remote.id)
      if (st.mode !== mode) {
        // 先按新形态全部上传，成功后再删旧形态的文件，避免中途失败时云端什么都没有
        await this.clearManifest(remote.id)
        st = { ...st, mode, cleanup: true }
        await this.writeState(remote.id, st)
      }
      const { uploads, deletes } = await this.plan(remote.id, opts)
      const total = uploads.length + deletes.length
      let result = { uploaded: 0, deleted: 0 }
      if (total) result = await this.push(remote, uploads, deletes, opts, onProgress)
      if (st.cleanup) {
        await this.removeOtherForm(remote, opts)
        await this.writeState(remote.id, { ...(await this.readState(remote.id)), cleanup: false })
      }
      return result
    })()
    this.busy.set(remote.id, job)
    return job.finally(() => this.busy.delete(remote.id))
  }

  private async push(
    remote: RemoteStore, uploads: string[], deletes: string[], opts: SyncOpts,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ uploaded: number; deleted: number }> {
    const enc = !!opts.crypto
    const total = uploads.length + deletes.length
    const manifest = await this.readManifest(remote.id)
    const { meta } = enc ? await this.wanted(opts) : { meta: new Map<string, Uint8Array>() }
    const items: Upload[] = []
    const localOf = new Map<string, string>()
    for (const path of uploads) {
      let bytes = meta.get(path)
      if (!bytes) {
        const b64 = await this.store.readBase64(`${ROOT}/${path}`)
        if (b64 == null) continue
        bytes = fromBase64(b64)
      }
      const hash = await sha256Hex(bytes)
      const body = enc && !isMeta(path) ? await opts.crypto!.encrypt(bytes) : bytes
      const rp = remotePathOf(path, enc)
      localOf.set(rp, path)
      items.push({ path: rp, bytes: body, hash })
    }
    const remoteDeletes = deletes.map((p) => {
      const rp = remotePathOf(p, enc)
      localOf.set(rp, p)
      return rp
    })
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
      await remote.apply(items, remoteDeletes, async (rp, kind) => {
        const p = localOf.get(rp) ?? rp
        if (kind === 'upload') manifest[p] = hashOf.get(rp)!
        else delete manifest[p]
        onProgress?.(++done, total)
        await persist()
      })
    } finally {
      await persist(true)
    }
    return { uploaded: items.length, deleted: deletes.length }
  }

  /** 删掉另一种形态的云端文件：加密时删明文副本，明文时删 .age 副本和 _encryption/ */
  private async removeOtherForm(remote: RemoteStore, opts: SyncOpts, listing?: { path: string }[]): Promise<string[]> {
    const enc = !!opts.crypto
    const raw = new Set((listing ?? (await remote.list())).map((f) => f.path))
    const stale: string[] = []
    for (const f of await this.localFiles()) {
      const other = remotePathOf(f.path, !enc)
      if (other !== remotePathOf(f.path, enc) && raw.has(other)) stale.push(other)
    }
    if (!enc) for (const p of raw) if (isMeta(p)) stale.push(p)
    if (stale.length) await remote.apply([], stale, async () => {})
    return stale
  }

  /**
   * 核对云端：列出云端实际有的文件，和清单对比。
   * - 云端缺了的（被删、被清空）从清单里去掉，下次同步补传；
   * - 明文上传的文件，云端大小和本地不一致的，同样重新上传（云端是副本，以手机为准）；
   * - 清理开关加密后残留的另一种形态的文件。
   * 只发列表请求（OSS 每 1000 个文件一次，GitHub 一次），不下载内容。
   */
  async reconcile(remote: RemoteStore, opts: SyncOpts = {}): Promise<CheckResult> {
    const run = async (): Promise<CheckResult> => {
      const listing = await remote.list()
      const size = new Map(listing.map((f) => [f.path, f.size]))
      const st = await this.readState(remote.id)
      const enc = !!opts.crypto
      const result: CheckResult = { remoteFiles: listing.length, missing: [], changed: [], removed: [] }
      if (st.mode === modeOf(opts)) {
        const manifest = await this.readManifest(remote.id)
        const { files } = await this.wanted(opts)
        const local = new Map(files.map((f) => [f.path, f]))
        for (const p of Object.keys(manifest)) {
          const rp = remotePathOf(p, enc)
          if (!size.has(rp)) {
            delete manifest[p]
            result.missing.push(p)
            continue
          }
          const lf = local.get(p)
          const plainUpload = !enc || isMeta(p)
          if (plainUpload && lf && lf.hash === manifest[p] && lf.bytes != null && size.get(rp) !== lf.bytes) {
            delete manifest[p]
            result.changed.push(p)
          }
        }
        if (result.missing.length || result.changed.length) await this.writeManifest(remote.id, manifest)
        result.removed = await this.removeOtherForm(remote, opts, listing)
      }
      await this.writeState(remote.id, { ...(await this.readState(remote.id)), lastCheck: Date.now(), lastCheckResult: result })
      return result
    }
    // 和同步互斥，避免同时改清单
    const running = this.checks.get(remote.id)
    if (running) return running as Promise<CheckResult>
    const job = (this.busy.get(remote.id) ?? Promise.resolve()).catch(() => {}).then(run)
    this.checks.set(remote.id, job)
    return job.finally(() => this.checks.delete(remote.id))
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
    return this.busy.has(id) || this.checks.has(id)
  }

  get repoRef() {
    return this.repo
  }
}

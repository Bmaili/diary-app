/**
 * 从云端恢复（规格 6.6）。
 * 先全部下载到临时目录并校验，再搬进 diary/：本地没有日记时整体替换；
 * 本地已有日记时只补入本地没有的文件，同名而内容不同的保留本地版本并列出。
 * 最后用下载内容的哈希初始化该后端的清单，恢复后不会全量重新上传。
 */
import type { FileStore } from '../types'
import { fromBase64, sha256Hex, toBase64 } from '../bytes'
import { ENTRIES, ROOT } from '../repo'
import { modeOf, type SyncEngine } from './engine'
import type { RemoteStore } from './remote'
import { META_IDENTITY, META_INFO, isMeta, localPathOf, unwrapIdentity, type KeyBundle, type SyncCrypto } from './crypto'

const TMP = 'restore-tmp'
/** 恢复进度：哪些云端文件已经下进临时目录（云端路径 → 指纹、本地路径、明文哈希、是不是加密的） */
const PROGRESS = `${TMP}/.progress.json`

interface Progress {
  remote: string
  mode: string
  files: Record<string, { etag: string; path: string; hash: string; enc: boolean }>
}

async function readProgress(store: FileStore): Promise<Progress | null> {
  try {
    const p = JSON.parse((await store.readText(PROGRESS)) ?? 'null') as Progress | null
    return p && typeof p.files === 'object' ? p : null
  } catch {
    return null
  }
}

export interface RestorePreview {
  files: number
  entries: number
  latest: string | null
  hasFormat: boolean
  /** 云端是加密的，恢复前需要输密码 */
  encrypted: boolean
  /** 云端加密用的公钥（来自 _encryption/info.json 不可得时为空） */
  recipient?: string
}

export async function previewRemote(remote: RemoteStore): Promise<RestorePreview> {
  const files = await remote.list()
  const dates = [...new Set(files
    .map((f) => /^entries\/\d{4}\/(\d{4}-\d{2}-\d{2})\.md(?:\.age)?$/.exec(f.path)?.[1])
    .filter((d): d is string => !!d))]
    .sort()
  const encrypted = files.some((f) => f.path === META_INFO)
  let recipient: string | undefined
  if (encrypted) {
    try {
      recipient = JSON.parse(new TextDecoder().decode((await remote.get(META_INFO)) ?? new Uint8Array())).recipient
    } catch { /* 说明文件坏了也不影响恢复 */ }
  }
  return {
    files: files.filter((f) => !isMeta(f.path)).length,
    entries: dates.length,
    latest: dates[dates.length - 1] ?? null,
    hasFormat: files.some((f) => f.path === 'format.json' || f.path === 'format.json.age'),
    encrypted,
    recipient,
  }
}

/** 用密码解开云端的身份密钥 */
export async function unlockRemote(remote: RemoteStore, passphrase: string): Promise<KeyBundle> {
  const wrapped = await remote.get(META_IDENTITY)
  if (!wrapped) throw new Error('云端缺少 _encryption/identity.age，无法解密')
  return unwrapIdentity(wrapped, passphrase)
}

export interface RestoreResult {
  restored: string[]
  skipped: string[]
  identical: number
  replacedAll: boolean
}

async function localHasEntries(store: FileStore): Promise<boolean> {
  for (const y of await store.list(ENTRIES)) {
    if (y.type === 'directory' && (await store.list(`${ENTRIES}/${y.name}`)).some((f) => f.name.endsWith('.md'))) return true
  }
  return false
}

export async function restoreFrom(
  remote: RemoteStore,
  store: FileStore,
  engine: SyncEngine,
  onProgress?: (done: number, total: number) => void,
  crypto: SyncCrypto | null = null,
): Promise<RestoreResult> {
  const downloaded = new Map<string, string>() // 本地路径 → 明文 sha256
  const fromEncrypted = new Set<string>()
  // 接着上次没做完的恢复（2026-10-19 起）：同一个后端、同一种形态，指纹没变的文件不用重下
  const mode = modeOf({ crypto })
  let prog = await readProgress(store)
  if (!prog || prog.remote !== remote.id || prog.mode !== mode) {
    await store.rmdir(TMP)
    prog = { remote: remote.id, mode, files: {} }
  }
  const p = prog
  for (const f of Object.values(p.files)) if (f.enc) fromEncrypted.add(f.path)
  /** 这次云端实际有的文件、这次新下的文件 */
  const seen = new Set<string>()
  const fresh = new Set<string>()
  await store.mkdirp(TMP)
  let unsaved = 0
  const saveProgress = async (force = false) => {
    if (!force && ++unsaved < 20) return
    unsaved = 0
    await store.writeText(PROGRESS, JSON.stringify(p))
  }
  try {
    await remote.downloadAll(async (raw, bytes, etag) => {
      if (raw.includes('..')) return
      const lp = localPathOf(raw)
      if (!lp) return
      // 同一篇既有明文又有加密副本（切换加密中途）：以加密的为准
      if (!lp.encrypted && fromEncrypted.has(lp.path)) return
      if (lp.encrypted) {
        if (!crypto) throw new Error('云端的日记是加密的，需要先输入同步加密密码')
        bytes = await crypto.decrypt(bytes)
        fromEncrypted.add(lp.path)
      }
      await store.writeBase64(`${TMP}/${lp.path}`, toBase64(bytes))
      const hash = await sha256Hex(bytes)
      downloaded.set(lp.path, hash)
      fresh.add(raw)
      if (etag) {
        p.files[raw] = { etag, path: lp.path, hash, enc: lp.encrypted }
        await saveProgress()
      }
    }, onProgress, (raw, etag) => {
      seen.add(raw)
      return !!etag && p.files[raw]?.etag === etag
    })
  } finally {
    // 中途失败（断网、GitHub 限流）：记下已经下好的，下次接着下
    await saveProgress(true).catch(() => {})
  }
  // 上次已经下好、这次跳过的；云端已经没有了的不算
  for (const [raw, f] of Object.entries(p.files)) {
    if (!seen.has(raw) || fresh.has(raw)) continue
    if (!f.enc && fromEncrypted.has(f.path)) continue
    downloaded.set(f.path, f.hash)
  }
  if (!downloaded.has('format.json')) {
    await store.rmdir(TMP)
    throw new Error('云端没有 format.json，看起来不是这个 app 的日记文件夹，已取消恢复')
  }

  const replacedAll = !(await localHasEntries(store))
  const result: RestoreResult = { restored: [], skipped: [], identical: 0, replacedAll }
  // 本地清单若是另一种形态（明文 / 另一把密钥）留下的，作废重来
  const sameMode = (await engine.readState(remote.id)).mode === mode
  const manifest = sameMode ? await engine.readManifest(remote.id) : {}
  for (const [path, hash] of downloaded) {
    const target = `${ROOT}/${path}`
    const existing = await store.readBase64(target)
    const existingHash = existing == null ? null : await sha256Hex(fromBase64(existing))
    if (existingHash === hash) {
      result.identical++
      manifest[path] = hash
      continue
    }
    if (existing != null && !replacedAll && (path.startsWith('entries/') || path.startsWith('letters/'))) {
      // 同名不同内容：保留本地版本，清单不记录，下次同步会用本地版本覆盖云端
      result.skipped.push(path)
      continue
    }
    await store.mkdirp(target.slice(0, target.lastIndexOf('/')))
    if (existing != null) await store.remove(target).catch(() => {})
    await store.rename(`${TMP}/${path}`, target)
    manifest[path] = hash
    if (path.startsWith('entries/') || path.startsWith('attachments/') || path.startsWith('summaries/') || path.startsWith('letters/') || path.startsWith('annotations/')) result.restored.push(path)
  }
  if (crypto) {
    // 恢复用的就是云端的密钥文件，说明文件视为已同步
    for (const m of await crypto.metaFiles()) manifest[m.path] = m.hash
  }
  await engine.writeManifest(remote.id, manifest)
  await engine.writeState(remote.id, { ...(await engine.readState(remote.id)), mode, cleanup: true })
  await store.rmdir(TMP)
  return result
}

/**
 * 从云端恢复（规格 6.5）。
 * 先全部下载到临时目录并校验，再搬进 diary/：本地没有日记时整体替换；
 * 本地已有日记时只补入本地没有的文件，同名而内容不同的保留本地版本并列出。
 * 最后用下载内容的哈希初始化该后端的清单，恢复后不会全量重新上传。
 */
import type { FileStore } from '../types'
import { fromBase64, sha256Hex, toBase64 } from '../bytes'
import { ENTRIES, ROOT } from '../repo'
import type { SyncEngine } from './engine'
import type { RemoteStore } from './remote'

const TMP = 'restore-tmp'

export interface RestorePreview {
  files: number
  entries: number
  latest: string | null
  hasFormat: boolean
}

export async function previewRemote(remote: RemoteStore): Promise<RestorePreview> {
  const files = await remote.list()
  const dates = files
    .map((f) => /^entries\/\d{4}\/(\d{4}-\d{2}-\d{2})\.md$/.exec(f.path)?.[1])
    .filter((d): d is string => !!d)
    .sort()
  return {
    files: files.length,
    entries: dates.length,
    latest: dates[dates.length - 1] ?? null,
    hasFormat: files.some((f) => f.path === 'format.json'),
  }
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
): Promise<RestoreResult> {
  await store.rmdir(TMP)
  const downloaded = new Map<string, string>() // 路径 → sha256
  await remote.downloadAll(async (path, bytes) => {
    if (path.includes('..')) return
    await store.writeBase64(`${TMP}/${path}`, toBase64(bytes))
    downloaded.set(path, await sha256Hex(bytes))
  }, onProgress)
  if (!downloaded.has('format.json')) {
    await store.rmdir(TMP)
    throw new Error('云端没有 format.json，看起来不是这个 app 的日记文件夹，已取消恢复')
  }

  const replacedAll = !(await localHasEntries(store))
  const result: RestoreResult = { restored: [], skipped: [], identical: 0, replacedAll }
  const manifest = await engine.readManifest(remote.id)
  for (const [path, hash] of downloaded) {
    const target = `${ROOT}/${path}`
    const existing = await store.readBase64(target)
    const existingHash = existing == null ? null : await sha256Hex(fromBase64(existing))
    if (existingHash === hash) {
      result.identical++
      manifest[path] = hash
      continue
    }
    if (existing != null && !replacedAll && path.startsWith('entries/')) {
      // 同名不同内容：保留本地版本，清单不记录，下次同步会用本地版本覆盖云端
      result.skipped.push(path)
      continue
    }
    await store.mkdirp(target.slice(0, target.lastIndexOf('/')))
    if (existing != null) await store.remove(target).catch(() => {})
    await store.rename(`${TMP}/${path}`, target)
    manifest[path] = hash
    if (path.startsWith('entries/') || path.startsWith('attachments/') || path.startsWith('summaries/')) result.restored.push(path)
  }
  await engine.writeManifest(remote.id, manifest)
  await store.rmdir(TMP)
  return result
}

/**
 * diary/ 文件夹的读写（规格 4.1、4.4）。这是唯一的数据源；索引与缓存都放在 diary/ 之外。
 */
import type { FileStore } from './types'
import { hasContent, parseEntry, serializeEntry, type EntryDoc } from './entryFile'
import { isoLocal, isValidYmd } from './time'
import { README_MD } from './readme'

export const ROOT = 'diary'
export const ENTRIES = `${ROOT}/entries`
export const TMP = 'tmp'
export const FORMAT_JSON = `{"format_version": 1}\n`

export function entryPath(date: string): string {
  return `${ENTRIES}/${date.slice(0, 4)}/${date}.md`
}

export function dateFromPath(path: string): string | null {
  const m = /(\d{4}-\d{2}-\d{2})\.md$/.exec(path)
  return m && isValidYmd(m[1]) ? m[1] : null
}

export interface EntryFile {
  path: string
  date: string
  mtime: number
  size: number
}

export class DiaryRepo {
  constructor(readonly store: FileStore) {}

  /** 首次启动建目录与自描述文件，并恢复上次中断的原子写入。 */
  async init(): Promise<void> {
    await this.store.mkdirp(ENTRIES)
    await this.store.mkdirp(TMP)
    if ((await this.store.stat(`${ROOT}/format.json`)) == null) {
      await this.writeAtomic(`${ROOT}/format.json`, FORMAT_JSON)
    }
    const readme = await this.store.readText(`${ROOT}/README.md`)
    if (readme !== README_MD) await this.writeAtomic(`${ROOT}/README.md`, README_MD)
    await this.recoverTmp()
  }

  /**
   * 原子写入（规格 4.4 第 3 条）：先写临时文件，再重命名到目标位置。
   * 某些平台的重命名不允许覆盖已有文件，此时先删除目标再重命名；
   * 若恰好在这两步之间被杀掉，下次启动时 recoverTmp 会用完整的临时文件补回。
   */
  async writeAtomic(path: string, text: string): Promise<void> {
    const tmp = `${TMP}/${path.replace(/\//g, '__')}.tmp`
    await this.store.writeText(tmp, text)
    const dir = path.slice(0, path.lastIndexOf('/'))
    await this.store.mkdirp(dir)
    try {
      await this.store.rename(tmp, path)
    } catch {
      await this.store.remove(path).catch(() => {})
      await this.store.rename(tmp, path)
    }
  }

  private async recoverTmp(): Promise<void> {
    for (const f of await this.store.list(TMP)) {
      if (f.type !== 'file' || !f.name.endsWith('.tmp')) continue
      const tmp = `${TMP}/${f.name}`
      const target = f.name.slice(0, -4).replace(/__/g, '/')
      if (!target.startsWith(`${ROOT}/`)) {
        await this.store.remove(tmp)
        continue
      }
      if ((await this.store.stat(target)) == null) {
        // 目标在“删除后、重命名前”丢失：临时文件是完整的新版本
        await this.store.mkdirp(target.slice(0, target.lastIndexOf('/')))
        await this.store.rename(tmp, target)
      } else {
        // 目标完好，临时文件可能只写了一半，丢弃
        await this.store.remove(tmp)
      }
    }
  }

  async readEntryRaw(date: string): Promise<string | null> {
    return this.store.readText(entryPath(date))
  }

  async readEntry(date: string): Promise<EntryDoc | null> {
    const raw = await this.readEntryRaw(date)
    if (raw == null) return null
    return parseEntry(raw, date)
  }

  /**
   * 保存一篇日记。正文为空时不写文件（规格 4.4 第 8 条），返回 false；
   * 删除已有文件需要调用方确认后显式调用 deleteEntry。
   */
  async saveEntry(doc: EntryDoc, now = new Date(), opts: { touchUpdated?: boolean } = {}): Promise<boolean> {
    if (!hasContent(doc.body)) return false
    const stamp = isoLocal(now)
    doc.meta.created ??= stamp
    // AI 写回、词表合并不算“你改了日记”，不更新 updated（否则会被判定为抽取后又改过）
    if (opts.touchUpdated !== false || !doc.meta.updated) doc.meta.updated = stamp
    await this.writeAtomic(entryPath(doc.meta.date), serializeEntry(doc))
    return true
  }

  async deleteEntry(date: string): Promise<void> {
    await this.store.remove(entryPath(date)).catch(() => {})
  }

  async listEntryFiles(): Promise<EntryFile[]> {
    const out: EntryFile[] = []
    for (const y of await this.store.list(ENTRIES)) {
      if (y.type !== 'directory' || !/^\d{4}$/.test(y.name)) continue
      for (const f of await this.store.list(`${ENTRIES}/${y.name}`)) {
        if (f.type !== 'file') continue
        const path = `${ENTRIES}/${y.name}/${f.name}`
        const date = dateFromPath(path)
        if (!date) continue
        out.push({ path, date, mtime: f.mtime, size: f.size })
      }
    }
    return out
  }

  /** diary/ 下全部文件（相对 diary/ 的路径），用于导出。 */
  async listAllFiles(dir = ROOT): Promise<string[]> {
    const out: string[] = []
    for (const f of await this.store.list(dir)) {
      const p = `${dir}/${f.name}`
      if (f.type === 'directory') out.push(...(await this.listAllFiles(p)))
      else out.push(p)
    }
    return out
  }
}

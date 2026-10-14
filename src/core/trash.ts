/**
 * 最近删除（2026-10-04 加入）。删除日记时不直接删文件，而是把它和这天插的图片移到 trash/。
 *
 * - trash/ 在 diary/ 之外：不进索引、不同步、不导出。所以云端副本照常会在下次同步时删除，
 *   本机这份是后悔药，保留 30 天后自动清掉。
 * - 一次删除是 trash/<日期>_<时间戳>/ 一个文件夹，里面按 diary/ 下的相对路径存放，外加 info.json。
 * - 图片只带走文件名以这一天开头（编辑页插图时的命名）、且没有被其他日记引用的。
 * - 这天的朱批（annotations/）一起带走（2026-10-13 起）。
 * - 没被用到的图片（2026-10-14 起，见 orphans.ts）也移到这里：kind 为 images；恢复时把图接回那天日记的末尾。
 */
import type { FileStore } from './types'
import { ROOT, entryPath, type DiaryRepo } from './repo'
import { parseEntry, plainText, type EntryDoc } from './entryFile'
import { imageDay, mdFor, namesIn, type ImageRef } from './orphans'
import { annotationPath, annotationRel } from './annotation'

export const TRASH = 'trash'
export const KEEP_DAYS = 30

export interface TrashItem {
  id: string
  date: string
  /** 毫秒时间戳 */
  deletedAt: number
  /** 相对 diary/ 的路径 */
  files: string[]
  preview: string
  mood?: number
  /** 删的是一封信（2026-10-13 加入）或几张没用到的图片（2026-10-14 加入）；没有这个字段的是日记 */
  kind?: 'letter' | 'images'
  /** kind 为 images：编辑时去掉的（edit），还是在设置里清理出来的（cleanup） */
  source?: 'edit' | 'cleanup'
  /** kind 为 images：每张图原来在正文里的写法（带说明），恢复时原样接回 */
  refs?: Record<string, string>
  /** 信的编号（kind 为 letter 时） */
  letterId?: string
}

const DAY = 86400000

/** 这一天插的、没有被其他日记引用的图片（相对 diary/ 的路径） */
export async function ownImages(repo: DiaryRepo, date: string): Promise<string[]> {
  const dir = `attachments/${date.slice(0, 4)}`
  const names = (await repo.store.list(`${ROOT}/${dir}`))
    .filter((f) => f.type === 'file' && f.name.startsWith(`${date}_`))
    .map((f) => f.name)
  if (!names.length) return []
  const usedElsewhere = new Set<string>()
  for (const f of await repo.listEntryFiles()) {
    if (f.date === date) continue
    const raw = await repo.store.readText(f.path)
    if (!raw) continue
    for (const n of names) if (raw.includes(n)) usedElsewhere.add(n)
  }
  return names.filter((n) => !usedElsewhere.has(n)).map((n) => `${dir}/${n}`)
}

async function move(store: FileStore, from: string, to: string): Promise<boolean> {
  if (!(await store.stat(from))) return false
  await store.mkdirp(to.slice(0, to.lastIndexOf('/')))
  await store.rename(from, to)
  return true
}

/** 把一篇日记移到最近删除。返回 null 表示这一天本来就没有日记。 */
export async function trashEntry(repo: DiaryRepo, date: string, now = new Date()): Promise<TrashItem | null> {
  const store = repo.store
  const raw = await repo.readEntryRaw(date)
  if (raw == null) return null
  let preview = ''
  let mood: number | undefined
  try {
    const doc = parseEntry(raw, date)
    preview = plainText(doc.body).replace(/\s+/g, ' ').slice(0, 80)
    mood = doc.meta.mood
  } catch {
    preview = raw.slice(0, 80)
  }
  const entryRel = entryPath(date).slice(ROOT.length + 1)
  const item: TrashItem = {
    id: `${date}_${now.getTime()}`,
    date,
    deletedAt: now.getTime(),
    files: [entryRel, ...(await ownImages(repo, date)), ...((await store.stat(annotationPath(date))) ? [annotationRel(date)] : [])],
    preview,
    ...(mood != null ? { mood } : {}),
  }
  const dir = `${TRASH}/${item.id}`
  await store.mkdirp(dir)
  await store.writeText(`${dir}/info.json`, JSON.stringify(item))
  // 先移日记本身：就算中途被杀，日记也已经在回收站里，最多是几张图片还留在原处
  for (const rel of item.files) await move(store, `${ROOT}/${rel}`, `${dir}/${rel}`)
  return item
}

/** 把一封信移到最近删除（拆过的信，或者撤回的信）。date 记写信的日期 */
export async function trashLetter(store: FileStore, letterId: string, preview: string, now = new Date(), images: string[] = []): Promise<TrashItem | null> {
  const rel = `letters/${letterId}.md`
  if (!(await store.stat(`${ROOT}/${rel}`))) return null
  const item: TrashItem = {
    id: `letter_${letterId}_${now.getTime()}`,
    date: letterId.slice(0, 10),
    deletedAt: now.getTime(),
    // 随信的照片（letters/img/…）一起带走
    files: [rel, ...images.map((p) => `letters/${p}`)],
    preview: preview.replace(/\s+/g, ' ').slice(0, 80),
    kind: 'letter',
    letterId,
  }
  const dir = `${TRASH}/${item.id}`
  await store.mkdirp(dir)
  await store.writeText(`${dir}/info.json`, JSON.stringify(item))
  for (const f of item.files) await move(store, `${ROOT}/${f}`, `${dir}/${f}`)
  return item
}

/**
 * 把几张没被用到的图片移到最近删除（一次一条）。date：编辑时去掉的是那篇日记的日期，清理时是清理那天。
 */
export async function trashImages(
  store: FileStore, images: ImageRef[], date: string, source: 'edit' | 'cleanup', now = new Date(),
): Promise<TrashItem | null> {
  if (!images.length) return null
  const item: TrashItem = {
    id: `images_${date}_${now.getTime()}`,
    date,
    deletedAt: now.getTime(),
    files: images.map((i) => i.rel),
    preview: '',
    kind: 'images',
    source,
    refs: Object.fromEntries(images.map((i) => [i.rel, i.md])),
  }
  const dir = `${TRASH}/${item.id}`
  await store.mkdirp(dir)
  await store.writeText(`${dir}/info.json`, JSON.stringify(item))
  for (const f of item.files) await move(store, `${ROOT}/${f}`, `${dir}/${f}`)
  return item
}

/** 恢复图片会接回哪几天的日记 */
export function imageDays(t: Pick<TrashItem, 'files' | 'date'>): string[] {
  return [...new Set(t.files.map((f) => imageDay(f, t.date)))].sort()
}

/**
 * 恢复图片：放回原处，并在那天日记的末尾接上引用（那天没有日记时新建一篇只有图片的）。
 * 原处已有同名文件时保留现有的；正文里已经引用着这张图时不再重复接。
 */
async function restoreImages(repo: DiaryRepo, dir: string, info: TrashItem, now: Date): Promise<void> {
  const store = repo.store
  const byDay = new Map<string, string[]>()
  for (const rel of info.files) {
    if (!(await store.stat(`${ROOT}/${rel}`))) await move(store, `${dir}/${rel}`, `${ROOT}/${rel}`)
    const d = imageDay(rel, info.date)
    byDay.set(d, [...(byDay.get(d) ?? []), rel])
  }
  for (const [d, rels] of byDay) {
    const raw = await repo.readEntryRaw(d)
    const doc: EntryDoc = raw == null ? { meta: { date: d }, body: '', extra: [] } : parseEntry(raw, d)
    const have = new Set(namesIn(doc.body))
    const add = rels
      .filter((r) => !have.has(r.slice(r.lastIndexOf('/') + 1).toLowerCase()))
      .map((r) => info.refs?.[r] ?? mdFor(r))
    if (!add.length) continue
    doc.body = [doc.body.replace(/\s+$/, ''), ...add].filter(Boolean).join('\n\n')
    await repo.saveEntry(doc, now)
  }
}

export async function listTrash(store: FileStore): Promise<TrashItem[]> {
  const out: TrashItem[] = []
  for (const f of await store.list(TRASH)) {
    if (f.type !== 'directory') continue
    try {
      const info = JSON.parse((await store.readText(`${TRASH}/${f.name}/info.json`)) ?? '') as TrashItem
      if (info?.date) out.push({ ...info, id: f.name })
    } catch { /* 坏掉的条目忽略，清理时一并删掉 */ }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt)
}

/**
 * 恢复。这一天在删除后又写了新日记时不覆盖，抛错让用户先处理；
 * 图片的原位置已有同名文件时保留现有的。
 */
export async function restoreTrash(repo: DiaryRepo, id: string, now = new Date()): Promise<string> {
  const store = repo.store
  const dir = `${TRASH}/${id}`
  const info = JSON.parse((await store.readText(`${dir}/info.json`)) ?? 'null') as TrashItem | null
  if (!info) throw new Error('找不到这条删除记录')
  if (info.kind === 'images') {
    // 日记文件格式有误时 parseEntry 会抛错：这时什么都不动，条目留在最近删除里
    for (const d of imageDays(info)) {
      const raw = await repo.readEntryRaw(d)
      if (raw == null) continue
      try {
        parseEntry(raw, d)
      } catch {
        throw new Error(`${d} 的日记格式有误，没法把图片接回去。先修好那篇日记再恢复。`)
      }
    }
    await restoreImages(repo, dir, info, now)
    await store.rmdir(dir)
    return info.date
  }
  if (info.kind === 'letter') {
    for (const rel of info.files) {
      if (await store.stat(`${ROOT}/${rel}`)) throw new Error('同名的信已经在了，没有覆盖它')
      await move(store, `${dir}/${rel}`, `${ROOT}/${rel}`)
    }
    await store.rmdir(dir)
    return info.date
  }
  if (await store.stat(entryPath(info.date))) {
    throw new Error(`${info.date} 已经有新写的日记了。要恢复旧的，先把新的删掉，或者把需要的内容复制过去。`)
  }
  for (const rel of info.files) {
    if (await store.stat(`${ROOT}/${rel}`)) continue
    await move(store, `${dir}/${rel}`, `${ROOT}/${rel}`)
  }
  await store.rmdir(dir)
  return info.date
}

export async function purgeTrashItem(store: FileStore, id: string): Promise<void> {
  await store.rmdir(`${TRASH}/${id}`)
}

/** 清掉超过保留期的条目和坏掉的条目。启动时调用。 */
export async function purgeTrash(store: FileStore, now = new Date(), days = KEEP_DAYS): Promise<number> {
  const ok = new Map((await listTrash(store)).map((t) => [t.id, t]))
  let n = 0
  for (const f of await store.list(TRASH)) {
    const t = ok.get(f.name)
    if (!t || now.getTime() - t.deletedAt > days * DAY) {
      await store.rmdir(`${TRASH}/${f.name}`)
      n++
    }
  }
  return n
}

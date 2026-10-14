/**
 * 没被用到的图片（2026-10-14 加入，规格 4.10）。
 *
 * - 编辑时删掉了图片的引用，图片文件以前会一直留在 attachments/ 里。现在离开编辑页时，把这次去掉的图
 *   （打开时引用着的、或这次新插的）移到最近删除；设置里还可以手动找出历史上没被用到的图。
 * - 一律移到最近删除（不直接删），恢复时把图接回那天日记的末尾。
 * - 判断“有没有被用到”很保守：在所有日记和信的原文里出现过文件名（不分大小写），就算用到。
 */
import type { FileStore } from './types'
import { ROOT, type DiaryRepo } from './repo'

const DAY = 86400000
/** 读文件时同时读几个（真机上每读一个都要过一次插件通道） */
const CONCURRENCY = 8

export interface ImageRef {
  /** 相对 diary/ 的路径，如 attachments/2026/2026-10-14_1.webp */
  rel: string
  /** 正文里引用它的那段 Markdown（带说明），恢复时原样接回 */
  md: string
}

/** 正文里引用的本地图片（app 的写法 `![说明](../../attachments/…)`），同一张图只算一次 */
export function imageRefs(body: string): ImageRef[] {
  const out = new Map<string, ImageRef>()
  const re = /!\[[^\]\n]*\]\((?:\.\.\/\.\.\/)?(attachments\/[^)\s]+)\)/g
  for (const m of body.matchAll(re)) {
    let rel = m[1]
    try { rel = decodeURI(rel) } catch { /* 保持原样 */ }
    if (!out.has(rel)) out.set(rel, { rel, md: m[0] })
  }
  return [...out.values()]
}

/** 图片属于哪一天：文件名以日期开头（插图和导入都这样命名），否则用 fallback */
export function imageDay(rel: string, fallback: string): string {
  return /(?:^|\/)(\d{4}-\d{2}-\d{2})_[^/]*$/.exec(rel)?.[1] ?? fallback
}

export const mdFor = (rel: string) => `![](../../${rel})`

const IMG_NAME = /[^\s/\\()[\]"'<>|]+\.(?:jpe?g|png|webp|gif|heic|heif|bmp|avif)/gi

/** 一段文字里出现过的图片文件名（小写） */
export function namesIn(text: string): string[] {
  return [...text.matchAll(IMG_NAME)].map((m) => m[0].toLowerCase())
}

async function mapLimit<T>(items: T[], fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0
  const worker = async () => {
    while (i < items.length) await fn(items[i++])
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

/** 所有日记和信里出现过的图片文件名（小写） */
export async function referencedNames(repo: DiaryRepo): Promise<Set<string>> {
  const names = new Set<string>()
  const add = (raw: string | null) => {
    if (raw) for (const n of namesIn(raw)) names.add(n)
  }
  await mapLimit(await repo.listEntryFiles(), async (f) => add(await repo.store.readText(f.path)))
  const letters = (await repo.store.list(`${ROOT}/letters`)).filter((f) => f.type === 'file' && f.name.endsWith('.md'))
  await mapLimit(letters, async (f) => add(await repo.store.readText(`${ROOT}/letters/${f.name}`)))
  return names
}

const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()

export interface OrphanImage {
  rel: string
  size: number
  mtime: number
}

async function listAttachments(store: FileStore): Promise<OrphanImage[]> {
  const out: OrphanImage[] = []
  for (const y of await store.list(`${ROOT}/attachments`)) {
    if (y.type !== 'directory') continue
    for (const f of await store.list(`${ROOT}/attachments/${y.name}`)) {
      if (f.type === 'file') out.push({ rel: `attachments/${y.name}/${f.name}`, size: f.size, mtime: f.mtime })
    }
  }
  return out
}

/**
 * 找出没被任何日记或信用到的图片。一天内改过的跳过：可能正插在一篇还没保存的日记里。
 */
export async function findOrphans(repo: DiaryRepo, now = new Date(), minAge = DAY): Promise<OrphanImage[]> {
  const files = await listAttachments(repo.store)
  if (!files.length) return []
  const used = await referencedNames(repo)
  return files
    .filter((f) => !used.has(baseName(f.rel)) && now.getTime() - f.mtime >= minAge)
    .sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

/**
 * 离开编辑页时：这一篇这次去掉了哪些图。
 * 候选是打开时正文里引用的图，加上这次编辑期间新存的这一天的图（文件名以日期开头、修改时间不早于打开时）；
 * 去掉现在这篇里还引用的，再去掉其他日记或信里用到的。
 */
export async function removedInSession(
  repo: DiaryRepo,
  date: string,
  originalBody: string,
  openedAt: number,
): Promise<ImageRef[]> {
  const cand = new Map<string, ImageRef>()
  for (const r of imageRefs(originalBody)) cand.set(r.rel, r)
  const dir = `attachments/${date.slice(0, 4)}`
  for (const f of await repo.store.list(`${ROOT}/${dir}`)) {
    const rel = `${dir}/${f.name}`
    if (f.type === 'file' && f.name.startsWith(`${date}_`) && f.mtime >= openedAt - 2000 && !cand.has(rel)) {
      cand.set(rel, { rel, md: mdFor(rel) })
    }
  }
  if (!cand.size) return []
  // 现在这篇里还在用的先排除，剩下的才需要翻全部日记
  const now = namesIn((await repo.readEntryRaw(date)) ?? '')
  for (const [rel] of cand) if (now.includes(baseName(rel))) cand.delete(rel)
  const exists = async (rel: string) => !!(await repo.store.stat(`${ROOT}/${rel}`))
  for (const [rel] of cand) if (!(await exists(rel))) cand.delete(rel)
  if (!cand.size) return []
  const used = await referencedNames(repo)
  return [...cand.values()].filter((r) => !used.has(baseName(r.rel)))
}

/**
 * 导入日记（2026-10-13 加入，规格 5.12）。两种来源：
 *
 * 1. 浮生记导出的 zip（里面有 format.json 和 entries/）：日记原文照搬，图片、总结、写给未来的信一起带过来。
 * 2. Markdown / 纯文本文件（一个文件夹压成的 zip，或直接多选的 .md / .txt）：
 *    日期依次从 front matter 的 date、文件名、开头的标题里找；找不到的列出来、跳过。
 *    同一天有好几个文件时合成一篇，每个文件一段，段落标题是文件名。
 *    正文里引用的本地图片（`![](相对路径)`、Obsidian 的 `![[图片]]`）复制进 attachments/，链接改成 app 的写法。
 *
 * 规则：
 * - 不覆盖手机上已有的日记。同一天两边都有、内容不同时，按用户选择：keep 保留手机上的（列出来），
 *   append 把导入的正文接在后面（加一个“### 导入”标题），心情、天气、位置只在手机上没有时补上，标签人物地点取并集。
 * - 先 planImport 把要做的事算出来（只读文字，不读图片）给用户确认，再 applyImport 写盘。
 * - 图片：同名文件不存在就照原名放；已有同名而内容不同，换一个不冲突的名字并改正文里的链接。
 */
import type { EntryMeta } from './types'
import { LIST_FIELDS } from './types'
import { DiaryRepo, ROOT, entryPath } from './repo'
import { hasContent, hasRecord, normalizeNewlines, parseEntry, serializeEntry, type EntryDoc } from './entryFile'
import { isValidYmd, isoLocal } from './time'
import { fromBase64, toBase64 } from './bytes'

export interface ImportFile {
  /** 在 zip 里的路径（直接选的文件就是文件名），用 / 分隔 */
  path: string
  size: number
  read(): Promise<Uint8Array>
}

export type ImportKind = 'fusheng' | 'markdown'
export type DupMode = 'keep' | 'append'

interface ImageRef {
  /** 正文里的原文，如 `![说明](img/a.jpg)` */
  match: string
  alt: string
  /** 对应的来源文件 */
  file: ImportFile
}

export interface PlannedEntry {
  date: string
  sources: string[]
  /** 浮生记 zip 的日记原文（照搬，只改图片链接） */
  raw?: string
  doc: EntryDoc
  images: ImageRef[]
  /** 手机上这一天：none 没有；same 一样；differ 不一样 */
  local: 'none' | 'same' | 'differ'
}

export interface ImportPlan {
  kind: ImportKind
  entries: PlannedEntry[]
  /** 浮生记 zip 里其余要带过来的文件（没被日记引用的图片、AI 总结、写给未来的信），目标是 diary/ 下的相对路径；手机上已有的不动 */
  others: { target: string; file: ImportFile }[]
  /** 认不出日期的文件 */
  unrecognized: string[]
  /** 认出了日期、但什么都没写的文件 */
  empty: string[]
  /** 正文引用了、但包里找不到（或格式不支持）的图片 */
  missingImages: number
  /** 要带过来的图片（不重复计数） */
  imageCount: number
}

export interface ImportResult {
  imported: string[]
  appended: string[]
  /** 两边都有、保留了手机上的 */
  kept: string[]
  /** 两边一样，不用导 */
  same: number
  images: number
}

const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif)$/i
const TEXT_EXT = /\.(md|markdown|txt)$/i
const dec = new TextDecoder()

/** 隐藏文件、系统垃圾（.obsidian、__MACOSX、.DS_Store……）不看 */
function ignored(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX')
}

const pad = (n: number) => String(n).padStart(2, '0')

/** 从一段文字里找日期：2024-01-02、2024_1_2、2024.01.02、2024/1/2、20240102、2024年1月2日 */
export function findDate(s: string): string | null {
  const pats = [
    /(\d{4})[-_./](\d{1,2})[-_./](\d{1,2})(?!\d)/,
    /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/,
    /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/,
  ]
  for (const re of pats) {
    const m = re.exec(s)
    if (!m) continue
    const y = Number(m[1])
    const d = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`
    if (y >= 1900 && y <= 2100 && isValidYmd(d)) return d
  }
  return null
}

const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const stem = (p: string) => basename(p).replace(/\.[^.]+$/, '')

/** 把相对路径拼到目录上，处理 . 和 .. */
function joinPath(dir: string, rel: string): string {
  const out: string[] = dir ? dir.split('/') : []
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

class FileTable {
  readonly byPath = new Map<string, ImportFile>()
  private readonly byLower = new Map<string, ImportFile>()
  private readonly byName = new Map<string, ImportFile[]>()
  constructor(files: ImportFile[]) {
    for (const f of files) {
      this.byPath.set(f.path, f)
      this.byLower.set(f.path.toLowerCase(), f)
      const n = basename(f.path).toLowerCase()
      this.byName.set(n, [...(this.byName.get(n) ?? []), f])
    }
  }
  get(path: string): ImportFile | undefined {
    return this.byPath.get(path) ?? this.byLower.get(path.toLowerCase())
  }
  /** Obsidian 的 ![[名字]]：按文件名找，同目录的优先 */
  byBasename(name: string, nearDir: string): ImportFile | undefined {
    const list = this.byName.get(basename(name).toLowerCase())
    if (!list?.length) return undefined
    return list.find((f) => dirname(f.path) === nearDir) ?? list[0]
  }
}

/** 找出正文引用的本地图片 */
function collectImages(body: string, fromPath: string, table: FileTable): { refs: ImageRef[]; missing: number } {
  const dir = dirname(fromPath)
  const refs: ImageRef[] = []
  let missing = 0
  const md = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g
  for (const m of body.matchAll(md)) {
    let target = m[2].replace(/^<|>$/g, '')
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue // 网络图片、data:
    target = safeDecode(target.split(/[?#]/)[0])
    const f = table.get(joinPath(dir, target)) ?? table.get(joinPath('', target))
    if (f && IMG_EXT.test(f.path)) refs.push({ match: m[0], alt: m[1], file: f })
    else missing++
  }
  const wiki = /!\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g
  for (const m of body.matchAll(wiki)) {
    const name = m[1].trim()
    if (!IMG_EXT.test(name)) continue // ![[另一篇笔记]] 是嵌入笔记，不是图片
    const f = table.get(joinPath(dir, name)) ?? table.byBasename(name, dir)
    if (f) refs.push({ match: m[0], alt: '', file: f })
    else missing++
  }
  return { refs, missing }
}

/** 正文开头单独一行的日期标题（如“# 2024-01-02 星期二”）和 app 的标题重复，去掉 */
function stripDateHeading(body: string): string {
  const m = /^\s*#{1,6}[ \t]+([^\n]*)\n?/.exec(body)
  if (!m || !findDate(m[1])) return body
  const rest = m[1]
    .replace(/(\d{4})[-_./年\s]*(\d{1,2})[-_./月\s]*(\d{1,2})[日号]?/, '')
    .replace(/(星期|周|礼拜)[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun/gi, '')
    .replace(/[\s,，、·.()（）-]/g, '')
  return rest ? body : body.slice(m[0].length).replace(/^\n+/, '')
}

interface ParsedMd {
  path: string
  date: string
  doc: EntryDoc
}

function parseMarkdownFile(path: string, text: string): ParsedMd | null {
  const raw = normalizeNewlines(text)
  const nameDate = findDate(stem(path)) ?? findDate(path)
  let doc: EntryDoc
  try {
    doc = parseEntry(raw, nameDate ?? '0000-00-00')
  } catch {
    // front matter 写坏了：整篇当正文，什么都不丢
    doc = { meta: { date: nameDate ?? '0000-00-00' }, body: raw.trim(), extra: [] }
  }
  const fmDate = findDate(String(doc.meta.date))
  const headDate = findDate(/^\s*#{1,6}[ \t]+([^\n]*)/.exec(doc.body)?.[1] ?? '')
  const date = fmDate ?? nameDate ?? headDate
  if (!date) return null
  doc.meta.date = date
  doc.body = stripDateHeading(doc.body).trimEnd()
  return { path, date, doc }
}

/** 同一天好几个文件：每个文件一段，标题是文件名 */
function mergeSameDay(list: ParsedMd[]): EntryDoc {
  if (list.length === 1) return list[0].doc
  const first = list[0].doc
  const meta: EntryMeta = { ...first.meta }
  for (const p of list.slice(1)) mergeMeta(meta, p.doc.meta)
  const body = list
    .filter((p) => hasContent(p.doc.body))
    .map((p) => `### ${stem(p.path)}\n${p.doc.body}`)
    .join('\n\n')
  return { meta, body, extra: first.extra }
}

/** 把 b 的心情、天气、位置补到 a 上（a 没有时），标签人物地点取并集 */
function mergeMeta(a: EntryMeta, b: EntryMeta) {
  if (a.mood == null && b.mood != null) a.mood = b.mood
  if (!a.weather && b.weather) a.weather = b.weather
  if (!a.location && b.location) a.location = b.location
  for (const f of LIST_FIELDS) {
    const u = [...new Set([...(a[f] ?? []), ...(b[f] ?? [])])]
    if (u.length) a[f] = u
  }
}

/** 找浮生记 zip 的根目录（format.json 所在、旁边有 entries/ 的那一层），不是就返回 null */
function fushengRoot(files: ImportFile[]): string | null {
  const paths = new Set(files.map((f) => f.path))
  for (const p of paths) {
    if (basename(p) !== 'format.json') continue
    const root = p.slice(0, -'format.json'.length)
    if (files.some((f) => f.path.startsWith(`${root}entries/`))) return root
  }
  return null
}

export async function planImport(input: ImportFile[], repo: DiaryRepo): Promise<ImportPlan> {
  const files = input.filter((f) => !ignored(f.path) && !f.path.endsWith('/'))
  const table = new FileTable(files)
  const root = fushengRoot(files)
  const plan: ImportPlan = {
    kind: root != null ? 'fusheng' : 'markdown', entries: [], others: [], unrecognized: [], empty: [], missingImages: 0, imageCount: 0,
  }
  const used = new Set<ImportFile>()

  if (root != null) {
    for (const f of files) {
      if (!f.path.startsWith(root)) continue
      const rel = f.path.slice(root.length)
      const m = /^entries\/\d{4}\/(\d{4}-\d{2}-\d{2})\.md$/.exec(rel)
      if (m && isValidYmd(m[1])) {
        const raw = normalizeNewlines(dec.decode(await f.read()))
        let doc: EntryDoc
        try {
          doc = parseEntry(raw, m[1])
        } catch {
          // 格式有误的文件也照搬：app 里会只读显示，不会改它
          doc = { meta: { date: m[1] }, body: raw, extra: [] }
        }
        const { refs, missing } = collectImages(doc.body, f.path, table)
        plan.missingImages += missing
        refs.forEach((r) => used.add(r.file))
        plan.entries.push({ date: m[1], sources: [f.path], raw, doc, images: refs, local: 'none' })
      }
    }
    for (const f of files) {
      if (!f.path.startsWith(root) || used.has(f)) continue
      const rel = f.path.slice(root.length)
      if (rel.startsWith('attachments/') || rel.startsWith('summaries/') || /^letters\/([^/]+\.md|img\/[^/]+)$/.test(rel) || /^annotations\/\d{4}\/\d{4}-\d{2}-\d{2}\.md$/.test(rel)) plan.others.push({ target: rel, file: f })
    }
  } else {
    const byDate = new Map<string, ParsedMd[]>()
    for (const f of files) {
      if (!TEXT_EXT.test(f.path)) continue
      const p = parseMarkdownFile(f.path, dec.decode(await f.read()))
      if (!p) {
        plan.unrecognized.push(f.path)
        continue
      }
      if (!hasRecord(p.doc)) {
        plan.empty.push(f.path)
        continue
      }
      byDate.set(p.date, [...(byDate.get(p.date) ?? []), p])
    }
    for (const [date, list] of byDate) {
      list.sort((a, b) => a.path.localeCompare(b.path))
      const refs: ImageRef[] = []
      for (const p of list) {
        const r = collectImages(p.doc.body, p.path, table)
        refs.push(...r.refs)
        plan.missingImages += r.missing
      }
      refs.forEach((r) => used.add(r.file))
      plan.entries.push({ date, sources: list.map((p) => p.path), doc: mergeSameDay(list), images: refs, local: 'none' })
    }
  }

  for (const e of plan.entries) {
    const local = await repo.readEntryRaw(e.date)
    if (local == null) continue
    const incoming = e.raw ?? serializeEntry(e.doc)
    e.local = normalizeNewlines(local) === incoming ? 'same' : 'differ'
  }
  plan.entries.sort((a, b) => (a.date < b.date ? -1 : 1))
  plan.imageCount = used.size
  return plan
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

export async function applyImport(
  plan: ImportPlan,
  repo: DiaryRepo,
  opts: { mode: DupMode; now?: Date; onProgress?: (done: number, total: number) => void },
): Promise<ImportResult> {
  const store = repo.store
  const now = opts.now ?? new Date()
  const result: ImportResult = { imported: [], appended: [], kept: [], same: 0, images: 0 }
  /** 每个年份目录里已占用的文件名（不带扩展名） */
  const taken = new Map<string, Set<string>>()
  async function takenIn(year: string): Promise<Set<string>> {
    let s = taken.get(year)
    if (!s) {
      s = new Set((await store.list(`${ROOT}/attachments/${year}`)).map((f) => f.name.replace(/\.[^.]+$/, '')))
      taken.set(year, s)
    }
    return s
  }
  /** 已经写过的来源图片 → 在正文里的新路径（同一张图被引用多次只复制一次） */
  const placed = new Map<ImportFile, string>()

  /** 把一张图放进 attachments/，返回相对日记文件的链接路径 */
  async function place(file: ImportFile, date: string): Promise<string> {
    const done = placed.get(file)
    if (done) return done
    const bytes = await file.read()
    const year = date.slice(0, 4)
    const names = await takenIn(year)
    let name: string | null = null
    if (plan.kind === 'fusheng') {
      // 浮生记的图片名本来就是 app 的写法：没被占用、或者是同一张图，就用原名
      const orig = basename(file.path)
      const existing = await store.readBase64(`${ROOT}/attachments/${year}/${orig}`)
      if (existing == null || sameBytes(fromBase64(existing), bytes)) name = orig
    }
    if (!name) {
      let n = 1
      while (names.has(`${date}_${n}`)) n++
      const ext = (/\.([^.]+)$/.exec(file.path)?.[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg')
      name = `${date}_${n}.${ext}`
    }
    const target = `${ROOT}/attachments/${year}/${name}`
    if ((await store.stat(target)) == null) {
      await store.mkdirp(`${ROOT}/attachments/${year}`)
      await store.writeBase64(target, toBase64(bytes))
      result.images++
    }
    names.add(name.replace(/\.[^.]+$/, ''))
    const link = `../../attachments/${year}/${name}`
    placed.set(file, link)
    return link
  }

  /** 复制图片并改写正文里的链接 */
  async function rewrite(text: string, e: PlannedEntry): Promise<string> {
    let out = text
    for (const r of e.images) {
      const link = await place(r.file, e.date)
      const next = `![${r.alt}](${link})`
      if (next !== r.match) out = out.split(r.match).join(next)
    }
    return out
  }

  let done = 0
  const total = plan.entries.length + plan.others.length
  const tick = () => opts.onProgress?.(++done, total)

  for (const e of plan.entries) {
    if (e.local === 'same') {
      result.same++
      tick()
      continue
    }
    if (e.local === 'differ' && opts.mode === 'keep') {
      result.kept.push(e.date)
      tick()
      continue
    }
    if (e.local === 'differ') {
      const localRaw = await repo.readEntryRaw(e.date)
      let local: EntryDoc
      try {
        local = parseEntry(localRaw ?? '', e.date)
      } catch {
        // 手机上这篇格式有误：app 不改它，按“保留手机上的”处理
        result.kept.push(e.date)
        tick()
        continue
      }
      const incomingBody = await rewrite(e.doc.body, e)
      if (hasContent(incomingBody)) {
        const base = local.body.trimEnd()
        local.body = base ? `${base}\n\n### 导入\n${incomingBody.trim()}` : incomingBody.trim()
      }
      mergeMeta(local.meta, e.doc.meta)
      local.meta.updated = isoLocal(now)
      await repo.writeAtomic(entryPath(e.date), serializeEntry(local))
      result.appended.push(e.date)
      tick()
      continue
    }
    let text: string
    if (e.raw != null) text = await rewrite(e.raw, e)
    else {
      const doc: EntryDoc = { ...e.doc, meta: { ...e.doc.meta }, body: await rewrite(e.doc.body, e) }
      doc.meta.created ??= isoLocal(now)
      text = serializeEntry(doc)
    }
    await repo.writeAtomic(entryPath(e.date), text)
    result.imported.push(e.date)
    tick()
  }

  for (const o of plan.others) {
    const target = `${ROOT}/${o.target}`
    if ((await store.stat(target)) == null) {
      const bytes = await o.file.read()
      await store.mkdirp(dirname(target))
      await store.writeBase64(target, toBase64(bytes))
      if (o.target.startsWith('attachments/')) result.images++
    }
    tick()
  }
  return result
}

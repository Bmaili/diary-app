/**
 * 写给未来的信（2026-10-13 加入，规格 4.8、5.13）。
 *
 * 一封信一个文件：diary/letters/<写信日期>_<编号>.md，YAML front matter 加 Markdown 正文。
 *
 * ```
 * ---
 * written: 2026-10-13T10:00:00+08:00
 * open_on: 2027-10-13
 * remind: true
 * opened: 2027-10-13T09:12:00+08:00   ← 拆开后才有
 * ---
 *
 * 一年后的我：……
 * ```
 *
 * - “到期才能看”只是界面上的封存：文件是明文（开了云端加密的话云端是密文）。
 * - 信不进日记索引，所以问答、搜索、总结、首页提示本来就读不到它。
 * - 未知字段原样保留，和日记文件一样。
 */
import { Document, isMap, isScalar, parseDocument, Pair, YAMLMap } from 'yaml'
import type { FileStore } from './types'
import { ROOT } from './repo'
import { normalizeNewlines } from './entryFile'
import { addDays, isValidYmd } from './time'

export const LETTERS = `${ROOT}/letters`

export interface LetterMeta {
  /** 写信（封存）的时间，ISO 8601 带时区 */
  written: string
  /** 哪天可以拆，YYYY-MM-DD（按“一天”的切换时刻算） */
  open_on: string
  /** 到那天发通知 */
  remind?: boolean
  /** 第一次拆开的时间 */
  opened?: string
}

export interface Letter {
  /** 文件名去掉 .md，如 2026-10-13_1 */
  id: string
  meta: LetterMeta
  body: string
  extra: Pair[]
}

const KEYS = ['written', 'open_on', 'remind', 'opened'] as const

export const letterPath = (id: string) => `${LETTERS}/${id}.md`

export function parseLetter(raw: string, id: string): Letter {
  const text = normalizeNewlines(raw)
  const m = /^---[ \t]*\n([\s\S]*?)\n?^---[ \t]*$/m.exec(text)
  if (!m || m.index !== 0) throw new Error('信的开头格式不对')
  const doc = parseDocument(m[1])
  if (doc.errors.length || (doc.contents && !isMap(doc.contents))) throw new Error('信的开头格式不对')
  const meta: Record<string, unknown> = {}
  const extra: Pair[] = []
  for (const item of (doc.contents as YAMLMap | null)?.items ?? []) {
    const key = isScalar(item.key) ? String(item.key.value) : String(item.key)
    const v = item.value as { toJSON?: () => unknown } | null
    if ((KEYS as readonly string[]).includes(key)) meta[key] = v && typeof v.toJSON === 'function' ? v.toJSON() : v
    else extra.push(item as Pair)
  }
  const openOn = String(meta.open_on ?? '')
  if (!isValidYmd(openOn)) throw new Error('信里没有有效的 open_on 日期')
  const out: LetterMeta = { written: String(meta.written ?? ''), open_on: openOn }
  if (meta.remind === true || meta.remind === 'true') out.remind = true
  if (meta.opened != null && meta.opened !== '') out.opened = String(meta.opened)
  const body = text.slice(m[0].length).replace(/^\n+/, '').replace(/\s+$/, '')
  return { id, meta: out, body, extra }
}

export function serializeLetter(l: Letter): string {
  const doc = new Document()
  const map = new YAMLMap()
  for (const k of KEYS) {
    const v = l.meta[k]
    if (v == null || v === '' || v === false) continue
    map.items.push(new Pair(doc.createNode(k), doc.createNode(v)))
  }
  for (const p of l.extra) map.items.push(p)
  doc.contents = map as unknown as Document['contents']
  const body = l.body.replace(/\s+$/, '')
  return `---\n${doc.toString({ lineWidth: 0 })}---\n\n${body}\n`
}

export type LetterState = 'sealed' | 'arrived' | 'opened'

/** 封着 / 到了还没拆 / 拆过了 */
export function letterState(l: Letter, today: string): LetterState {
  if (l.meta.opened) return 'opened'
  return l.meta.open_on <= today ? 'arrived' : 'sealed'
}

/** 读出全部的信：按拆信日期排，坏掉的文件跳过（不改它） */
export async function listLetters(store: FileStore): Promise<{ letters: Letter[]; broken: string[] }> {
  const letters: Letter[] = []
  const broken: string[] = []
  for (const f of await store.list(LETTERS)) {
    if (f.type !== 'file' || !f.name.endsWith('.md')) continue
    const id = f.name.slice(0, -3)
    const raw = await store.readText(`${LETTERS}/${f.name}`)
    if (raw == null) continue
    try {
      letters.push(parseLetter(raw, id))
    } catch {
      broken.push(f.name)
    }
  }
  letters.sort((a, b) => (a.meta.open_on === b.meta.open_on ? (a.id < b.id ? -1 : 1) : a.meta.open_on < b.meta.open_on ? -1 : 1))
  return { letters, broken }
}

// ---------- 随信附上的照片（2026-10-13 加入） ----------

/** 信里的照片放在 letters/img/ 下，信里用相对路径 `![](img/…)` 引用（不放 attachments/：免得删除那天的日记时被一起带走） */
export const LETTER_IMG = `${LETTERS}/img`

const IMG_RE = /!\[[^\]]*\]\((img\/[^)\s]+)\)/g

/** 信里引用的照片（相对 letters/ 的路径，如 img/2026-10-13_k9x2a.webp） */
export function letterImages(body: string): string[] {
  return [...new Set([...body.matchAll(IMG_RE)].map((m) => m[1]))]
}

/** 封存时的正文：文字在前，照片一张一段接在后面 */
export function letterBody(text: string, images: string[]): string {
  const t = text.trim()
  const imgs = images.map((p) => `![](${p})`).join('\n\n')
  return [t, imgs].filter(Boolean).join('\n\n')
}

/** 信的文字部分（去掉照片），信匣和最近删除里的摘要用 */
export function letterText(body: string): string {
  return body.replace(IMG_RE, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 新信的编号：同一天写的第几封 */
export async function newLetterId(store: FileStore, writtenDate: string): Promise<string> {
  const used = new Set((await store.list(LETTERS)).map((f) => f.name.replace(/\.md$/, '')))
  let n = 1
  while (used.has(`${writtenDate}_${n}`)) n++
  return `${writtenDate}_${n}`
}

/** 写信页的快捷日期：一年后、明年元日、三年后 */
export function quickDates(today: string): { label: string; date: string }[] {
  const y = Number(today.slice(0, 4))
  const md = today.slice(4)
  // 2 月 29 日写的，“一年后”落在 2 月 28 日
  const sameDay = (yy: number) => (isValidYmd(`${yy}${md}`) ? `${yy}${md}` : addDays(`${yy}${md.replace('-29', '-28')}`, 0))
  return [
    { label: '一年后', date: sameDay(y + 1) },
    { label: '明年元日', date: `${y + 1}-01-01` },
    { label: '三年后', date: sameDay(y + 3) },
  ]
}

/** 还有几天 */
export function daysUntil(today: string, date: string): number {
  return Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000)
}

/** 到期提醒的通知编号：和写日记提醒（REMINDER_BASE_ID 起的 100 个）错开 */
export const LETTER_BASE_ID = 300000
export const LETTER_MAX = 500

/** 要排的通知：还封着、开了提醒、拆信那天早上 9 点还没过 */
export function planLetterReminders(list: Letter[], now: Date): { id: number; at: Date; letter: string }[] {
  const out: { id: number; at: Date; letter: string }[] = []
  list.forEach((l, i) => {
    if (!l.meta.remind || l.meta.opened || i >= LETTER_MAX) return
    const at = new Date(`${l.meta.open_on}T09:00:00`)
    if (at.getTime() > now.getTime()) out.push({ id: LETTER_BASE_ID + i, at, letter: l.id })
  })
  return out
}

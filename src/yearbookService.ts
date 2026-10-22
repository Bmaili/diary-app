/**
 * 年度日记本（2026-10-13 加入，规格 5.17）：读一年的日记 → 排成网页（core/yearbook.ts）→ 交给打印。
 * 真机用原生插件 Print（android/.../PrintPlugin.java）调安卓系统打印，用户选“另存为 PDF”或连打印机；
 * 图片用相对 diary/ 的路径，由打印用的 WebView 直接读文件，不把图片转成 base64 塞进网页。
 * 浏览器里（调试）用隐藏的 iframe 调 window.print()，图片换成 data: 地址。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { index, repo, store, today } from './app'
import { prefs } from './prefs'
import { ROOT } from './core/repo'
import { hasRecord } from './core/entryFile'
import { annotationPath, parseAnnotation } from './core/annotation'
import { readSummary } from './core/summaries'
import { buildYearbook, estimatePages, yearStats, type YearbookEntry } from './core/yearbook'
import { renderMarkdown } from './ui/markdown'
import { lunar } from './holidayService'
import { mimeOfPath } from './imageService'
import { expectExternal } from './lockService'

export interface YearbookOptions {
  year: string
  starredOnly: boolean
  photos: boolean
  summaries: boolean
}

const Print = registerPlugin<{ print(o: { html: string; title: string }): Promise<{ started: boolean }> }>('Print')

/** 有日记的年份，新的在前 */
export function yearbookYears(): string[] {
  return [...new Set(index.all().filter((r) => !r.error).map((r) => r.date.slice(0, 4)))].sort().reverse()
}

/** 这一年要排进去的日子（日期正序） */
export function yearbookDates(year: string, starredOnly: boolean): string[] {
  return index
    .all()
    .filter((r) => r.date.startsWith(`${year}-`) && !r.error && (!starredOnly || r.starred))
    .map((r) => r.date)
    .reverse()
}

/** 每篇的字数和图片数（估页数用），按日期缓存，文件改了（mtime 变了）重新数 */
const sizes = new Map<string, { mtime: number; chars: number; images: number }>()

async function sizeOf(d: string): Promise<{ chars: number; images: number } | null> {
  const r = index.get(d)
  if (!r) return null
  let s = sizes.get(d)
  if (!s || s.mtime !== r.mtime) {
    const raw = (await store.readText(r.path)) ?? ''
    s = { mtime: r.mtime, chars: r.text.length, images: (raw.match(/!\[[^\]]*\]\(\.\.\/\.\.\/attachments\//g) ?? []).length }
    sizes.set(d, s)
  }
  return s
}

export async function estimateYearbook(o: YearbookOptions): Promise<number> {
  const dates = yearbookDates(o.year, o.starredOnly)
  const list: { chars: number; images: number }[] = []
  for (const d of dates) {
    const s = await sizeOf(d)
    if (s) list.push(s)
  }
  const months = new Set(dates.map((d) => d.slice(0, 7))).size
  return estimatePages(list, months, o.photos, o.summaries ? months : 0)
}

/** 正文里的图片地址：真机换成相对 diary/ 的路径（打印用的 WebView 以 diary/ 为基准读文件），浏览器里换成 data: 地址 */
async function bookSrc(html: string, photos: boolean): Promise<string> {
  if (!photos) return html
  if (Capacitor.isNativePlatform()) return html.replace(/(<img[^>]+src=")\.\.\/\.\.\/(attachments\/)/g, '$1$2')
  const srcs = new Set<string>()
  html.replace(/<img[^>]+src="\.\.\/\.\.\/(attachments\/[^"]+)"/g, (_, s: string) => {
    srcs.add(s)
    return ''
  })
  const urls = new Map<string, string>()
  for (const s of srcs) {
    const path = `${ROOT}/${decodeURI(s)}`
    const b64 = await store.readBase64(path).catch(() => null)
    if (b64) urls.set(s, `data:${mimeOfPath(path)};base64,${b64}`)
  }
  return html.replace(/(<img[^>]+src=")\.\.\/\.\.\/(attachments\/[^"]+)(")/g, (m, a: string, s: string, b: string) =>
    urls.has(s) ? `${a}${urls.get(s)}${b}` : m,
  )
}

/** 排版：返回整本的网页和篇数 */
export async function buildYearbookHtml(o: YearbookOptions, onProgress?: (done: number, total: number) => void): Promise<{ html: string; count: number }> {
  const dates = yearbookDates(o.year, o.starredOnly)
  const entries: YearbookEntry[] = []
  let i = 0
  for (const date of dates) {
    onProgress?.(++i, dates.length)
    const doc = await repo.readEntry(date).catch(() => null)
    if (!doc || !hasRecord(doc)) continue
    let annotation: string | undefined
    const raw = await store.readText(annotationPath(date))
    if (raw) {
      try {
        annotation = parseAnnotation(raw, date).text || undefined
      } catch { /* 坏文件跳过 */ }
    }
    entries.push({ date, meta: doc.meta, html: await bookSrc(renderMarkdown(doc.body), o.photos), ...(annotation ? { annotation } : {}) })
  }
  const moods: Record<string, number> = {}
  for (const r of index.all()) if (r.date.startsWith(`${o.year}-`) && r.mood != null) moods[r.date] = r.mood
  // “这一年”那页的数：整年记了的日子（只要珍藏时也是整年）
  const rows = []
  for (const d of yearbookDates(o.year, false)) {
    const r = index.get(d)
    const s = await sizeOf(d)
    if (r && s) rows.push({ date: d, chars: s.chars, images: s.images, places: r.places, people: r.people, tags: r.tags })
  }
  const stats = yearStats(rows)
  let monthly: Record<string, string> | undefined
  let yearly: string | undefined
  if (o.summaries) {
    monthly = {}
    for (const mm of new Set(entries.map((e) => e.date.slice(5, 7)))) {
      const s = await readSummary(store, `${o.year}-${mm}`).catch(() => null)
      if (s?.body.trim()) monthly[mm] = renderMarkdown(s.body)
    }
    const y = await readSummary(store, o.year).catch(() => null)
    if (y?.body.trim()) yearly = renderMarkdown(y.body)
  }
  const html = buildYearbook({
    year: o.year, entries, moods, monthly, yearly, stats, photos: o.photos, starredOnly: o.starredOnly, today: today(), moodColors: [...prefs.ui.moodColors],
    lunar: (d) => {
      const l = lunar(d)
      return [l.full, l.jieqi, l.festival].filter(Boolean).join(' ')
    },
  })
  return { html, count: entries.length }
}

/** 交给打印。真机打开系统打印界面；浏览器里打开浏览器的打印 */
export async function printYearbook(html: string, year: string): Promise<void> {
  const title = `浮生记 ${year}`
  const w = window as unknown as { __yearbookCapture?: (html: string) => void }
  if (w.__yearbookCapture) {
    // 端到端测试：只拿排好的网页，不弹打印
    w.__yearbookCapture(html)
    return
  }
  if (Capacitor.isNativePlatform()) {
    // 打印界面是系统界面，从那里回来时不上锁。插件在打印界面打开时就返回了，
    // 所以不调 expectExternal 返回的清除函数：标记留到回来的那一刻用掉
    expectExternal()
    await Print.print({ html, title })
    return
  }
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0'
  frame.srcdoc = html
  document.body.appendChild(frame)
  await new Promise<void>((r) => (frame.onload = () => r()))
  frame.contentWindow?.print()
  setTimeout(() => frame.remove(), 60000)
}

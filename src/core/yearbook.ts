/**
 * 年度日记本（2026-10-13 加入，规格 5.17）：把一年的日记排成一本 A5 小书的网页，交给系统打印成 PDF。
 * 这里只负责排版（纯函数，有单元测试）；读文件、渲染 Markdown、换图片地址、调打印见 yearbookService.ts。
 *
 * 结构：封面 → 这一年（年度总结，可选）→ 每月一页起：月名、心情小日历、月度总结（可选）、这个月的日记 → 尾页。
 * 不内置字体，用手机自带的宋体、楷体。
 */
import { parseYmd, weekday } from './time'
import type { EntryMeta } from './types'

export interface YearbookEntry {
  date: string
  meta: EntryMeta
  /** 渲染好的正文 HTML（已经过 DOMPurify，图片地址已换好） */
  html: string
  /** 朱批 */
  annotation?: string
}

export interface YearbookInput {
  year: string
  entries: YearbookEntry[]
  /** 整年每天的心情（画心情小日历用；只要珍藏时也画全年的） */
  moods: Record<string, number>
  /** 月度总结 HTML，键是 MM */
  monthly?: Record<string, string>
  /** 年度总结 HTML */
  yearly?: string
  photos: boolean
  starredOnly: boolean
  /** 农历（可选，界面层传 holidayService 的结果） */
  lunar?: (date: string) => string
  /** 生成日期 YYYY-MM-DD，写在尾页 */
  today: string
}

const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CN_MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
const MOODS = ['很差', '不好', '一般', '不错', '很好']
/** 浅色主题的心情色（打印在白纸上） */
const MOOD_HEX = ['#3b3d4f', '#5b6d80', '#93b1ae', '#6f9460', '#e3a33b']

export const cnYear = (y: string) => [...y].map((d) => CN_DIGITS[Number(d)] ?? d).join('')

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 正文里的图片：不要照片时去掉（连同说明）；要照片时把说明印在图下面。
 * 渲染器（ui/markdown.ts）给有说明的图包了 <span class="figure">…<span class="img-cap">说明</span></span>。
 */
export function bookImages(html: string, photos: boolean): string {
  const FIG = /<span class="figure">(<img\b[^>]*>)<span class="img-cap">([\s\S]*?)<\/span><\/span>/g
  if (!photos) {
    return html
      .replace(FIG, '')
      .replace(/<img\b[^>]*>/g, '')
      .replace(/<p>\s*(<br\s*\/?>\s*)*<\/p>\n?/g, '')
  }
  const parts = html.split(FIG)
  // split 带捕获组：[文字, 图, 说明, 文字, 图, 说明, …]
  let out = ''
  for (let i = 0; i < parts.length; i += 3) {
    out += parts[i].replace(/<img\b[^>]*>/g, (tag) => `<span class="fig">${tag}</span>`)
    if (i + 1 < parts.length) out += `<span class="fig">${parts[i + 1]}<span class="cap">${parts[i + 2]}</span></span>`
  }
  return out
}

function metaLine(e: YearbookEntry, lunar?: (d: string) => string): string {
  const m = e.meta
  const parts: string[] = []
  const l = lunar?.(e.date)
  if (l) parts.push(l)
  if (m.weather?.text) parts.push(`${m.weather.text}${m.weather.temp_c != null ? ` ${Math.round(m.weather.temp_c)}°` : ''}`)
  if (m.location?.name) parts.push(m.location.name)
  if (m.mood != null && MOODS[m.mood - 1]) parts.push(`心情${MOODS[m.mood - 1]}`)
  return parts.map(escapeHtml).join(' · ')
}

function moodGrid(year: string, month: number, moods: Record<string, number>): string {
  const first = new Date(Number(year), month - 1, 1)
  const days = new Date(Number(year), month, 0).getDate()
  const lead = (first.getDay() + 6) % 7
  const cells: string[] = []
  for (let i = 0; i < lead; i++) cells.push('<i class="e"></i>')
  for (let d = 1; d <= days; d++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const v = moods[key]
    cells.push(v ? `<i style="background:${MOOD_HEX[v - 1]}"></i>` : '<i></i>')
  }
  return `<div class="grid"><b>一</b><b>二</b><b>三</b><b>四</b><b>五</b><b>六</b><b>日</b>${cells.join('')}</div>`
}

function entryBlock(e: YearbookEntry, input: YearbookInput): string {
  const d = parseYmd(e.date)
  const star = e.meta.starred && !input.starredOnly ? '<span class="star">珍藏</span>' : ''
  const meta = metaLine(e, input.lunar)
  const body = bookImages(e.html, input.photos)
  const zhu = e.annotation ? `<p class="zhu"><span class="zs">批</span>${escapeHtml(e.annotation)}</p>` : ''
  return `<article class="entry">
<h3><span class="n">${d.getMonth() + 1}</span> 月 <span class="n">${d.getDate()}</span> 日<span class="wd">${weekday(e.date)}</span>${star}</h3>
${meta ? `<p class="meta">${meta}</p>` : ''}
<div class="body">${body || '<p class="only">这天只记了心情。</p>'}</div>
${zhu}
</article>`
}

/** 粗估页数（A5）：正文按字数，照片每张算小半页，每月另起一页 */
export function estimatePages(entries: { chars: number; images: number }[], months: number, photos: boolean, summaries: number): number {
  const chars = entries.reduce((n, e) => n + e.chars + 60, 0)
  const images = photos ? entries.reduce((n, e) => n + e.images, 0) : 0
  return Math.max(1, Math.round(2 + chars / 520 + images * 0.45 + months * 0.6 + summaries * 1.2))
}

export function buildYearbook(input: YearbookInput): string {
  const { year, entries } = input
  const byMonth = new Map<number, YearbookEntry[]>()
  for (const e of entries) {
    const m = Number(e.date.slice(5, 7))
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m)!.push(e)
  }
  const first = entries[0]?.date ?? ''
  const last = entries[entries.length - 1]?.date ?? ''
  const dot = (s: string) => s.replace(/-/g, '.')
  const sub = input.starredOnly ? `珍藏的 ${entries.length} 天` : `写了 ${entries.length} 天`

  const months: string[] = []
  for (const [m, list] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
    const mm = String(m).padStart(2, '0')
    const summary = input.monthly?.[mm]
    months.push(`<section class="month">
<header class="mh"><h2>${CN_MONTHS[m - 1]}</h2><p>${year} 年 ${m} 月 · ${input.starredOnly ? '珍藏' : '写了'} ${list.length} 天</p></header>
${moodGrid(year, m, input.moods)}
${summary ? `<div class="summary"><p class="sl">这个月</p>${summary}</div>` : ''}
${list.map((e) => entryBlock(e, input)).join('\n')}
</section>`)
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>浮生记 ${year}</title>
<style>${CSS}</style></head>
<body>
<section class="cover">
  <div class="ct">浮生记</div>
  <div class="cy">${cnYear(year)}</div>
  <div class="seal">记</div>
  <p class="cs">${sub}</p>
  ${first ? `<p class="cr">${dot(first)} — ${dot(last)}</p>` : ''}
</section>
${input.yearly ? `<section class="yearly"><h2>这一年</h2>${input.yearly}</section>` : ''}
${months.join('\n')}
<section class="end"><p>浮生记 · ${dot(input.today)} 排印</p></section>
</body></html>`
}

const CSS = `
@page { size: A5; margin: 17mm 15mm 16mm; @bottom-center { content: counter(page); font: 9pt 'Noto Serif', serif; color: #a89f91; } }
@page :first { @bottom-center { content: none; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #2a2724; font: 10.5pt/1.85 'Noto Serif SC', 'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif; }
.n, .cr, .mh p { font-family: 'Noto Serif', Georgia, serif; }
.kai, .ct, .cy, .seal, .mh h2, .zhu, .yearly h2, .sl { font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'LXGW WenKai', serif; }
.cover { height: 170mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; break-after: page; }
.ct { font-size: 36pt; letter-spacing: 0.3em; margin-right: -0.3em; }
.cy { margin-top: 6mm; font-size: 16pt; letter-spacing: 0.4em; margin-right: -0.4em; color: #6f675d; }
.seal { margin-top: 12mm; width: 15mm; height: 15mm; display: flex; align-items: center; justify-content: center; border-radius: 1.5mm; background: #b5382c; color: #fbf8f2; font-size: 18pt; transform: rotate(-3deg); }
.cs { margin: 12mm 0 0; font-size: 11pt; color: #6f675d; }
.cr { margin: 2mm 0 0; font-size: 9pt; color: #a89f91; letter-spacing: 0.05em; }
.yearly { break-after: page; }
.yearly h2 { font-size: 20pt; font-weight: 400; margin: 0 0 6mm; }
.month { break-before: page; }
.mh { display: flex; align-items: baseline; gap: 4mm; border-bottom: 0.3mm solid #e0d7c6; padding-bottom: 2mm; }
.mh h2 { margin: 0; font-size: 22pt; font-weight: 400; }
.mh p { margin: 0; font-size: 9pt; color: #6f675d; }
.grid { display: grid; grid-template-columns: repeat(7, 5.2mm); gap: 1.2mm; margin: 4mm 0 5mm; font-size: 6.5pt; color: #a89f91; text-align: center; line-height: 1; }
.grid b { font-weight: 400; }
.grid i { display: block; width: 5.2mm; height: 5.2mm; border-radius: 1mm; background: #efe9dd; }
.grid i.e { background: none; }
.summary { margin: 0 0 6mm; padding: 3mm 4mm; border-left: 0.6mm solid #93b1ae; background: #f6f2ea; font-size: 9.5pt; }
.summary h1, .summary h2, .summary h3 { font-size: 10.5pt; margin: 2mm 0 1mm; }
.sl { margin: 0 0 1mm; color: #6f675d; font-size: 10pt; }
.entry { margin: 0 0 7mm; }
.entry h3 { margin: 0; font-size: 12pt; font-weight: 700; break-after: avoid; }
.entry h3 .wd { margin-left: 3mm; font-size: 9.5pt; font-weight: 400; color: #6f675d; }
.star { margin-left: 2mm; padding: 0 1.2mm; border: 0.25mm solid #b5382c; border-radius: 0.8mm; color: #b5382c; font-size: 7.5pt; font-weight: 400; vertical-align: 1pt; }
.meta { margin: 0.5mm 0 2mm; font-size: 8.5pt; color: #a89f91; break-after: avoid; }
.body p { margin: 0 0 2mm; orphans: 2; widows: 2; }
.body h1, .body h2, .body h3, .body h4 { font-size: 10.5pt; margin: 3mm 0 1mm; color: #6f675d; break-after: avoid; }
.body blockquote { margin: 2mm 0; padding-left: 3mm; border-left: 0.5mm solid #e0d7c6; color: #6f675d; }
.body ul, .body ol { margin: 0 0 2mm; padding-left: 5mm; }
.body a { color: inherit; text-decoration: none; }
.body hr { border: 0; border-top: 0.3mm solid #e0d7c6; }
.body code { font-size: 9pt; }
.body table { border-collapse: collapse; font-size: 9pt; }
.body td, .body th { border: 0.25mm solid #e0d7c6; padding: 0.5mm 1.5mm; }
.only { color: #a89f91; }
.fig { display: block; margin: 2mm 0 3mm; text-align: center; break-inside: avoid; }
.fig img { max-width: 100%; max-height: 95mm; border-radius: 1mm; }
.cap { display: block; margin-top: 1mm; font-size: 8.5pt; color: #6f675d; }
.zhu { margin: 2mm 0 0; color: #b5382c; font-size: 11pt; break-inside: avoid; }
.zs { display: inline-block; margin-right: 2mm; padding: 0 0.8mm; border: 0.3mm solid #b5382c; border-radius: 0.6mm; font-size: 8pt; vertical-align: 1.5pt; }
.end { break-before: page; height: 170mm; display: flex; align-items: flex-end; justify-content: center; font-size: 8.5pt; color: #a89f91; }
`

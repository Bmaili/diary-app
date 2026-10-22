/**
 * 年度日记本（2026-10-13 加入，2026-10-14 改成“水墨”版式，规格 5.17）：把一年的日记排成一本 A5 小书的网页，
 * 交给系统打印成 PDF。这里只负责排版（纯函数，有单元测试）；读文件、渲染 Markdown、换图片地址、调打印见 yearbookService.ts。
 *
 * 结构：封面（一年一枝梅、远山、竖排书名）→ 扉页（圆相、题词）→ 这一年（几个数、一月一枝、常去常提起）
 *   → 年度总结（可选）→ 每月：月扉页（淡墨里的月份、两个节气、应季的一句诗、心情小日历、短的月度总结）
 *   → 这个月的日记 → 牌记。
 * 装饰都是 SVG 和 CSS 画的；不内置字体，用手机自带的宋体、楷体。
 */
import { DEFAULT_LIGHT, validColors } from './moodPalette'
import { parseYmd, weekday } from './time'
import { ganzhiYear, monthTerms } from './lunar'
import { POEMS } from './poems'
import type { EntryMeta } from './types'

export interface YearbookEntry {
  date: string
  meta: EntryMeta
  /** 渲染好的正文 HTML（已经过 DOMPurify，图片地址已换好） */
  html: string
  /** 朱批 */
  annotation?: string
}

/** 这一年的几个数（整年，不管只要不要珍藏），由界面层从索引算好传进来，见 yearStats */
export interface YearStats {
  /** 记了的日子（YYYY-MM-DD，正序） */
  days: string[]
  /** 最长连着记了几天 */
  longest: number
  /** 正文字数 */
  chars: number
  /** 照片张数 */
  photos: number
  /** 去得最多的地方、提到最多的人、写得最多的标签（已按次数排好） */
  places: string[]
  people: string[]
  tags: string[]
}

export interface YearbookInput {
  year: string
  entries: YearbookEntry[]
  /** 整年每天的心情（画梅花和心情小日历用；只要珍藏时也画全年的） */
  moods: Record<string, number>
  /** 月度总结 HTML，键是 MM */
  monthly?: Record<string, string>
  /** 年度总结 HTML */
  yearly?: string
  /** 这一年的数（没有时不排“这一年”那页，梅花只画书里这些天） */
  stats?: YearStats
  photos: boolean
  starredOnly: boolean
  /** 农历（可选，界面层传 holidayService 的结果） */
  lunar?: (date: string) => string
  /** 生成日期 YYYY-MM-DD，写在牌记里 */
  today: string
  /** 心情配色（设置里换过的浅色五档；不传或不合法用默认，2026-10-22 加入） */
  moodColors?: string[]
}

const DIG = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const MOODS = ['很差', '不好', '一般', '不错', '很好']
/** 浅色主题的心情色（印在纸上，跟着设置里的心情配色）；记了但没选心情的花用淡墨 */
let MOOD_HEX: string[] = DEFAULT_LIGHT
const NO_MOOD = '#b9b1a4'
const ZHU = '#b5382c'

export const cnYear = (y: string) => [...y].map((d) => DIG[Number(d)] ?? d).join('')

/** 整数的汉字写法：12 → 十二，105 → 一百零五，186000 → 十八万六千 */
export function cnInt(n: number): string {
  n = Math.floor(n)
  if (n === 0) return DIG[0]
  const UNITS = ['', '十', '百', '千']
  const group = (g: number) => {
    let s = ''
    let zero = false
    for (let i = 3; i >= 0; i--) {
      const d = Math.floor(g / 10 ** i) % 10
      if (d === 0) {
        zero = s !== ''
        continue
      }
      if (zero) s += '零'
      zero = false
      s += DIG[d] + UNITS[i]
    }
    return s
  }
  const parts: string[] = []
  const BIG = ['', '万', '亿']
  let rest = n
  let k = 0
  let needZero = false
  while (rest > 0) {
    const g = rest % 10000
    if (g) {
      parts.unshift(group(g) + BIG[k] + (needZero ? '零' : ''))
      needZero = g < 1000
    } else needZero = parts.length > 0
    rest = Math.floor(rest / 10000)
    k++
  }
  let s = parts.join('').replace(/零+$/, '')
  if (/^一十/.test(s)) s = s.slice(1)
  return s
}

/** 字数的说法：不到一千照实写，多了取到百或千：“约十八万六千字” */
export function cnChars(n: number): string {
  if (n < 1000) return `${cnInt(n)}字`
  const step = n < 10000 ? 100 : 1000
  return `约${cnInt(Math.round(n / step) * step)}字`
}

const cnDate = (d: string) => `${cnYear(d.slice(0, 4))}年${cnInt(Number(d.slice(5, 7)))}月${cnInt(Number(d.slice(8, 10)))}日`

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 这一年的几个数。rows 是整年记了的日子（索引行即可），images 是每篇的照片数。
 * 地点、人物、标签各取次数最多的几个（同样多时按先出现的）。
 */
export function yearStats(rows: { date: string; chars: number; images: number; places: string[]; people: string[]; tags: string[] }[]): YearStats {
  const days = rows.map((r) => r.date).sort()
  let longest = 0
  let run = 0
  let prev = 0
  for (const d of days) {
    const t = parseYmd(d).getTime()
    run = prev && Math.round((t - prev) / 86400000) === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = t
  }
  const top = (pick: (r: (typeof rows)[number]) => string[], n: number) => {
    const c = new Map<string, number>()
    for (const r of rows) for (const v of new Set(pick(r))) c.set(v, (c.get(v) ?? 0) + 1)
    return [...c].filter(([, k]) => k > 1 || rows.length < 10).sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v)
  }
  return {
    days,
    longest,
    chars: rows.reduce((n, r) => n + r.chars, 0),
    photos: rows.reduce((n, r) => n + r.images, 0),
    places: top((r) => r.places, 2),
    people: top((r) => r.people, 2),
    tags: top((r) => r.tags, 3),
  }
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

// ---------------- 图形 ----------------

/** 按日期定下来的伪随机数：同一年每次排出来的梅花一样 */
function rng(seed: string) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = (h + 0x6d2b79f5) | 0
    let t = Math.imul(h ^ (h >>> 15), 1 | h)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const f2 = (n: number) => n.toFixed(2)
const colorOf = (mood?: number) => (mood && MOOD_HEX[mood - 1]) || NO_MOOD

/** 一朵五瓣梅 */
function blossom(x: number, y: number, r: number, color: string, rot: number, heart = true): string {
  let p = ''
  for (let k = 0; k < 5; k++) {
    const a = ((k * 72 + rot) * Math.PI) / 180
    p += `<circle cx="${f2(x + Math.cos(a) * r * 0.85)}" cy="${f2(y + Math.sin(a) * r * 0.85)}" r="${f2(r * 0.62)}"/>`
  }
  return `<g fill="${color}" opacity=".9">${p}${heart ? `<circle cx="${f2(x)}" cy="${f2(y)}" r="${f2(r * 0.22)}" fill="#2a2724" opacity=".6"/>` : ''}</g>`
}

/**
 * 封面：一年一枝梅。主枝从左下斜向右上，一月一根小枝，这个月记了的日子在小枝上开一朵，花色是心情，心情越好花越大。
 * 尺寸单位是毫米。
 */
export function yearPlum(year: string, days: string[], moods: Record<string, number>, W = 104, H = 86): string {
  const R = rng(`plum${year}`)
  const P = (t: number): [number, number] => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = [W * 0.04, H * 0.96, W * 0.32, H * 0.62, W * 0.55, H * 0.58, W * 0.97, H * 0.06]
    const u = 1 - t
    return [
      u ** 3 * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3,
      u ** 3 * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3,
    ]
  }
  let branch = ''
  const N = 40
  for (let i = 0; i < N; i++) {
    const [a, b] = P(i / N)
    const [c, d] = P((i + 1) / N)
    branch += `<line x1="${f2(a)}" y1="${f2(b)}" x2="${f2(c)}" y2="${f2(d)}" stroke-width="${f2(2.4 * (1 - (i / N) * 0.8))}"/>`
  }
  const byMonth = new Map<number, string[]>()
  for (const d of days) {
    const m = Number(d.slice(5, 7))
    byMonth.set(m, [...(byMonth.get(m) ?? []), d])
  }
  let flowers = ''
  for (let m = 1; m <= 12; m++) {
    const t = 0.06 + ((m - 0.5) / 12) * 0.9
    const [bx, by] = P(t)
    const side = m % 2 ? -1 : 1
    const ang = -Math.PI / 4 + side * (Math.PI / 2.6) + (R() - 0.5) * 0.3
    const len = W * (0.2 + R() * 0.07) * (1 - t * 0.4)
    const ex = bx + Math.cos(ang) * len
    const ey = by + Math.sin(ang) * len
    const cx = bx + Math.cos(ang - side * 0.35) * len * 0.5
    const cy = by + Math.sin(ang - side * 0.35) * len * 0.5
    branch += `<path d="M${f2(bx)} ${f2(by)} Q${f2(cx)} ${f2(cy)} ${f2(ex)} ${f2(ey)}" stroke-width="${f2(0.6 * (1 - t * 0.4))}"/>`
    const md = byMonth.get(m) ?? []
    const total = new Date(Number(year), m, 0).getDate()
    for (const d of md) {
      const k = (Number(d.slice(8, 10)) - 0.5) / total
      const u = 1 - k
      const px = u * u * bx + 2 * u * k * cx + k * k * ex
      const py = u * u * by + 2 * u * k * cy + k * k * ey
      const off = (R() - 0.5) * 6
      const mood = moods[d]
      flowers += blossom(px + Math.cos(ang + Math.PI / 2) * off, py + Math.sin(ang + Math.PI / 2) * off, 1.05 * (0.75 + (mood || 2) * 0.13), colorOf(mood), R() * 72)
    }
  }
  return `<svg class="plum" viewBox="0 0 ${W} ${H}" width="${W}mm" height="${H}mm" xmlns="http://www.w3.org/2000/svg"><g stroke="#3a332c" stroke-linecap="round" fill="none">${branch}</g>${flowers}</svg>`
}

/** 封面下方的远山 */
const MOUNTAINS = `<svg class="mtn" viewBox="0 0 148 60" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><defs><filter id="mb" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="1.2"/></filter><linearGradient id="m1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d6064" stop-opacity=".45"/><stop offset="1" stop-color="#5d6064" stop-opacity="0"/></linearGradient><linearGradient id="m2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f3236" stop-opacity=".55"/><stop offset="1" stop-color="#2f3236" stop-opacity="0"/></linearGradient></defs><path d="M0 34 C14 26 22 18 34 24 C44 14 54 10 66 20 C78 12 92 16 102 26 C114 20 132 22 148 30 L148 60 L0 60Z" fill="url(#m1)" filter="url(#mb)"/><path d="M0 46 C20 36 34 40 48 44 C62 34 78 32 92 42 C108 38 128 40 148 46 L148 60 L0 60Z" fill="url(#m2)" filter="url(#mb)"/></svg>`

/** 扉页的圆相（和应用图标同一笔） */
const ENSO = `<svg class="enso" viewBox="0 0 432 432" xmlns="http://www.w3.org/2000/svg"><path d="M 292 132 C 330 172 326 252 284 290 C 242 328 160 326 126 278 C 92 230 110 150 172 124 C 206 110 248 112 276 124" fill="none" stroke="#2b2724" stroke-width="14" stroke-linecap="round" opacity=".85"/><path d="M 292 132 C 300 140 306 150 310 160" fill="none" stroke="#2b2724" stroke-width="6" stroke-linecap="round" opacity=".5"/></svg>`

/** 月扉页后面的一团淡墨 */
const WASH = `<svg class="wash" viewBox="0 0 120 110" xmlns="http://www.w3.org/2000/svg"><defs><filter id="wf" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency=".05" numOctaves="3" seed="4"/><feDisplacementMap in="SourceGraphic" scale="9"/><feGaussianBlur stdDeviation="2.2"/></filter><radialGradient id="wr"><stop offset="0" stop-color="#6c6f73" stop-opacity=".3"/><stop offset=".7" stop-color="#6c6f73" stop-opacity=".1"/><stop offset="1" stop-color="#6c6f73" stop-opacity="0"/></radialGradient></defs><ellipse cx="42" cy="44" rx="40" ry="34" fill="url(#wr)" filter="url(#wf)"/></svg>`

/** “这一年”那页：一月一枝，这个月记了的日子开一朵 */
function monthTwig(year: string, m: number, days: string[], moods: Record<string, number>): string {
  const R = rng(`twig${year}${m}`)
  const total = new Date(Number(year), m, 0).getDate()
  let fl = ''
  for (const d of days) {
    const day = Number(d.slice(8, 10))
    const x = 2 + ((day - 1) / 30) * 106
    const y = 3.5 + Math.sin(day * 0.5 + m) * 0.9 + (R() - 0.5) * 1.6
    const mood = moods[d]
    fl += blossom(x, y, 0.55 + (mood || 2) * 0.12, colorOf(mood), R() * 72, false)
  }
  const end = 2 + ((total - 1) / 30) * 106 + 2
  const path = `M0 ${f2(3.6 + Math.sin(m) * 0.6)} C${f2(end * 0.27)} ${2 + (m % 3)} ${f2(end * 0.62)} ${5 - (m % 2) * 2} ${f2(end)} 3.4`
  return `<div class="twig"><b>${cnInt(m)}月</b><svg viewBox="0 0 112 7" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="none" stroke="#3a332c" stroke-width=".35" stroke-linecap="round"/>${fl}</svg></div>`
}

function moodGrid(year: string, month: number, moods: Record<string, number>, written: Set<string>): string {
  const first = new Date(Number(year), month - 1, 1)
  const days = new Date(Number(year), month, 0).getDate()
  const lead = (first.getDay() + 6) % 7
  const cells: string[] = []
  for (let i = 0; i < lead; i++) cells.push('<i class="e"></i>')
  for (let d = 1; d <= days; d++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    const v = moods[key]
    cells.push(v ? `<i style="background:${MOOD_HEX[v - 1]}"></i>` : written.has(key) ? `<i class="w"></i>` : '<i></i>')
  }
  return `<div class="grid"><b>一</b><b>二</b><b>三</b><b>四</b><b>五</b><b>六</b><b>日</b>${cells.join('')}</div>`
}

const legend = () =>
  `<div class="legend">${MOODS.map((w, i) => `<span><i style="background:${MOOD_HEX[i]}"></i>${w}</span>`).join('')}</div>`

/** 这个月应季的一句诗：月里第一个节气的那句 */
function monthPoem(term?: string) {
  const p = (term && POEMS.find((x) => x.tags.includes(term))) || POEMS.find((x) => x.tags.includes('any'))!
  const [a, ...rest] = p.text.split(/(?<=，)/)
  return { cols: rest.length ? [a, rest.join('')] : [a], by: `${p.author}《${p.title}》` }
}

/** 月度总结短的时候放在月扉页上，长了另起，免得把月扉页挤坏 */
const SHORT_SUMMARY = 200
const plainLen = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length

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

function entryBlock(e: YearbookEntry, input: YearbookInput): string {
  const d = parseYmd(e.date)
  const star = e.meta.starred && !input.starredOnly ? '<span class="star" title="珍藏">藏</span>' : ''
  const meta = metaLine(e, input.lunar)
  const body = bookImages(e.html, input.photos)
  const zhu = e.annotation ? `<p class="zhu"><span class="zs">批</span>${escapeHtml(e.annotation)}</p>` : ''
  return `<article class="entry">
<h3><i class="dot"></i>${cnInt(d.getMonth() + 1)}月${cnInt(d.getDate())}日<span class="wd">${weekday(e.date)}</span>${star}</h3>
${meta ? `<p class="meta">${meta}</p>` : ''}
<div class="body">${body || '<p class="only">这天只记了心情。</p>'}</div>
${zhu}
</article>`
}

/** 粗估页数（A5）：正文按字数，照片每张算小半页，每月一页月扉，另有封面、扉页、这一年、牌记 */
export function estimatePages(entries: { chars: number; images: number }[], months: number, photos: boolean, summaries: number): number {
  const chars = entries.reduce((n, e) => n + e.chars + 60, 0)
  const images = photos ? entries.reduce((n, e) => n + e.images, 0) : 0
  return Math.max(1, Math.round(4 + chars / 520 + images * 0.45 + months * 1.3 + summaries * 0.5))
}

export function buildYearbook(input: YearbookInput): string {
  const { year, entries } = input
  MOOD_HEX = validColors(input.moodColors) ? input.moodColors : DEFAULT_LIGHT
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
  const st = input.stats
  // 梅花、心情小日历画整年记了的日子（只要珍藏时也是），没有统计时退回书里这些天
  const allDays = st?.days ?? entries.map((e) => e.date)
  const written = new Set(allDays)

  const months: string[] = []
  for (const [m, list] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
    const mm = String(m).padStart(2, '0')
    const summary = input.monthly?.[mm]
    const terms = monthTerms(Number(year), m)
    const poem = monthPoem(terms[0]?.name)
    const short = summary && plainLen(summary) <= SHORT_SUMMARY
    const name = cnInt(m)
    months.push(`<section class="month">
<div class="opener">
${WASH}
<div class="mn kai${name.length > 1 ? ' two' : ''}">${name}<span class="yue">月</span></div>
<div class="poem kai">${poem.cols.map((c) => `<span>${escapeHtml(c)}</span>`).join('')}<small>${escapeHtml(poem.by)}</small></div>
<div class="lower">
${terms.length ? `<p class="terms">${terms.map((t) => `<em>${t.name}</em>${name}月${cnInt(t.day)}日`).join('　')}</p>` : ''}
<div class="mrow">
<div>${moodGrid(year, m, input.moods, written)}<p class="cnt">${input.starredOnly ? '珍藏' : '写了'} <span class="n">${list.length}</span> 天</p></div>
${short ? `<div class="msum">${summary}</div>` : ''}
</div>
</div>
</div>
${summary && !short ? `<div class="summary"><p class="sl">这个月</p>${summary}</div>` : ''}
${list.map((e) => entryBlock(e, input)).join('\n')}
</section>`)
  }

  const most = st
    ? [
        st.places.length ? `常去${st.places.map(escapeHtml).join('、')}` : '',
        st.people.length ? `常提起${st.people.map(escapeHtml).join('、')}` : '',
        st.tags.length ? `常写${st.tags.map(escapeHtml).join('、')}` : '',
      ].filter(Boolean).join('；')
    : ''
  const wan = (n: number) => (n >= 10000 ? `<b>${(n / 10000).toFixed(1).replace(/\.0$/, '')}</b>万字` : `<b>${n}</b>字`)
  const statsPage = st && st.days.length
    ? `<section class="stats">
<h2 class="kai">这一年</h2>
<p class="lead">写了<b>${st.days.length}</b>天，最长一次连着写了<b>${st.longest}</b>天，<br>一共写下${wan(st.chars)}${st.photos ? `，存了<b>${st.photos}</b>张照片` : ''}。</p>
<div class="twigs">${Array.from({ length: 12 }, (_, i) => monthTwig(year, i + 1, st.days.filter((d) => Number(d.slice(5, 7)) === i + 1), input.moods)).join('')}</div>
${legend()}
${most ? `<p class="most">${most}。</p>` : ''}
</section>`
    : ''

  const bookChars = entries.reduce((n, e) => n + plainLen(e.html), 0)

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>浮生记 ${year}</title>
<style>${CSS}</style></head>
<body>
<section class="cover">
  ${MOUNTAINS}
  ${yearPlum(year, allDays, input.moods)}
  <div class="title kai"><span class="t">浮生记</span><span class="y">${cnYear(year)}</span></div>
  <span class="seal kai">记</span>
  <p class="cs">${sub}${first ? `<br><span class="cr">${dot(first)} — ${dot(last)}</span>` : ''}</p>
</section>
<section class="epi kai">${ENSO}<p class="q">浮生若梦，为欢几何。</p><p class="by">李白《春夜宴从弟桃花园序》</p></section>
${statsPage}
${input.yearly ? `<section class="yearly"><h2 class="kai">岁末回望</h2>${input.yearly}</section>` : ''}
${months.join('\n')}
<section class="pai">
  <svg class="bloom" viewBox="-10 -10 20 20" xmlns="http://www.w3.org/2000/svg">${[0, 1, 2, 3, 4].map((k) => {
    const a = ((k * 72 - 90) * Math.PI) / 180
    return `<circle cx="${f2(Math.cos(a) * 5)}" cy="${f2(Math.sin(a) * 5)}" r="3.8" fill="${ZHU}" opacity=".88"/>`
  }).join('')}<circle r="1.3" fill="#2a2724" opacity=".6"/></svg>
  <p><b>浮生记</b>${cnYear(year)} · 岁次${ganzhiYear(Number(year))}<br>凡${cnInt(entries.length)}篇　${cnChars(bookChars)}<br>${cnDate(input.today)}排印</p>
</section>
</body></html>`
}

const KAI = `'Kaiti SC', 'STKaiti', 'KaiTi', 'LXGW WenKai', serif`
const CSS = `
@page { size: A5; margin: 17mm 15mm 16mm; background: #faf6ee; @bottom-center { content: counter(page); font: 8.5pt 'Noto Serif', serif; color: #a89f91; } }
@page bare { margin: 0; @bottom-center { content: none; } }
@page :first { @bottom-center { content: none; } }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #faf6ee; }
body { margin: 0; color: #2a2724; font: 10.5pt/1.85 'Noto Serif SC', 'Noto Serif CJK SC', 'Source Han Serif SC', 'Songti SC', 'STSong', serif; }
.n, .cr, .lead b, .cnt .n { font-family: 'Noto Serif', Georgia, serif; }
.kai, .zhu, .sl, .cap { font-family: ${KAI}; }
.seal { display: flex; align-items: center; justify-content: center; border-radius: 1.2mm; background: ${ZHU}; color: #fbf8f2; line-height: 1; transform: rotate(-4deg); }

/* 封面：整页出血 */
.cover { page: bare; position: relative; width: 148mm; height: 210mm; overflow: hidden; break-after: page; }
.cover .mtn { position: absolute; left: 0; bottom: 0; width: 148mm; height: 60mm; }
.cover .plum { position: absolute; left: 7mm; top: 60mm; }
.cover .title { position: absolute; right: 18mm; top: 20mm; writing-mode: vertical-rl; display: flex; align-items: flex-start; gap: 3mm; }
.cover .title .t { font-size: 32pt; letter-spacing: .3em; line-height: 1; }
.cover .title .y { font-size: 10pt; letter-spacing: .3em; color: #6f675d; margin-top: 10mm; }
.cover .seal { position: absolute; right: 19mm; top: 108mm; width: 9mm; height: 9mm; font-size: 11pt; }
.cover .cs { position: absolute; right: 18mm; bottom: 12mm; margin: 0; text-align: right; font-size: 8.5pt; line-height: 1.7; color: #4a443d; letter-spacing: .05em; }
.cover .cr { font-size: 7.5pt; color: #6f675d; }

/* 扉页 */
.epi { page: bare; height: 210mm; padding-top: 50mm; text-align: center; break-after: page; }
.epi .enso { display: block; width: 70mm; height: 70mm; margin: 0 auto; }
.epi .q { margin: 12mm 0 0; font-size: 14pt; letter-spacing: .2em; }
.epi .by { margin: 3mm 0 0; font-size: 8.5pt; color: #a89f91; }

/* 这一年 */
.stats { break-after: page; }
.stats h2 { margin: 0; font-size: 20pt; font-weight: 400; letter-spacing: .3em; }
.lead { margin: 2mm 0 7mm; font-size: 9.5pt; color: #6f675d; line-height: 2; }
.lead b { font-weight: 400; font-size: 15pt; color: #2a2724; margin: 0 .8mm; }
.twigs { display: grid; gap: .6mm; margin-bottom: 3mm; }
.twig { display: grid; grid-template-columns: 9mm 1fr; align-items: center; }
.twig b { font-weight: 400; font-size: 7.5pt; color: #a89f91; }
.twig svg { width: 109mm; height: 7mm; }
.legend { display: flex; gap: 3mm; font-size: 7pt; color: #a89f91; }
.legend i { display: inline-block; width: 2.4mm; height: 2.4mm; border-radius: .4mm; margin-right: .8mm; vertical-align: -.2mm; }
.most { margin: 6mm 0 0; font-size: 9pt; color: #4a443d; line-height: 2; }

.yearly { break-after: page; }
.yearly h2 { font-size: 16pt; font-weight: 400; letter-spacing: .15em; margin: 0 0 6mm; }

/* 月扉页 */
.month { break-before: page; }
.opener { position: relative; height: 176mm; break-after: page; overflow: hidden; }
.opener .wash { position: absolute; left: -9mm; top: -3mm; width: 120mm; height: 110mm; }
.opener .mn { position: absolute; left: 7mm; top: 13mm; font-size: 70pt; line-height: 1; white-space: nowrap; }
.opener .mn.two { font-size: 58pt; }
.opener .yue { font-size: 20pt; margin-left: 1mm; }
.opener .poem { position: absolute; right: 1mm; top: 5mm; writing-mode: vertical-rl; display: flex; flex-direction: column; gap: 2.5mm; font-size: 12pt; letter-spacing: .2em; line-height: 1.6; max-height: 100mm; }
.opener .poem small { font-size: 8pt; color: #a89f91; padding-top: 6mm; letter-spacing: 0; }
.opener .lower { position: absolute; left: 0; right: 0; top: 91mm; }
.terms { margin: 0 0 4mm; font-size: 9.5pt; color: #4a443d; }
.terms em { font-style: normal; color: ${ZHU}; margin-right: 1.5mm; }
.mrow { display: flex; gap: 7mm; align-items: flex-start; }
.grid { display: grid; grid-template-columns: repeat(7, 5mm); gap: 1.1mm; font-size: 6.5pt; color: #a89f91; text-align: center; line-height: 1; }
.grid b { font-weight: 400; }
.grid i { display: block; width: 5mm; height: 5mm; border-radius: .8mm; background: #ece5d8; }
.grid i.w { background: ${NO_MOOD}; }
.grid i.e { background: none; }
.cnt { margin: 2mm 0 0; font-size: 8pt; color: #a89f91; }
.msum { flex: 1; font-size: 8.5pt; line-height: 1.85; color: #4a443d; }
.msum p, .summary p { margin: 0 0 1.5mm; }
.msum h1, .msum h2, .msum h3, .summary h1, .summary h2, .summary h3 { font-size: 9.5pt; margin: 1.5mm 0 .5mm; }
.summary { margin: 0 0 7mm; padding: 3mm 4mm; border-left: .6mm solid #93b1ae; background: #f3eee3; font-size: 9.5pt; }
.sl { margin: 0 0 1mm; color: #6f675d; font-size: 10pt; }

/* 日记 */
.entry { margin: 0 0 7mm; }
.entry h3 { display: flex; align-items: baseline; margin: 0; font-size: 12pt; font-weight: 700; break-after: avoid; }
.entry .dot { flex: none; width: 2.2mm; height: 2.2mm; border-radius: 50%; margin-right: 2mm; background: radial-gradient(circle, #2a2724 30%, rgba(42,39,36,.35) 60%, transparent 72%); transform: translateY(-.6mm); }
.entry h3 .wd { margin-left: 3mm; font-size: 9.5pt; font-weight: 400; color: #6f675d; }
.star { margin-left: 2mm; display: inline-flex; align-items: center; justify-content: center; width: 4.6mm; height: 4.6mm; border-radius: .6mm; background: ${ZHU}; color: #fbf8f2; font: 400 7pt/1 ${KAI}; transform: rotate(-3deg); }
.meta { margin: .5mm 0 2mm; font-size: 8.5pt; color: #a89f91; break-after: avoid; }
.body p { margin: 0 0 2mm; text-align: justify; orphans: 2; widows: 2; }
.body h1, .body h2, .body h3, .body h4 { font: 9pt 'Noto Serif', serif; margin: 2.5mm 0 .5mm; color: #a89f91; break-after: avoid; }
.body blockquote { margin: 2mm 0; padding-left: 3mm; border-left: .5mm solid #e0d7c6; color: #6f675d; }
.body ul, .body ol { margin: 0 0 2mm; padding-left: 5mm; }
.body a { color: inherit; text-decoration: none; }
.body hr { border: 0; border-top: .3mm solid #e0d7c6; }
.body code { font-size: 9pt; }
.body table { border-collapse: collapse; font-size: 9pt; }
.body td, .body th { border: .25mm solid #e0d7c6; padding: .5mm 1.5mm; }
.only { color: #a89f91; }
.fig { display: block; margin: 2.5mm 0 3mm; text-align: center; break-inside: avoid; }
.fig img { max-width: 100%; max-height: 95mm; -webkit-mask-image: radial-gradient(ellipse 72% 70% at 50% 50%, #000 62%, transparent 100%); mask-image: radial-gradient(ellipse 72% 70% at 50% 50%, #000 62%, transparent 100%); }
.cap { display: block; margin-top: 1mm; font-size: 9pt; color: #6f675d; }
.zhu { margin: 2mm 0 0; color: ${ZHU}; font-size: 11pt; break-inside: avoid; }
.zs { display: inline-block; margin-right: 2mm; padding: 0 .8mm; border: .3mm solid ${ZHU}; border-radius: .6mm; font-size: 8pt; line-height: 1.5; vertical-align: 1.5pt; }

/* 牌记 */
/* 牌记用普通页：书末从普通页换到无边距的页时，Chromium 会多插一张空白页 */
.pai { height: 170mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; break-before: page; }
.pai .bloom { width: 14mm; height: 14mm; }
.pai p { margin: 6mm 0 0; font-size: 9pt; line-height: 2.2; color: #6f675d; letter-spacing: .1em; }
.pai p b { display: block; font-weight: 400; font-size: 14pt; color: #2a2724; letter-spacing: .4em; margin-right: -.4em; font-family: ${KAI}; }
`

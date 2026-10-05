/**
 * 中国大陆法定节假日（2026-10-05 起可联网更新）。
 * 内置数据来自 lunar-javascript，只到它发布时已公布的年份；联网数据来自开源项目 holiday-cn
 * （NateScarlet/holiday-cn，从国务院办公厅通知自动抓取，每年 11 月前后更新次年）。
 * 某一年有联网数据时以联网为准（包括“这天不放假”），没有时用内置的。
 */
import { HolidayUtil } from 'lunar-javascript'

export interface HolidayDay {
  date: string
  /** 元旦、春节、国庆、国庆中秋 */
  name: string
  /** true 放假，false 调休上班 */
  off: boolean
}

export interface HolidayInfo {
  name: string
  off: boolean
  /** 这一段假期的第一天 */
  first: boolean
}

/** 国庆节、中秋节 → 国庆中秋；劳动节 → 劳动；春节保持不变 */
export function shortHolidayName(n: string): string {
  return n
    .split(/[、,，/\s]+/)
    .filter(Boolean)
    .map((p) => (p.length > 2 ? p.replace(/节$/, '') : p))
    .join('')
}

/** holiday-cn 的年度文件：{ year, days: [{ name, date, isOffDay }] }。格式不对就抛错，不用坏数据 */
export function parseHolidayCn(json: unknown, year: number): HolidayDay[] {
  const j = json as { year?: unknown; days?: unknown }
  if (!j || typeof j !== 'object' || Number(j.year) !== year || !Array.isArray(j.days)) throw new Error(`${year} 年节假日数据格式不对`)
  const out: HolidayDay[] = []
  for (const d of j.days as { name?: unknown; date?: unknown; isOffDay?: unknown }[]) {
    if (typeof d?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || typeof d.name !== 'string' || typeof d.isOffDay !== 'boolean') {
      throw new Error(`${year} 年节假日数据格式不对`)
    }
    out.push({ date: d.date, name: shortHolidayName(d.name), off: d.isOffDay })
  }
  return out
}

/** 已加载的联网年份 → 文件内容 */
const online = new Map<number, HolidayDay[]>()
let byDate = new Map<string, HolidayDay>()
let revision = 0

function rebuild() {
  byDate = new Map()
  for (const days of online.values()) for (const d of days) byDate.set(d.date, d)
  revision++
}

/** 换成联网数据（一年一份）；传空对象等于全部改回内置 */
export function setOnlineHolidays(years: Record<number, HolidayDay[]>) {
  online.clear()
  for (const [y, days] of Object.entries(years)) online.set(Number(y), days)
  rebuild()
}

/** 联网数据每变一次加一，供农历缓存判断是否要重算 */
export function holidayRevision(): number {
  return revision
}

function prevDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d - 1))
  return t.toISOString().slice(0, 10)
}

export function holidayOn(date: string): HolidayInfo | undefined {
  const year = Number(date.slice(0, 4))
  if (online.has(year)) {
    const h = byDate.get(date)
    if (!h) return undefined
    const p = byDate.get(prevDay(date))
    return { name: h.name, off: h.off, first: h.off && !(p && p.off && p.name === h.name) }
  }
  const h = HolidayUtil.getHoliday(date)
  if (!h) return undefined
  return { name: shortHolidayName(h.getName()), off: !h.isWork(), first: !h.isWork() && h.getTarget() === date }
}

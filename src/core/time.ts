/** 日期与时间工具。所有计算都基于设备本地时区。 */

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0')

/** 本地日期 YYYY-MM-DD */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 日记归属日期（规格 4.4 第 4 条）：在 cutoffHour 点之前写的，算前一天。
 * cutoffHour 默认 4，即凌晨 4:00 切换。
 */
export function diaryDate(now: Date, cutoffHour = 4): string {
  const d = new Date(now.getTime())
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1)
  return ymd(d)
}

/** 带本地时区偏移的 ISO 8601，例如 2026-09-30T21:14:03+08:00 */
export function isoLocal(d: Date): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return (
    `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  )
}

export function hhmm(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 'YYYY-MM-DD' 解析为本地午夜的 Date */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export function weekday(s: string): string {
  return WEEK[parseYmd(s).getDay()]
}

export function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = parseYmd(s)
  return ymd(d) === s
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s)
  d.setDate(d.getDate() + n)
  return ymd(d)
}

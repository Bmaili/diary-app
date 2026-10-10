/**
 * 写日记提醒的排程（纯函数，便于测试）。
 * 不用“每天重复”的通知，而是预排未来 N 天的一次性通知：这样能跳过已经写过的日子，每条还能带上当天的农历和节气。
 * app 每次启动、回到前台、保存日记、改设置时都会重排，所以 N 天内总会打开一次就够了。
 */
import { addDays } from './time'
import { lunarDay } from './lunar'
import { pickHint } from './hints'

export const REMINDER_BASE_ID = 7000
export const REMINDER_DAYS = 14

export interface PlannedReminder {
  id: number
  date: string
  at: Date
  title: string
  body: string
}

/**
 * 通知正文：先说今天是什么日子，再接一句（句库见 hints.ts）。
 * 那一句本身点明了节日、节气或交节时刻时，不再加前缀，免得“今天寒露。寒露，……”重复。
 * 通知会显示在锁屏上，所以不引用日记内容。
 * @param at 通知发出的时刻：“灯下”“月色”这类句子只在夜里的提醒里出现；不传按当天 22:00
 */
export function reminderText(date: string, at?: Date, cutoffHour = 4): { title: string; body: string } {
  const l = lunarDay(date)
  const [y, m, d] = date.split('-').map(Number)
  const now = at ?? new Date(y, m - 1, d, 22, 0, 0)
  const h = pickHint({ date, now, cutoffHour, forNotice: true })
  const day = l.festival ? `今天${l.festival}` : l.jieqi ? `今天${l.jieqi}` : `今天${l.full}`
  return { title: '写一句今天的日记', body: h.namesDay ? h.text : `${day}。${h.text}` }
}

/**
 * @param today 当前的日记日期（已按“一天从几点开始”换算）
 * @param time 提醒时刻 HH:mm；早于 cutoffHour 的时刻算作前一个日记日的深夜
 */
export function planReminders(opts: {
  now: Date
  today: string
  time: string
  cutoffHour: number
  written: (date: string) => boolean
  skipWritten: boolean
  days?: number
}): PlannedReminder[] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(opts.time)
  if (!m) return []
  const hh = Number(m[1])
  const mm = Number(m[2])
  const out: PlannedReminder[] = []
  const days = opts.days ?? REMINDER_DAYS
  for (let i = 0; i < days; i++) {
    const date = addDays(opts.today, i)
    if (opts.skipWritten && opts.written(date)) continue
    const [y, mo, d] = date.split('-').map(Number)
    const at = new Date(y, mo - 1, d + (hh < opts.cutoffHour ? 1 : 0), hh, mm, 0, 0)
    if (at.getTime() <= opts.now.getTime() + 30_000) continue
    out.push({ id: REMINDER_BASE_ID + i, date, at, ...reminderText(date, at, opts.cutoffHour) })
  }
  return out
}

/**
 * 写日记提醒的排程（纯函数，便于测试）。
 * 不用“每天重复”的通知，而是预排未来 N 天的一次性通知：这样能跳过已经写过的日子，每条还能带上当天的农历和节气。
 * app 每次启动、回到前台、保存日记、改设置时都会重排，所以 N 天内总会打开一次就够了。
 */
import { addDays } from './time'
import { lunarDay } from './lunar'

export const REMINDER_BASE_ID = 7000
export const REMINDER_DAYS = 14

export interface PlannedReminder {
  id: number
  date: string
  at: Date
  title: string
  body: string
}

export const LINES = [
  '哪怕一句话，也是今天的一页。',
  '给今天落一笔。',
  '今日之事，今日记之。',
  '片言只语，也是光阴。',
  '一句话就够，纸不嫌短。',
  '片言只语，皆是浮生。',
  '浮生如寄，字有归处。',
  '浮生非梦，字字为凭。',
  '浮生几何，一笔一记。',
  '浮生琐碎，皆可成章。',
  '浮生有痕，一页一记。',
]

export function reminderText(date: string): { title: string; body: string } {
  const l = lunarDay(date)
  // 按日期打散：每天固定一句（重排通知时不会变），相邻几天又不按顺序轮换
  let h = 2166136261
  for (const c of date) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  const line = LINES[(h >>> 0) % LINES.length]
  const day = l.festival ? `今天${l.festival}` : l.jieqi ? `今天${l.jieqi}` : `今天${l.full}`
  return { title: '写一句今天的日记', body: `${day}。${line}` }
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
    out.push({ id: REMINDER_BASE_ID + i, date, at, ...reminderText(date) })
  }
  return out
}

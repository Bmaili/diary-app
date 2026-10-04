/**
 * 写日记提醒的排程（纯函数，便于测试）。
 * 不用“每天重复”的通知，而是预排未来 N 天的一次性通知：这样能跳过已经写过的日子，每条还能带上当天的月相。
 * app 每次启动、回到前台、保存日记、改设置时都会重排，所以 N 天内总会打开一次就够了。
 */
import { addDays } from './time'
import { moonOnDate } from './astro'

export const REMINDER_BASE_ID = 7000
export const REMINDER_DAYS = 14

export interface PlannedReminder {
  id: number
  date: string
  at: Date
  title: string
  body: string
}

const LINES = [
  '哪怕一句话，也是一条观测记录。',
  '给今天留一个坐标。',
  '今天的信号还没有落地。',
  '记下一点今天的光。',
  '一句话就够，宇宙不嫌短。',
]

export function reminderText(date: string): { title: string; body: string } {
  const moon = moonOnDate(date)
  const n = Number(date.replace(/-/g, ''))
  const line = LINES[n % LINES.length]
  let sky = `今晚${moon.name}`
  if (moon.name === '满月') sky = '今晚满月，适合抬头看看'
  else if (moon.name === '新月') sky = '今晚新月，天晴的话星星会很多'
  return { title: '写一句今天的日记', body: `${sky}。${line}` }
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

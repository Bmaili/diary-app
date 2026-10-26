/**
 * 每日清单（2026-10-26 加入，SPEC 5.2）：设置里列好每天照例要做的事，新的一天第一次打开编辑时预填成待办。
 *
 * - 清单存在设置里（prefs.write.checklist），日记里只是普通的 `- [ ] …`，文件格式不变。
 * - 每一项可以选在哪些天出现：每天、工作日、休息日，或者指定星期几。
 *   工作日 / 休息日按法定节假日和调休算（放假的周一是休息日，调休上班的周六是工作日）。
 * - 星期按日记日期算（凌晨切换时刻之前算前一天）。
 */
import { parseYmd } from './time'
import type { HolidayInfo } from './holidays'

export type ChecklistWhen = 'daily' | 'workday' | 'restday' | 'weekly'

export interface ChecklistItem {
  text: string
  when: ChecklistWhen
  /** when 为 weekly 时：出现在星期几，0 是周日、1 是周一 … 6 是周六 */
  weekdays?: number[]
}

/** 周一排在前面 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const WEEK_NAMES = ['日', '一', '二', '三', '四', '五', '六']

/** 这一天是不是工作日：法定节假日放假的不是，调休上班的是，其余看周一到周五 */
export function isWorkday(date: string, holidayOn: (d: string) => HolidayInfo | undefined): boolean {
  const h = holidayOn(date)
  if (h) return !h.off
  const w = parseYmd(date).getDay()
  return w >= 1 && w <= 5
}

export function appliesOn(item: ChecklistItem, date: string, holidayOn: (d: string) => HolidayInfo | undefined): boolean {
  switch (item.when) {
    case 'daily': return true
    case 'workday': return isWorkday(date, holidayOn)
    case 'restday': return !isWorkday(date, holidayOn)
    case 'weekly': return (item.weekdays ?? []).includes(parseYmd(date).getDay())
    default: return true
  }
}

/** 这一天要预填的事（空的、只有空白的不算），按清单里的顺序 */
export function itemsFor(items: ChecklistItem[], date: string, holidayOn: (d: string) => HolidayInfo | undefined): string[] {
  return items
    .filter((i) => i && typeof i.text === 'string')
    .map((i) => ({ ...i, text: oneLine(i.text) }))
    .filter((i) => i.text && appliesOn(i, date, holidayOn))
    .map((i) => i.text)
}

/** 预填进正文的写法：一行一项，后面空一行 */
export function checklistMarkdown(texts: string[]): string {
  return texts.length ? `${texts.map((t) => `- [ ] ${t}`).join('\n')}\n\n` : ''
}

/** 一项只能是一行：去掉换行和首尾空白 */
export function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/** 设置列表里每一项右边的说法：每天、工作日、休息日、周一、周四…… */
export function whenLabel(item: ChecklistItem): string {
  switch (item.when) {
    case 'daily': return '每天'
    case 'workday': return '工作日'
    case 'restday': return '休息日'
    case 'weekly': {
      const days = WEEK_ORDER.filter((d) => item.weekdays?.includes(d))
      if (!days.length) return '不出现'
      if (days.length === 7) return '每天'
      return days.map((d) => `周${WEEK_NAMES[d]}`).join('、')
    }
    default: return '每天'
  }
}

export function weekName(d: number): string {
  return WEEK_NAMES[d]
}

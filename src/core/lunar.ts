/**
 * 农历、节气、传统节日（2026-10-05 加入，替换原来的月相）。底层用 lunar-javascript（MIT，离线计算）。
 */
import { HolidayUtil, Solar } from 'lunar-javascript'

export interface LunarDay {
  /** 正月、八月、闰四月、冬月、腊月 */
  month: string
  /** 初一、十五、廿八 */
  day: string
  /** 今天正好是某个节气时的名字 */
  jieqi?: string
  /** 今天的传统节日（只收常见的几个） */
  festival?: string
  /**
   * 中国大陆法定节假日（国务院每年公布的放假安排）：off 为放假，否则是调休上班。
   * 数据来自 lunar-javascript，覆盖到它发布时已公布的年份（目前到 2026 年）。
   */
  holiday?: { name: string; off: boolean; first: boolean }
  /** 今天所在的节气时段（最近一个已开始的节气） */
  term: string
  /** 日历格子里显示的短字：节日 > 节气 > 初一显示月份 > 日 */
  cell: string
  /** 农历八月廿五 */
  full: string
  /** 丙午马年 */
  year: string
}

const FESTIVALS: Record<string, string> = {
  春节: '春节', 元宵节: '元宵', 端午节: '端午', 七夕节: '七夕', 中秋节: '中秋', 重阳节: '重阳', 除夕: '除夕', 腊八节: '腊八',
}

/** 元旦节 → 元旦，国庆中秋 → 国庆中秋 */
function shortHoliday(n: string): string {
  return n.replace(/节$/, '')
}

const cache = new Map<string, LunarDay>()

export function lunarDay(date: string): LunarDay {
  const hit = cache.get(date)
  if (hit) return hit
  const [y, m, d] = date.split('-').map(Number)
  const l = Solar.fromYmd(y, m, d).getLunar()
  let month = l.getMonthInChinese()
  if (l.getMonth() < 0 && !month.startsWith('闰')) month = `闰${month}`
  month += '月'
  const day = l.getDayInChinese()
  const jieqi = l.getJieQi() || undefined
  const fest = l.getFestivals().map((f) => FESTIVALS[f]).find(Boolean)
  const h = HolidayUtil.getHoliday(date)
  const holiday = h ? { name: shortHoliday(h.getName()), off: !h.isWork(), first: !h.isWork() && h.getTarget() === date } : undefined
  const info: LunarDay = {
    month,
    day,
    ...(jieqi ? { jieqi } : {}),
    ...(fest ? { festival: fest } : {}),
    ...(holiday ? { holiday } : {}),
    term: jieqi ?? l.getPrevJieQi(true).getName(),
    // 法定假日（元旦、劳动节、国庆）当天也写名字
    cell: fest ?? (holiday?.first && !jieqi ? holiday.name : undefined) ?? jieqi ?? (day === '初一' ? month : day),
    full: `农历${month}${day}`,
    year: `${l.getYearInGanZhi()}${l.getYearShengXiao()}年`,
  }
  cache.set(date, info)
  return info
}

const ORDER = ['立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满', '芒种', '夏至', '小暑', '大暑',
  '立秋', '处暑', '白露', '秋分', '寒露', '霜降', '立冬', '小雪', '大雪', '冬至', '小寒', '大寒']

export type Season = 'spring' | 'summer' | 'autumn' | 'winter'
/** 按节气分四季：立春到谷雨是春，以此类推 */
export function seasonOf(term: string): Season {
  const i = Math.max(0, ORDER.indexOf(term))
  return (['spring', 'summer', 'autumn', 'winter'] as const)[Math.floor(i / 6)]
}

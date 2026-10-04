/**
 * 月相：用平均朔望月从一个已知新月推算。误差在半天以内，用于界面展示足够。
 * 参考新月：2000-01-06 18:14 UTC。
 */
const SYNODIC = 29.530588853
const REF_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14)

export interface MoonPhase {
  /** 月龄，天，0 为新月 */
  age: number
  /** 相位 0–1，0 新月，0.5 满月 */
  phase: number
  /** 被照亮的比例 0–1 */
  illumination: number
  name: string
}

const NAMES = ['新月', '蛾眉月', '上弦月', '盈凸月', '满月', '亏凸月', '下弦月', '残月']

export function moonPhase(at: Date): MoonPhase {
  const days = (at.getTime() - REF_NEW_MOON) / 86400000
  const age = ((days % SYNODIC) + SYNODIC) % SYNODIC
  const phase = age / SYNODIC
  const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2
  const name = NAMES[Math.floor(phase * 8 + 0.5) % 8]
  return { age, phase, illumination, name }
}

/** 某个日记日期当晚 21 点的月相 */
export function moonOnDate(date: string): MoonPhase {
  const [y, m, d] = date.split('-').map(Number)
  return moonPhase(new Date(y, m - 1, d, 21, 0))
}

/** 两个日期之间相差的天数（b - a） */
export function daysBetween(a: string, b: string): number {
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000)
}

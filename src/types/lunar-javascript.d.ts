/** lunar-javascript 没有自带类型，这里只声明用到的部分 */
declare module 'lunar-javascript' {
  export class JieQi {
    getName(): string
    getSolar(): Solar
  }
  export class Lunar {
    getMonth(): number
    getMonthInChinese(): string
    getDayInChinese(): string
    getJieQi(): string
    getFestivals(): string[]
    getPrevJieQi(wholeDay?: boolean): JieQi
    getYearInGanZhi(): string
    getYearShengXiao(): string
    getNextJieQi(wholeDay?: boolean): JieQi
    /** 例如 '寒露 三候' */
    getHou(): string
    /** 物候，例如 '菊有黄花' */
    getWuHou(): string
  }
  export class Holiday {
    getName(): string
    isWork(): boolean
    getTarget(): string
  }
  export const HolidayUtil: { getHoliday(ymd: string): Holiday | null }
  export class Solar {
    static fromYmd(y: number, m: number, d: number): Solar
    static fromYmdHms(y: number, m: number, d: number, h: number, mi: number, s: number): Solar
    getLunar(): Lunar
    toYmd(): string
    getYear(): number
    getMonth(): number
    getDay(): number
    getHour(): number
    getMinute(): number
    getSecond(): number
  }
}

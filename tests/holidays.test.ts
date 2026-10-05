import { afterEach, describe, expect, it } from 'vitest'
import { holidayOn, parseHolidayCn, setOnlineHolidays, shortHolidayName } from '../src/core/holidays'
import { lunarDay } from '../src/core/lunar'

afterEach(() => setOnlineHolidays({}))

const file2027 = {
  year: 2027,
  papers: ['https://www.gov.cn/'],
  days: [
    { name: '元旦', date: '2027-01-01', isOffDay: true },
    { name: '春节', date: '2027-02-05', isOffDay: true },
    { name: '春节', date: '2027-02-06', isOffDay: true },
    { name: '春节', date: '2027-02-07', isOffDay: false },
    { name: '国庆节、中秋节', date: '2027-10-01', isOffDay: true },
  ],
}

describe('法定节假日', () => {
  it('名字缩短', () => {
    expect(shortHolidayName('国庆节、中秋节')).toBe('国庆中秋')
    expect(shortHolidayName('劳动节')).toBe('劳动')
    expect(shortHolidayName('元旦')).toBe('元旦')
    expect(shortHolidayName('春节')).toBe('春节')
  })

  it('解析 holiday-cn 的年度文件，格式不对时报错', () => {
    const days = parseHolidayCn(file2027, 2027)
    expect(days).toHaveLength(5)
    expect(days[4]).toEqual({ date: '2027-10-01', name: '国庆中秋', off: true })
    expect(() => parseHolidayCn(file2027, 2028)).toThrow('格式不对')
    expect(() => parseHolidayCn({ year: 2027, days: [{ date: '2027-1-1', name: 'x', isOffDay: true }] }, 2027)).toThrow('格式不对')
    expect(() => parseHolidayCn('<html>', 2027)).toThrow('格式不对')
  })

  it('有联网数据的年份以联网为准，第一天和调休都算对', () => {
    expect(holidayOn('2027-02-05')).toBeUndefined() // 内置数据只到 2026
    setOnlineHolidays({ 2027: parseHolidayCn(file2027, 2027) })
    expect(holidayOn('2027-02-05')).toEqual({ name: '春节', off: true, first: true })
    expect(holidayOn('2027-02-06')).toEqual({ name: '春节', off: true, first: false })
    expect(holidayOn('2027-02-07')).toEqual({ name: '春节', off: false, first: false })
    expect(holidayOn('2027-03-01')).toBeUndefined()
    // 没有联网数据的年份仍用内置
    expect(holidayOn('2026-10-01')).toEqual({ name: '国庆', off: true, first: true })
  })

  it('联网数据会覆盖内置的同一年（包括“这天不放假”）', () => {
    expect(holidayOn('2026-10-01')?.off).toBe(true)
    setOnlineHolidays({ 2026: [{ date: '2026-10-02', name: '国庆', off: true }] })
    expect(holidayOn('2026-10-01')).toBeUndefined()
    expect(holidayOn('2026-10-02')).toEqual({ name: '国庆', off: true, first: true })
  })

  it('数据更新后农历信息跟着重算', () => {
    expect(lunarDay('2027-10-01').holiday).toBeUndefined()
    setOnlineHolidays({ 2027: parseHolidayCn(file2027, 2027) })
    expect(lunarDay('2027-10-01')).toMatchObject({ holiday: { name: '国庆中秋', off: true, first: true }, cell: '国庆中秋' })
    setOnlineHolidays({})
    expect(lunarDay('2027-10-01').holiday).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { diaryDate, isoLocal, weekday } from '../src/core/time'

describe('日记日期（规格 4.4 第 4 条）', () => {
  it('凌晨 1 点写的日记归入前一天', () => {
    expect(diaryDate(new Date(2026, 9, 4, 1, 0))).toBe('2026-10-03')
  })
  it('3:59 仍算前一天，4:00 起算当天', () => {
    expect(diaryDate(new Date(2026, 9, 4, 3, 59))).toBe('2026-10-03')
    expect(diaryDate(new Date(2026, 9, 4, 4, 0))).toBe('2026-10-04')
  })
  it('跨月、跨年也正确', () => {
    expect(diaryDate(new Date(2026, 0, 1, 2, 0))).toBe('2025-12-31')
    expect(diaryDate(new Date(2026, 2, 1, 0, 30))).toBe('2026-02-28')
  })
  it('切换时刻可设置', () => {
    expect(diaryDate(new Date(2026, 9, 4, 1, 0), 0)).toBe('2026-10-04')
    expect(diaryDate(new Date(2026, 9, 4, 5, 0), 6)).toBe('2026-10-03')
  })
  it('时间戳为带时区的 ISO 8601', () => {
    expect(isoLocal(new Date(2026, 8, 30, 21, 14, 3))).toMatch(/^2026-09-30T21:14:03[+-]\d{2}:\d{2}$/)
  })
  it('星期', () => {
    expect(weekday('2026-10-04')).toBe('周日')
  })
})

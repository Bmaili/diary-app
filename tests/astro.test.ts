import { describe, expect, it } from 'vitest'
import { daysBetween, moonPhase } from '../src/core/astro'

describe('月相', () => {
  it('2026-03-03 月全食当晚接近满月', () => {
    const m = moonPhase(new Date(Date.UTC(2026, 2, 3, 11, 33)))
    expect(m.illumination).toBeGreaterThan(0.97)
    expect(m.name).toBe('满月')
  })
  it('参考新月当时为新月', () => {
    const m = moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14)))
    expect(m.illumination).toBeLessThan(0.001)
    expect(m.name).toBe('新月')
  })
  it('新月后约 7.4 天为上弦月，照亮约一半', () => {
    const m = moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14) + 7.38 * 86400000))
    expect(m.name).toBe('上弦月')
    expect(m.illumination).toBeGreaterThan(0.45)
    expect(m.illumination).toBeLessThan(0.55)
  })
  it('日期差', () => {
    expect(daysBetween('2026-09-30', '2026-10-04')).toBe(4)
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2)
  })
})

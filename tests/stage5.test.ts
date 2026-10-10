import { describe, expect, it } from 'vitest'
import { hashPin, lockoutSeconds, validPin, verifyPin } from '../src/core/pin'
import { planReminders, reminderText, REMINDER_BASE_ID } from '../src/core/reminder'
import { withInstructions } from '../src/core/llm/client'

describe('PIN', () => {
  it('哈希后能校验，错误 PIN 不通过', async () => {
    const rec = await hashPin('2718', 1000)
    expect(rec.len).toBe(4)
    expect(rec.hash).not.toContain('2718')
    expect(await verifyPin('2718', rec)).toBe(true)
    expect(await verifyPin('2719', rec)).toBe(false)
    expect(await verifyPin('27180', rec)).toBe(false)
  })
  it('同一个 PIN 两次哈希的盐不同', async () => {
    const a = await hashPin('123456', 1000)
    const b = await hashPin('123456', 1000)
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })
  it('只接受 4–8 位数字', async () => {
    expect(validPin('123')).toBe(false)
    expect(validPin('1234')).toBe(true)
    expect(validPin('12345678')).toBe(true)
    expect(validPin('123456789')).toBe(false)
    expect(validPin('12a4')).toBe(false)
    await expect(hashPin('12')).rejects.toThrow()
  })
  it('输错 5 次后开始等待，逐次翻倍，最多 15 分钟', () => {
    expect([1, 4].map(lockoutSeconds)).toEqual([0, 0])
    expect([5, 6, 7].map(lockoutSeconds)).toEqual([30, 60, 120])
    expect(lockoutSeconds(20)).toBe(900)
  })
})

describe('提醒排程', () => {
  const base = { cutoffHour: 4, skipWritten: true, days: 14 }

  it('从今天起排 14 天，已过的时刻和写过的日子跳过', () => {
    const now = new Date(2026, 9, 4, 23, 0) // 已过今天 22:00
    const written = new Set(['2026-10-06'])
    const plan = planReminders({ ...base, now, today: '2026-10-04', time: '22:00', written: (d) => written.has(d) })
    expect(plan[0].date).toBe('2026-10-05')
    expect(plan.map((p) => p.date)).not.toContain('2026-10-06')
    expect(plan.length).toBe(12)
    expect(plan[0].at.getHours()).toBe(22)
    expect(plan[0].at.getDate()).toBe(5)
    expect(new Set(plan.map((p) => p.id)).size).toBe(plan.length)
    expect(plan.every((p) => p.id >= REMINDER_BASE_ID && p.id < REMINDER_BASE_ID + 14)).toBe(true)
  })

  it('不跳过写过的日子时照常提醒', () => {
    const now = new Date(2026, 9, 4, 8, 0)
    const plan = planReminders({ ...base, skipWritten: false, now, today: '2026-10-04', time: '21:30', written: () => true })
    expect(plan.length).toBe(14)
    expect(plan[0].date).toBe('2026-10-04')
  })

  it('早于一天开始时刻的提醒，落在下一个日历日凌晨', () => {
    const now = new Date(2026, 9, 4, 20, 0)
    const plan = planReminders({ ...base, now, today: '2026-10-04', time: '01:30', written: () => false })
    expect(plan[0].date).toBe('2026-10-04')
    expect(plan[0].at.getDate()).toBe(5)
    expect(plan[0].at.getHours()).toBe(1)
  })

  it('凌晨两点打开 app（仍算前一天），当晚提醒已过则不排', () => {
    const now = new Date(2026, 9, 5, 2, 0) // 日记日期仍是 10-04
    const plan = planReminders({ ...base, now, today: '2026-10-04', time: '22:00', written: () => false })
    expect(plan[0].date).toBe('2026-10-05')
  })

  it('时间格式不对时不排', () => {
    expect(planReminders({ ...base, now: new Date(), today: '2026-10-04', time: 'abc', written: () => false })).toEqual([])
  })

  it('文案带农历；节气、节日当天用点明这一天的句子，不再重复前缀', () => {
    expect(reminderText('2026-10-05').body).toMatch(/^今天农历八月廿五。/)
    expect(reminderText('2026-10-08').body).toBe('寒露，添件衣服，写一句。')
    expect(reminderText('2026-10-18').body).toMatch(/重阳/)
    expect(reminderText('2026-10-18').body).not.toMatch(/^今天重阳。/)
  })
})

describe('AI 补充说明', () => {
  it('空说明不改系统提示', () => {
    expect(withInstructions('SYS', '')).toBe('SYS')
    expect(withInstructions('SYS', '   ')).toBe('SYS')
    expect(withInstructions('SYS')).toBe('SYS')
  })
  it('附加在后面，声明格式要求优先，并限制长度', () => {
    const s = withInstructions('只输出 JSON', '小雨是我女朋友')
    expect(s.startsWith('只输出 JSON')).toBe(true)
    expect(s).toContain('<user_notes>\n小雨是我女朋友\n</user_notes>')
    expect(s).toContain('以上面的要求为准')
    // 共用说明最多 2000 字，加上分功能说明最多 1500 字，合计截到 4000
    expect(withInstructions('S', 'x'.repeat(5000)).length).toBeLessThan(4300)
  })
})

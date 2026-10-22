import { describe, expect, it } from 'vitest'
import { RECENT_MAX, splitChats, trimChats } from '../src/core/chats'

describe('问答记录的保留', () => {
  const conv = (i: number, starred = false) => ({ id: `c${i}`, updatedAt: i, ...(starred ? { starred } : {}) })

  it('没收藏的只留最近 50 段，新的在前', () => {
    const list = Array.from({ length: 60 }, (_, i) => conv(i))
    const kept = trimChats(list)
    expect(kept).toHaveLength(RECENT_MAX)
    expect(kept[0].id).toBe('c59')
    expect(kept.at(-1)!.id).toBe('c10')
  })

  it('收藏的多久以前都留着，也不占 50 段的名额', () => {
    const list = [...Array.from({ length: 60 }, (_, i) => conv(i + 100)), conv(1, true), conv(2, true)]
    const kept = trimChats(list)
    expect(kept).toHaveLength(RECENT_MAX + 2)
    expect(kept.map((c) => c.id)).toContain('c1')
    expect(kept.filter((c) => !c.starred)).toHaveLength(RECENT_MAX)
  })

  it('分成收藏的、最近的两栏', () => {
    const { starred, recent } = splitChats([conv(3), conv(2, true), conv(1)])
    expect(starred.map((c) => c.id)).toEqual(['c2'])
    expect(recent.map((c) => c.id)).toEqual(['c3', 'c1'])
  })
})

import { describe, expect, it } from 'vitest'
import { byMonth, extractOverview, previewOf } from '../src/core/extractOverview'
import type { IndexRow } from '../src/core/types'

const row = (date: string, o: Partial<IndexRow> = {}): IndexRow => ({
  date, path: `diary/entries/${date.slice(0, 4)}/${date}.md`, mtime: 0, size: 0, hash: '',
  tags: [], people: [], places: [], text: '今天去了湖边', sections: 1, ...o,
})

describe('AI 标注一览', () => {
  it('分成待标注、已标注、跳过三组，和批量标注的判断一致', () => {
    const o = extractOverview([
      row('2026-10-14'),
      row('2026-10-13', { extractedAt: '2026-10-13T10:00:00+08:00', updated: '2026-10-13T12:00:00+08:00' }),
      row('2026-10-12', { extractedAt: '2026-10-12T22:00:00+08:00', updated: '2026-10-12T21:00:00+08:00', places: ['西湖'], people: ['阿禾'], tags: ['散步'], locked: ['people'] }),
      row('2026-10-11', { aiExclude: true }),
      row('2026-10-10', { sections: 0, text: '' }),
      row('2026-10-09', { error: 'YAML 有误' }),
    ])
    expect(o.pending.map((r) => [r.date, r.reason])).toEqual([['2026-10-14', 'never'], ['2026-10-13', 'edited']])
    expect(o.tagged).toHaveLength(1)
    expect(o.tagged[0]).toMatchObject({ date: '2026-10-12', places: ['西湖'], people: ['阿禾'], tags: ['散步'], locked: ['people'] })
    expect(o.skipped.map((r) => [r.date, r.reason])).toEqual([['2026-10-11', 'exclude'], ['2026-10-10', 'mood-only'], ['2026-10-09', 'broken']])
  })

  it('标注过但没标出东西的也算已标注；没有 updated 的老日记标过就不再算待标注', () => {
    const o = extractOverview([row('2026-01-02', { extractedAt: '2026-01-03T00:00:00Z' })])
    expect(o.tagged[0]).toMatchObject({ places: [], people: [], tags: [], locked: [] })
  })

  it('摘要压成一行，过长加省略号', () => {
    expect(previewOf('第一行\n\n第二行')).toBe('第一行 第二行')
    expect(previewOf('一'.repeat(40), 36)).toBe(`${'一'.repeat(36)}…`)
  })

  it('按月分组保持顺序', () => {
    const g = byMonth([{ date: '2026-10-14' }, { date: '2026-10-02' }, { date: '2026-09-30' }])
    expect(g.map((x) => [x.month, x.rows.length])).toEqual([['2026-10', 2], ['2026-09', 1]])
  })
})

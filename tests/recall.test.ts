/** 心情即记在索引里的表现、珍藏、随手翻、备份提醒（2026-10-13） */
import { beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo, entryPath } from '../src/core/repo'
import { DiaryIndex, hasBody } from '../src/core/diaryIndex'
import { pickWander } from '../src/core/wander'
import { backupDue } from '../src/core/backupReminder'
import { NodeStore } from './nodeStore'

let store: NodeStore
let repo: DiaryRepo
let index: DiaryIndex

beforeEach(async () => {
  store = await NodeStore.temp()
  repo = new DiaryRepo(store)
  await repo.init()
  index = new DiaryIndex(repo, store)
})

describe('只记了心情的日子', () => {
  it('索引里 sections 为 0，不算待 AI 标注；有正文的照常', async () => {
    await store.writeText(entryPath('2026-10-01'), '---\ndate: 2026-10-01\nmood: 2\n---\n')
    await store.writeText(entryPath('2026-10-02'), '---\ndate: 2026-10-02\nmood: 4\n---\n\n去了海边\n')
    await index.load()
    expect(index.get('2026-10-01')!.sections).toBe(0)
    expect(hasBody(index.get('2026-10-01')!)).toBe(false)
    expect(hasBody(index.get('2026-10-02')!)).toBe(true)
    expect(index.needsExtraction().map((r) => r.date)).toEqual(['2026-10-02'])
    // 心情统计、问答仍然算上它
    expect(index.aiRows().map((r) => r.date)).toContain('2026-10-01')
  })
})

describe('珍藏', () => {
  it('starred() 列出珍藏的日记，搜索可以只看珍藏', async () => {
    await store.writeText(entryPath('2026-10-01'), '---\ndate: 2026-10-01\nstarred: true\n---\n\n搬家\n')
    await store.writeText(entryPath('2026-10-02'), '---\ndate: 2026-10-02\n---\n\n上班\n')
    await store.writeText(entryPath('2026-10-03'), '---\ndate: 2026-10-03\nstarred: true\nmood: 5\n---\n\n看日出\n')
    await index.load()
    expect(index.starred().map((r) => r.date)).toEqual(['2026-10-03', '2026-10-01'])
    expect(index.search({ starred: true }).map((h) => h.row.date)).toEqual(['2026-10-03', '2026-10-01'])
    expect(index.search({ q: '日出', starred: true }).map((h) => h.row.date)).toEqual(['2026-10-03'])
  })
})

describe('随手翻', () => {
  const rows = [
    { date: '2026-10-13' },
    { date: '2026-10-10' },
    { date: '2026-08-01' },
    { date: '2026-07-01', sections: 0 },
    { date: '2026-06-01' },
  ]
  it('先挑一个月以前、有正文的日子，不挑今天，不挑只记了心情的', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) seen.add(pickWander(rows, '2026-10-13', undefined, () => i / 50)!)
    expect([...seen].sort()).toEqual(['2026-06-01', '2026-08-01'])
  })
  it('不连着翻到同一篇', () => {
    for (let i = 0; i < 20; i++) expect(pickWander(rows, '2026-10-13', '2026-08-01', () => i / 20)).toBe('2026-06-01')
  })
  it('日记都是最近的：放宽到今天以外的', () => {
    expect(pickWander([{ date: '2026-10-13' }, { date: '2026-10-12' }], '2026-10-13')).toBe('2026-10-12')
    expect(pickWander([{ date: '2026-10-12', sections: 0 }], '2026-10-13')).toBe('2026-10-12')
    expect(pickWander([{ date: '2026-10-13' }], '2026-10-13')).toBeNull()
  })
})

describe('备份提醒', () => {
  const now = new Date('2026-10-13T10:00:00+08:00')
  const base = { entries: 10, syncOn: 0, lastExport: '', dismissed: false, now }
  it('写满 10 篇、没开同步、没导出过时提醒', () => {
    expect(backupDue(base)).toBe(true)
    expect(backupDue({ ...base, entries: 9 })).toBe(false)
    expect(backupDue({ ...base, syncOn: 1 })).toBe(false)
    expect(backupDue({ ...base, dismissed: true })).toBe(false)
  })
  it('30 天内导出过就不提醒，超过 30 天再提醒', () => {
    expect(backupDue({ ...base, lastExport: '2026-10-01T09:00:00+08:00' })).toBe(false)
    expect(backupDue({ ...base, lastExport: '2026-09-01T09:00:00+08:00' })).toBe(true)
    expect(backupDue({ ...base, lastExport: '乱写的' })).toBe(true)
  })
})

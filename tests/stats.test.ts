import { describe, expect, it } from 'vitest'
import { aggregate, moodSummary, weatherKind, weekStart, type AggregateResult } from '../src/core/llm/stats'
import type { IndexRow } from '../src/core/types'

function row(date: string, o: Partial<IndexRow> = {}): IndexRow {
  return { date, path: `entries/${date.slice(0, 4)}/${date}.md`, mtime: 0, size: 0, hash: date, tags: [], people: [], places: [], text: '', ...o }
}
const ok = (r: ReturnType<typeof aggregate>) => {
  if ('error' in r) throw new Error(r.error)
  return r as AggregateResult
}

const rows: IndexRow[] = [
  row('2026-01-05', { mood: 2, weather: '小雨 6°', places: ['健身房'], people: ['小王'], text: '下雨，去健身房' }),
  row('2026-01-06', { mood: 4, weather: '晴', people: ['小王', '妈妈'], text: '和小王吃饭' }),
  row('2026-01-07', { mood: 5, weather: '多云', text: '去 gym 练腿' }),
  row('2026-03-02', { mood: 3, weather: '阴', places: ['健身房'], text: '' }),
  row('2026-03-03', { weather: '', people: ['妈妈'], text: '没记心情' }),
  row('2025-01-10', { mood: 1, weather: '大雪', places: ['健身房'], text: '' }),
  row('2025-03-15', { mood: 3, weather: '雾霾', text: '' }),
]

describe('天气归类', () => {
  it('自由文本归成几类', () => {
    expect(['晴', '晴间多云', '多云', '阴', '小雨 18°', '雷阵雨', '中雪', '雾', '霾', '扬沙', '', '冷'].map(weatherKind))
      .toEqual(['晴', '多云', '多云', '阴', '雨', '雨', '雪', '雾霾', '雾霾', '雾霾', '未记录', '其他'])
  })
})

describe('aggregate', () => {
  it('按月分组：补齐空档的月份，算天数、平均心情和心情分布', () => {
    const r = ok(aggregate(rows, { group_by: 'month', from: '2026-01', to: '2026-03' }))
    const g = r.series[0].groups
    expect(g.map((x) => [x.key, x.days])).toEqual([['2026-01', 3], ['2026-02', 0], ['2026-03', 2]])
    expect(g[0].avg_mood).toBe(3.67)
    expect(g[0].moods).toEqual([0, 1, 0, 1, 1])
    expect(g[1].avg_mood).toBeNull()
    // 3 月有一天没记心情：平均只算记了的
    expect(g[2].avg_mood).toBe(3)
    expect(g[0].label).toBe('2026 年 1 月')
    expect(r.series[0].total_days).toBe(5)
  })

  it('结束日期不超过最近一篇日记：问“今年”不画出还没到的月份', () => {
    const r = ok(aggregate(rows, { group_by: 'month', from: '2026', to: '2026' }))
    expect(r.series[0].groups.map((g) => g.key)).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('terms 同时匹配元数据和正文（同一天只算一次）', () => {
    const r = ok(aggregate(rows, { group_by: 'none', terms: ['健身房', 'gym'] }))
    expect(r.series[0].total_days).toBe(4)
    const meta = ok(aggregate(rows, { group_by: 'none', terms: ['健身房', 'gym'], match_text: false }))
    expect(meta.series[0].total_days).toBe(3)
  })

  it('按星期、心情、天气分组的顺序固定', () => {
    expect(ok(aggregate(rows, { group_by: 'weekday' })).series[0].groups.map((g) => g.key)).toEqual(['周一', '周二', '周三', '周四', '周五', '周六', '周日'])
    const mood = ok(aggregate(rows, { group_by: 'mood' })).series[0].groups
    expect(mood.map((g) => [g.key, g.days])).toEqual([['1', 1], ['2', 1], ['3', 2], ['4', 1], ['5', 1]])
    const w = ok(aggregate(rows, { group_by: 'weather' })).series[0].groups
    expect(w.map((g) => g.key)).toEqual(['晴', '多云', '阴', '雨', '雪', '雾霾', '其他', '未记录'])
    expect(w.find((g) => g.key === '雨')!.avg_mood).toBe(2)
  })

  it('没有未记录天气的日子时不列这一组', () => {
    const w = ok(aggregate(rows.filter((r) => r.weather), { group_by: 'weather' })).series[0].groups
    expect(w.map((g) => g.key)).not.toContain('未记录')
  })

  it('按人物分组：一天可以属于几个人，按天数排序，超出 limit 的报个数', () => {
    const r = ok(aggregate(rows, { group_by: 'person', limit: 1 }))
    expect(r.series[0].groups.map((g) => [g.key, g.days])).toEqual([['妈妈', 2]])
    expect(r.more).toBe(1)
    const all = ok(aggregate(rows, { group_by: 'person' }))
    expect(all.series[0].groups.map((g) => [g.key, g.days, g.avg_mood])).toEqual([['妈妈', 2, 4], ['小王', 2, 3]])
  })

  it('按天气、心情筛选', () => {
    expect(ok(aggregate(rows, { group_by: 'none', weather: ['雨', '雪'] })).series[0].total_days).toBe(2)
    expect(ok(aggregate(rows, { group_by: 'none', moods: [4, 5] })).series[0].total_days).toBe(2)
  })

  it('系列对比：今年和去年按月对齐', () => {
    const r = ok(aggregate(rows, {
      group_by: 'month',
      terms: ['健身房'],
      series: [{ label: '今年', from: '2026', to: '2026' }, { label: '去年', from: '2025', to: '2025' }],
    }))
    expect(r.series.map((s) => s.label)).toEqual(['今年', '去年'])
    const keys = r.series[0].groups.map((g) => g.key)
    expect(keys[0]).toBe('01')
    expect(r.series[1].groups.map((g) => g.key)).toEqual(keys)
    expect(r.series[0].groups[0]).toMatchObject({ label: '1 月', days: 1 })
    expect(r.series[1].groups[0]).toMatchObject({ label: '1 月', days: 1 })
    expect(r.series[0].groups.find((g) => g.key === '03')!.days).toBe(1)
  })

  it('系列对比：晴天和雨天的心情', () => {
    const r = ok(aggregate(rows, { group_by: 'none', series: [{ label: '晴', weather: ['晴'] }, { label: '雨', weather: ['雨'] }] }))
    expect(r.series.map((s) => [s.label, s.total_days, s.avg_mood])).toEqual([['晴', 1, 4], ['雨', 1, 2]])
  })

  it('按周分组从周一开始；按天分组太长时报错', () => {
    expect(weekStart('2026-01-07')).toBe('2026-01-05')
    expect(weekStart('2026-01-11')).toBe('2026-01-05')
    const w = ok(aggregate(rows, { group_by: 'week', from: '2026-01-01', to: '2026-01-15' }))
    expect(w.series[0].groups.map((g) => [g.key, g.days])).toEqual([['2025-12-29', 0], ['2026-01-05', 3], ['2026-01-12', 0]])
    expect('error' in aggregate(rows, { group_by: 'day', from: '2024-01-01', to: '2026-03-03' })).toBe(true)
  })

  it('分组太多时不带每组的心情分布', () => {
    const many = Array.from({ length: 200 }, (_, i) => row(`2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, { mood: 3 }))
    const r = ok(aggregate(many, { group_by: 'day' }))
    expect(r.series[0].groups.length).toBeGreaterThan(120)
    expect(r.series[0].groups[0].moods).toBeUndefined()
    expect(r.series[0].moods).toEqual([0, 0, 200, 0, 0])
  })

  it('参数写错时不崩溃', () => {
    const r = ok(aggregate(rows, { group_by: 'nonsense', moods: 'x', series: 'y' }))
    expect(r.group_by).toBe('none')
    expect(r.series[0].total_days).toBe(rows.length)
  })

  it('心情概况', () => {
    expect(moodSummary(rows)).toEqual({ mood_days: 6, avg_mood: 3, moods: [1, 1, 2, 1, 1] })
  })
})

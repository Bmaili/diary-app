import { describe, expect, it } from 'vitest'
import { answerDates, briefOf, cnDay, linkNames, markQuotes, quoteFound, splitRelated } from '../src/core/answer'
import { suggestQuestions } from '../src/core/suggest'
import { ago, buildBio, companion, sealText } from '../src/core/bio'
import { cleanPortrait, portraitMessage } from '../src/core/llm/portrait'
import { systemPrompt } from '../src/core/llm/agent'
import type { IndexRow } from '../src/core/types'

const row = (date: string, o: Partial<IndexRow> = {}): IndexRow => ({
  date, path: '', mtime: 0, size: 0, hash: '', tags: [], people: [], places: [], text: '', sections: 1, ...o,
})

describe('回答里的日子', () => {
  it('拆出“相关日期”那一行；没有时用正文里的日期', () => {
    const md = '你们去了海边。\n\n**相关日期**：2026-09-08、2026-10-03、2026-09-08'
    expect(splitRelated(md)).toEqual({ body: '你们去了海边。', dates: ['2026-09-08', '2026-10-03'] })
    expect(answerDates(md)).toEqual(['2026-09-08', '2026-10-03'])
    expect(answerDates('10-05 那天，2026-10-05 和 2026-10-01')).toEqual(['2026-10-05', '2026-10-01'])
    // “相关日期”不在最后一行时不动
    expect(splitRelated('相关日期：2026-01-01\n后面还有话').dates).toEqual([])
  })

  it('汉字日子：今年的不写年份', () => {
    expect(cnDay('2026-09-08', '2026')).toBe('九月八日')
    expect(cnDay('2026-10-21', '2026')).toBe('十月二十一日')
    expect(cnDay('2025-12-31', '2026')).toBe('二〇二五年十二月三十一日')
  })

  it('收藏的问题记下回答的第一句', () => {
    expect(briefOf('**4 次**，都在周末。\n\n[[chart:c1]]')).toBe('4 次，都在周末。')
    expect(briefOf('一'.repeat(40), 10)).toBe(`${'一'.repeat(10)}…`)
  })
})

describe('原文引文', () => {
  const src = '凌晨四点出门，海边风很大。今年最开心的一天，大概就是这一天了。回来路上睡着了。'

  it('逐字核对：标点、引号、空白不计较；省略号分段按顺序找', () => {
    expect(quoteFound('“今年最开心的一天，大概就是这一天了。”', src)).toBe(true)
    expect(quoteFound('今年最开心的 一天,大概就是这一天了', src)).toBe(true)
    expect(quoteFound('凌晨四点出门……回来路上睡着了', src)).toBe(true)
    expect(quoteFound('回来路上睡着了……凌晨四点出门', src)).toBe(false)
    expect(quoteFound('今年最快乐的一天', src)).toBe(false)
    expect(quoteFound('一天', src)).toBe(false)
  })

  it('找得到排成引文、标出真正的日子；找不到当普通文字', () => {
    const find = (t: string, d?: string) => (quoteFound(t, src) ? (d === '2026-09-08' ? d : '2026-09-08') : null)
    const md = '那天你写：\n\n> “今年最开心的一天，大概就是这一天了。”\n> —— 2026-09-07\n\n还有：\n\n> 我很喜欢海。\n> —— 2026-09-08\n\n完。'
    const out = markQuotes(md, find, () => '九月八日')
    expect(out).toContain('<blockquote class="yin"><p>“今年最开心的一天，大概就是这一天了。”</p><cite><a href="#/entry/2026-09-08">九月八日</a></cite></blockquote>')
    expect(out).toContain('\n我很喜欢海。\n')
    expect(out).not.toContain('> 我很喜欢海')
    expect(out).toContain('完。')
  })

  it('问答的系统提示词带着引文的写法（固定部分，用户改提示词也在）', () => {
    expect(systemPrompt('2026-10-15', null, null, 0, '自己写的提示词')).toContain('—— YYYY-MM-DD')
  })
})

describe('回答里的人名地名', () => {
  it('第一次出现处变成链接；长名字优先；不进已有链接和标题', () => {
    const html = '<p>和阿禾去了西湖边茶馆，又和阿禾去<a href="#/entry/2026-01-01">西湖</a>。</p><h3>阿禾</h3><p>西湖很美</p>'
    const out = linkNames(html, [
      { field: 'people', value: '阿禾' }, { field: 'places', value: '西湖' }, { field: 'places', value: '西湖边茶馆' }, { field: 'people', value: '我' },
    ])
    expect(out).toContain(`<a href="#/who/people/${encodeURIComponent('阿禾')}" class="who">阿禾</a>去了<a href="#/who/places/${encodeURIComponent('西湖边茶馆')}" class="who">西湖边茶馆</a>，又和阿禾去`)
    expect(out).toContain('<h3>阿禾</h3>')
    expect(out).toContain(`<p><a href="#/who/places/${encodeURIComponent('西湖')}" class="who">西湖</a>很美</p>`)
  })
})

describe('推荐问题', () => {
  const rows = [
    ...Array.from({ length: 40 }, (_, i) => row(`2026-${String(1 + (i % 10)).padStart(2, '0')}-${String(1 + i % 28).padStart(2, '0')}`, {
      people: i % 2 ? ['阿禾'] : ['外婆'], places: i % 3 ? ['西湖'] : ['旧书店'], tags: ['读书'],
    })),
    row('2025-10-15'),
  ]
  it('人、地、标签、时间都有一点，不重复；同一个种子结果一样，换种子会变', () => {
    const a = suggestQuestions(rows, '2026-10-15', 1)
    expect(a).toHaveLength(5)
    expect(new Set(a.map((s) => s.q)).size).toBe(5)
    expect(new Set(a.map((s) => s.kind))).toEqual(new Set(['person', 'place', 'tag', 'time']))
    expect(suggestQuestions(rows, '2026-10-15', 1)).toEqual(a)
    const many = new Set(Array.from({ length: 12 }, (_, i) => suggestQuestions(rows, '2026-10-15', i + 2).map((s) => s.q).join('|')))
    expect(many.size).toBeGreaterThan(3)
    // 去年这时候有日记，才会问“去年这个时候”
    const asked = (rs: IndexRow[]) => Array.from({ length: 40 }, (_, i) => suggestQuestions(rs, '2026-10-15', i)).some((l) => l.some((s) => s.q === '去年这个时候我在忙什么？'))
    expect(asked(rows)).toBe(true)
    expect(asked(rows.slice(0, -1))).toBe(false)
  })
  it('还没标注过时只出时间类的；没日记时不出', () => {
    const plain = suggestQuestions([row('2026-10-14'), row('2026-10-10')], '2026-10-15', 3)
    expect(plain.every((s) => s.kind === 'time')).toBe(true)
    expect(plain.length).toBeGreaterThan(0)
    expect(suggestQuestions([], '2026-10-15', 3)).toEqual([])
  })
})

describe('小传', () => {
  const rows = [
    row('2026-10-11', { people: ['阿禾'], places: ['旧书店'], mood: 4, text: '下午和阿禾去旧书店。' }),
    row('2026-10-08', { people: ['阿禾', '外婆'], places: ['西湖'], mood: 4, text: '晚上在湖边走。' }),
    row('2026-09-08', { people: ['阿禾'], places: ['西湖'], mood: 5, text: '去海边看日出。' }),
    row('2025-03-16', { people: ['阿禾'], places: ['西湖'], text: '第一次见。' }),
    row('2026-10-01', { people: ['外婆'] }),
  ]
  it('天数、每月、心情、常一起出现都由代码算', () => {
    const b = buildBio(rows, 'people', '阿禾')
    expect(b.days.map((d) => d.date)).toEqual(['2026-10-11', '2026-10-08', '2026-09-08', '2025-03-16'])
    expect([b.first, b.last]).toEqual(['2025-03-16', '2026-10-11'])
    expect(b.years).toEqual(['2026', '2025'])
    expect(b.inYear('2026')).toBe(3)
    expect(b.months('2026')[9]).toBe(2)
    expect(b.months('2026')[8]).toBe(1)
    expect(b.moods).toEqual([1, 0, 0, 0, 2, 1])
    expect(b.together[0]).toEqual({ field: 'places', value: '西湖', count: 3 })
    expect(companion(b)).toEqual({ label: '常一起去', value: '西湖' })
    expect(buildBio(rows, 'places', '西湖').together[0]).toEqual({ field: 'people', value: '阿禾', count: 3 })
  })
  it('印章字、多久以前', () => {
    expect(sealText('people', '阿禾')).toBe('阿禾')
    expect(sealText('places', '西湖边的茶馆')).toBe('地')
    expect(ago('2026-10-12', '2026-10-15')).toBe('3 天前')
    expect(ago('2026-10-15', '2026-10-15')).toBe('今天')
    expect(ago('2026-06-15', '2026-10-15')).toBe('4 个月前')
    expect(ago('2024-10-15', '2026-10-15')).toBe('2 年前')
  })
  it('请 AI 写几句：数字放进消息里；篇数多时隔几篇取一篇；输出去掉格式', () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({ date: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, text: '字'.repeat(400) }))
    const m = portraitMessage({ field: 'people', value: '阿禾', entries, total: 100, first: '2025-01-01', last: '2026-10-11' }, 8000)
    expect(m.text).toContain('一共写到 100 天，第一次是 2025-01-01，最近一次是 2026-10-11')
    expect(m.used).toBeLessThan(100)
    expect(m.text.length).toBeLessThan(9000)
    expect(cleanPortrait('<think>想想</think>\n“**你们**常在湖边走。”')).toBe('你们常在湖边走。')
  })
})

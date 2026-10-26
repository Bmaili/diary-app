import { beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo } from '../src/core/repo'
import { hasRecord } from '../src/core/entryFile'
import { bodyFor, openSession, shownBody } from '../src/core/session'
import { checklistMarkdown, isWorkday, itemsFor, whenLabel, type ChecklistItem } from '../src/core/checklist'
import { dominantMood } from '../src/core/moodSummary'
import type { HolidayInfo } from '../src/core/holidays'
import { NodeStore } from './nodeStore'

/** 虚构的节假日：2026-10-05（周一）放假，2026-10-10（周六）调休上班 */
const fakeHoliday = (d: string): HolidayInfo | undefined =>
  d === '2026-10-05' ? { name: '国庆', off: true, first: false } : d === '2026-10-10' ? { name: '国庆', off: false, first: false } : undefined
const none = () => undefined

describe('日历的“心情多是”', () => {
  it('取天数最多的一档，不被几天低谷拉成“一般”', () => {
    const moods = [...Array(10).fill(4), 1, 1, 2, 2]
    expect(dominantMood(moods)).toEqual({ mood: 4, days: 10 })
  })
  it('没有心情时为 null', () => {
    expect(dominantMood([])).toBeNull()
  })
  it('并列时取离平均值近的那档', () => {
    // 4、2 各三天，还有一天 5：平均 3.29，4 更近
    expect(dominantMood([4, 4, 4, 2, 2, 2, 5])?.mood).toBe(4)
    // 一样近时取靠中间的
    expect(dominantMood([5, 5, 3, 3])?.mood).toBe(3)
  })
})

describe('每日清单', () => {
  const list: ChecklistItem[] = [
    { text: '喝够八杯水', when: 'daily' },
    { text: '晨会前看周报', when: 'workday' },
    { text: '睡个懒觉', when: 'restday' },
    { text: '倒垃圾', when: 'weekly', weekdays: [1, 4] },
    { text: '  ', when: 'daily' },
  ]

  it('工作日按节假日和调休算', () => {
    expect(isWorkday('2026-10-05', fakeHoliday)).toBe(false) // 放假的周一
    expect(isWorkday('2026-10-10', fakeHoliday)).toBe(true) // 调休上班的周六
    expect(isWorkday('2026-10-12', fakeHoliday)).toBe(true)
    expect(isWorkday('2026-10-11', fakeHoliday)).toBe(false)
  })

  it('按日子挑出要填的事，空的一项不填', () => {
    expect(itemsFor(list, '2026-10-12', none)).toEqual(['喝够八杯水', '晨会前看周报', '倒垃圾']) // 周一
    expect(itemsFor(list, '2026-10-13', none)).toEqual(['喝够八杯水', '晨会前看周报']) // 周二
    expect(itemsFor(list, '2026-10-05', fakeHoliday)).toEqual(['喝够八杯水', '睡个懒觉', '倒垃圾']) // 放假的周一
    expect(itemsFor(list, '2026-10-10', fakeHoliday)).toEqual(['喝够八杯水', '晨会前看周报']) // 调休的周六
  })

  it('一项只占一行；写成待办', () => {
    expect(itemsFor([{ text: '读书\n半小时', when: 'daily' }], '2026-10-12', none)).toEqual(['读书 半小时'])
    expect(checklistMarkdown(['a', 'b'])).toBe('- [ ] a\n- [ ] b\n\n')
    expect(checklistMarkdown([])).toBe('')
  })

  it('设置里的说法', () => {
    expect(whenLabel({ text: '', when: 'weekly', weekdays: [4, 0, 1] })).toBe('周一、周四、周日')
    expect(whenLabel({ text: '', when: 'workday' })).toBe('工作日')
  })
})

describe('新的一天预填（编辑会话）', () => {
  let repo: DiaryRepo
  beforeEach(async () => {
    repo = new DiaryRepo(await NodeStore.temp())
    await repo.init()
  })
  const now = new Date(2026, 9, 26, 9, 30)
  const prefill = '- [ ] 喝水\n- [ ] 读书\n\n'

  it('第一次写也标时间：从“写今天”进入才加；没写就不保存', async () => {
    const s = await openSession(repo, '2026-10-26', { append: true, now, firstHeading: true })
    expect(s.initialText).toBe('### 09:30\n')
    expect(bodyFor(s, s.initialText)).toBe('')
    expect(bodyFor(s, s.initialText + '早上好')).toBe('### 09:30\n早上好')
    const b = await openSession(repo, '2026-10-26', { append: false, now, firstHeading: true })
    expect(b.initialText).toBe('')
  })

  it('开关关着时和以前一样', async () => {
    const s = await openSession(repo, '2026-10-26', { append: true, now })
    expect(s.initialText).toBe('')
    expect(s.appended).toBe(false)
  })

  it('只记了心情的日子：开着开关也加时间', async () => {
    await repo.saveEntry({ meta: { date: '2026-10-26', mood: 4 }, body: '', extra: [] })
    const s = await openSession(repo, '2026-10-26', { append: true, now, firstHeading: true })
    expect(s.initialText).toBe('### 09:30\n')
  })

  it('清单没动过：不保存、不算记了，但阅读视图里显示出来', async () => {
    const s = await openSession(repo, '2026-10-26', { append: true, now, prefill })
    expect(s.initialText).toBe(prefill)
    expect(s.appended).toBe(true)
    const body = bodyFor(s, s.initialText)
    expect(body).toBe('')
    expect(hasRecord({ body, meta: s.doc.meta })).toBe(false)
    expect(shownBody(s, s.initialText)).toBe(prefill)
  })

  it('勾了一项就算记了；末尾自动加的空时间标题不留', async () => {
    const s = await openSession(repo, '2026-10-26', { append: true, now, prefill, firstHeading: true })
    expect(s.initialText).toBe(`${prefill}### 09:30\n`)
    const ticked = s.initialText.replace('- [ ] 喝水', '- [x] 喝水')
    const body = bodyFor(s, ticked)
    expect(body).toBe('- [x] 喝水\n- [ ] 读书')
    expect(hasRecord({ body, meta: s.doc.meta })).toBe(true)
    expect(shownBody(s, s.initialText)).toBe('- [ ] 喝水\n- [ ] 读书')
  })

  it('当天已经写过：不再填清单，照常追加时间标题', async () => {
    await repo.saveEntry({ meta: { date: '2026-10-26' }, body: '上午写的。', extra: [] })
    const s = await openSession(repo, '2026-10-26', { append: true, now, prefill, firstHeading: true })
    expect(s.initialText).toBe('上午写的。\n\n### 09:30\n')
  })
})

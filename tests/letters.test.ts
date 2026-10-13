/** 写给未来的信（规格 4.8、5.13）和 app 自己的提示框 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo } from '../src/core/repo'
import {
  daysUntil, LETTER_BASE_ID, letterPath, letterState, listLetters, newLetterId, parseLetter, planLetterReminders, quickDates,
  serializeLetter, type Letter,
} from '../src/core/letters'
import { listTrash, restoreTrash, trashLetter } from '../src/core/trash'
import { DiaryIndex } from '../src/core/diaryIndex'
import { answer, ask, choose, dialog, promptText } from '../src/ui/dialog'
import { NodeStore } from './nodeStore'

let store: NodeStore
let repo: DiaryRepo

beforeEach(async () => {
  store = await NodeStore.temp()
  repo = new DiaryRepo(store)
  await repo.init()
})

const L = (id: string, meta: Letter['meta'], body = '一年后的我：\n\n希望你还在写。'): Letter => ({ id, meta, body, extra: [] })

describe('信的文件格式', () => {
  it('写出来是 front matter 加正文，读回来一样；不认识的字段原样保留', () => {
    const l = L('2026-10-13_1', { written: '2026-10-13T10:00:00+08:00', open_on: '2027-10-13', remind: true })
    const text = serializeLetter(l)
    expect(text).toBe('---\nwritten: 2026-10-13T10:00:00+08:00\nopen_on: 2027-10-13\nremind: true\n---\n\n一年后的我：\n\n希望你还在写。\n')
    expect(parseLetter(text, l.id)).toMatchObject({ meta: l.meta, body: l.body })
    const withExtra = parseLetter('---\nwritten: x\nopen_on: 2027-01-01\nmy_note: 别删\n---\n\n正文\n', 'a')
    expect(serializeLetter(withExtra)).toContain('my_note: 别删')
  })

  it('没有有效拆信日期的文件算坏掉，列表里跳过、不改它', async () => {
    await store.writeText(letterPath('2026-10-13_1'), serializeLetter(L('2026-10-13_1', { written: 'w', open_on: '2027-10-13' })))
    await store.writeText(letterPath('bad'), '---\nwritten: x\n---\n\n没有日期\n')
    const r = await listLetters(store)
    expect(r.letters.map((l) => l.id)).toEqual(['2026-10-13_1'])
    expect(r.broken).toEqual(['bad.md'])
    expect(await store.readText(letterPath('bad'))).toContain('没有日期')
  })

  it('状态：没到是封着，到了没拆是到了，拆过是拆开', () => {
    const l = L('a', { written: 'w', open_on: '2027-01-01' })
    expect(letterState(l, '2026-12-31')).toBe('sealed')
    expect(letterState(l, '2027-01-01')).toBe('arrived')
    expect(letterState({ ...l, meta: { ...l.meta, opened: '2027-01-01T09:00:00+08:00' } }, '2027-01-01')).toBe('opened')
  })

  it('编号按写信那天往上加；快捷日期；还有几天', async () => {
    expect(await newLetterId(store, '2026-10-13')).toBe('2026-10-13_1')
    await store.writeText(letterPath('2026-10-13_1'), 'x')
    expect(await newLetterId(store, '2026-10-13')).toBe('2026-10-13_2')
    expect(quickDates('2026-10-13').map((q) => q.date)).toEqual(['2027-10-13', '2027-01-01', '2029-10-13'])
    expect(quickDates('2028-02-29')[0].date).toBe('2029-02-28')
    expect(daysUntil('2026-10-13', '2027-01-01')).toBe(80)
  })

  it('信不进日记索引：问答、搜索、总结都读不到', async () => {
    await store.writeText(letterPath('2026-10-13_1'), serializeLetter(L('2026-10-13_1', { written: 'w', open_on: '2027-10-13' }, '秘密的话')))
    const index = new DiaryIndex(repo, store)
    await index.load()
    expect(index.size).toBe(0)
    expect(index.search({ q: '秘密' })).toEqual([])
  })
})

describe('删信、撤回', () => {
  it('移到最近删除，可以恢复；同名的信已经在时不覆盖', async () => {
    const l = L('2026-10-13_1', { written: 'w', open_on: '2027-10-13' })
    await store.writeText(letterPath(l.id), serializeLetter(l))
    const item = (await trashLetter(store, l.id, '（一封撤回的信，没拆过）'))!
    expect(item.kind).toBe('letter')
    expect(await store.stat(letterPath(l.id))).toBeNull()
    expect((await listTrash(store))[0].preview).toBe('（一封撤回的信，没拆过）')
    expect(await restoreTrash(repo, item.id)).toBe('2026-10-13')
    expect(await store.readText(letterPath(l.id))).toBe(serializeLetter(l))

    const again = (await trashLetter(store, l.id, ''))!
    await store.writeText(letterPath(l.id), '后来又写的')
    await expect(restoreTrash(repo, again.id)).rejects.toThrow('没有覆盖')
    expect(await store.readText(letterPath(l.id))).toBe('后来又写的')
  })
})

describe('到期提醒', () => {
  it('只排封着、开了提醒、拆信那天 9 点还没过的', () => {
    const now = new Date('2026-10-13T10:00:00')
    const list = [
      L('a', { written: 'w', open_on: '2027-10-13', remind: true }),
      L('b', { written: 'w', open_on: '2027-10-13' }),
      L('c', { written: 'w', open_on: '2026-10-13', remind: true }),
      L('d', { written: 'w', open_on: '2027-01-01', remind: true, opened: 'x' }),
    ]
    const plan = planLetterReminders(list, now)
    expect(plan.map((p) => p.letter)).toEqual(['a'])
    expect(plan[0].id).toBe(LETTER_BASE_ID)
    expect(plan[0].at.getHours()).toBe(9)
  })
})

describe('app 自己的提示框', () => {
  it('一次显示一个，后来的排队；返回键（answer(null)）按 dismiss 处理', async () => {
    const a = ask({ title: '删除？', danger: true })
    const b = choose({ title: '二选一', options: [{ label: '甲', value: 'x' }, { label: '乙', value: 'y' }], dismiss: 'y' })
    expect(dialog.current?.title).toBe('删除？')
    expect(dialog.current?.buttons.map((x) => x.kind)).toEqual(['ghost', 'danger'])
    answer('yes')
    expect(await a).toBe(true)
    expect(dialog.current?.title).toBe('二选一')
    answer(null)
    expect(await b).toBe('y')
    expect(dialog.current).toBeNull()
  })

  it('输入框：确定时返回输入的字，取消返回 null', async () => {
    const p = promptText({ title: '改名为', value: '老王' })
    expect(dialog.input).toBe('老王')
    dialog.input = '老王烧烤'
    answer('yes')
    expect(await p).toBe('老王烧烤')
    const q = promptText({ title: '改名为' })
    answer(null)
    expect(await q).toBeNull()
  })
})

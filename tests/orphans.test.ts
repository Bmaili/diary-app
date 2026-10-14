import { beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo } from '../src/core/repo'
import { findOrphans, imageDay, imageRefs, namesIn, removedInSession } from '../src/core/orphans'
import { imageDays, listTrash, restoreTrash, trashImages } from '../src/core/trash'
import { NodeStore } from './nodeStore'
import { promises as fs } from 'node:fs'

let store: NodeStore
let repo: DiaryRepo

beforeEach(async () => {
  store = await NodeStore.temp()
  repo = new DiaryRepo(store)
  await repo.init()
})

const write = (date: string, body: string) => repo.saveEntry({ meta: { date }, body, extra: [] })
const img = async (rel: string, ageMs = 0) => {
  await store.writeBase64(`diary/${rel}`, 'AAAA')
  if (ageMs) {
    const t = new Date(Date.now() - ageMs)
    await fs.utimes(store.abs(`diary/${rel}`), t, t)
  }
}
const DAY = 86400000

describe('正文里的图片', () => {
  it('取出引用的路径和原来的写法（带说明）', () => {
    const refs = imageRefs('看\n\n![湖边](../../attachments/2026/2026-10-14_1.webp)\n\n![](../../attachments/2026/2026-10-14_2.jpg)\n![湖边](../../attachments/2026/2026-10-14_1.webp)')
    expect(refs).toEqual([
      { rel: 'attachments/2026/2026-10-14_1.webp', md: '![湖边](../../attachments/2026/2026-10-14_1.webp)' },
      { rel: 'attachments/2026/2026-10-14_2.jpg', md: '![](../../attachments/2026/2026-10-14_2.jpg)' },
    ])
  })
  it('文件名不分大小写；按文件名开头的日期归到那一天', () => {
    expect(namesIn('![](../../attachments/2026/2026-10-14_1.WEBP)')).toEqual(['2026-10-14_1.webp'])
    expect(imageDay('attachments/2026/2026-10-03_2.jpg', 'x')).toBe('2026-10-03')
    expect(imageDay('attachments/2026/photo.jpg', '2026-10-14')).toBe('2026-10-14')
  })
})

describe('清理没被用到的图片', () => {
  it('只找出哪篇日记和信都没提到、且一天前就有的图', async () => {
    await write('2026-10-01', '![](../../attachments/2026/2026-10-01_1.webp)')
    await store.writeText('diary/letters/2026-10-02_1.md', '---\nwritten: x\nopen_on: 2027-10-02\n---\n\n看 2026-10-02_1.jpg')
    await img('attachments/2026/2026-10-01_1.webp', 3 * DAY) // 用着
    await img('attachments/2026/2026-10-02_1.jpg', 3 * DAY) // 信里提到，保守起见算用着
    await img('attachments/2026/2026-10-03_1.jpg', 3 * DAY) // 没人用
    await img('attachments/2025/2025-01-01_1.jpg', 400 * DAY) // 没人用
    await img('attachments/2026/2026-10-14_1.webp') // 刚存的，可能正在编辑
    const o = await findOrphans(repo)
    expect(o.map((x) => x.rel)).toEqual(['attachments/2025/2025-01-01_1.jpg', 'attachments/2026/2026-10-03_1.jpg'])
  })

  it('移到最近删除、恢复时接回各自那天日记的末尾；那天没有日记就新建一篇', async () => {
    await write('2026-10-03', '那天下雨')
    await img('attachments/2026/2026-10-03_1.jpg', 3 * DAY)
    await img('attachments/2026/2026-10-05_1.jpg', 3 * DAY)
    const orphans = await findOrphans(repo)
    const item = await trashImages(store, orphans.map((o) => ({ rel: o.rel, md: `![](../../${o.rel})` })), '2026-10-14', 'cleanup')
    expect(item?.kind).toBe('images')
    expect(await store.stat('diary/attachments/2026/2026-10-03_1.jpg')).toBeNull()
    expect(imageDays(item!)).toEqual(['2026-10-03', '2026-10-05'])
    expect((await listTrash(store))[0].source).toBe('cleanup')

    await restoreTrash(repo, item!.id)
    expect(await store.stat('diary/attachments/2026/2026-10-03_1.jpg')).not.toBeNull()
    expect((await repo.readEntry('2026-10-03'))!.body).toBe('那天下雨\n\n![](../../attachments/2026/2026-10-03_1.jpg)')
    expect((await repo.readEntry('2026-10-05'))!.body).toBe('![](../../attachments/2026/2026-10-05_1.jpg)')
    expect(await listTrash(store)).toEqual([])
  })

  it('那天的日记格式有误时不恢复，图片留在最近删除', async () => {
    await img('attachments/2026/2026-10-03_1.jpg', 3 * DAY)
    const item = await trashImages(store, [{ rel: 'attachments/2026/2026-10-03_1.jpg', md: '![](../../attachments/2026/2026-10-03_1.jpg)' }], '2026-10-14', 'cleanup')
    await store.writeText('diary/entries/2026/2026-10-03.md', '---\ndate: [\n---\n\n坏了')
    await expect(restoreTrash(repo, item!.id)).rejects.toThrow('格式有误')
    expect(await store.stat('diary/attachments/2026/2026-10-03_1.jpg')).toBeNull()
    expect(await listTrash(store)).toHaveLength(1)
  })
})

describe('离开编辑页时去掉的图', () => {
  it('打开时引用、现在不引用的图，和这次新插又删掉的图；别的日记还在用的不算', async () => {
    await img('attachments/2026/2026-10-14_1.webp', 3 * DAY)
    await img('attachments/2026/2026-10-14_2.webp', 3 * DAY)
    await img('attachments/2026/2026-10-14_3.webp', 3 * DAY)
    const original = '早上\n\n![桂花](../../attachments/2026/2026-10-14_1.webp)\n\n![](../../attachments/2026/2026-10-14_2.webp)\n\n![](../../attachments/2026/2026-10-14_3.webp)'
    await write('2026-10-13', '借用一张 ![](../../attachments/2026/2026-10-14_3.webp)')
    const openedAt = Date.now()
    await img('attachments/2026/2026-10-14_4.webp') // 这次插的
    await img('attachments/2026/2026-10-14_9.webp', 3 * DAY) // 以前就没人用的旧图，这次不管（留给手动清理）
    await write('2026-10-14', '早上\n\n![](../../attachments/2026/2026-10-14_2.webp)')
    const r = await removedInSession(repo, '2026-10-14', original, openedAt)
    expect(r).toEqual([
      { rel: 'attachments/2026/2026-10-14_1.webp', md: '![桂花](../../attachments/2026/2026-10-14_1.webp)' },
      { rel: 'attachments/2026/2026-10-14_4.webp', md: '![](../../attachments/2026/2026-10-14_4.webp)' },
    ])

    // 恢复时带着原来的说明接回去
    const item = await trashImages(store, r, '2026-10-14', 'edit')
    await restoreTrash(repo, item!.id)
    expect((await repo.readEntry('2026-10-14'))!.body).toBe(
      '早上\n\n![](../../attachments/2026/2026-10-14_2.webp)\n\n![桂花](../../attachments/2026/2026-10-14_1.webp)\n\n![](../../attachments/2026/2026-10-14_4.webp)',
    )
  })

  it('什么都没去掉时不翻其他日记', async () => {
    await img('attachments/2026/2026-10-14_1.webp', 3 * DAY)
    const body = '![](../../attachments/2026/2026-10-14_1.webp)'
    await write('2026-10-14', body)
    expect(await removedInSession(repo, '2026-10-14', body, Date.now())).toEqual([])
  })
})

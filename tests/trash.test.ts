import { beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo, entryPath } from '../src/core/repo'
import { listTrash, ownImages, purgeTrash, purgeTrashItem, restoreTrash, trashEntry } from '../src/core/trash'
import { SyncEngine } from '../src/core/sync/engine'
import type { RemoteStore, Upload } from '../src/core/sync/remote'
import { NodeStore } from './nodeStore'

let store: NodeStore
let repo: DiaryRepo

beforeEach(async () => {
  store = await NodeStore.temp()
  repo = new DiaryRepo(store)
  await repo.init()
})

const write = (date: string, body: string, mood?: number) =>
  repo.saveEntry({ meta: { date, ...(mood ? { mood } : {}) }, body, extra: [] })

/** 内存里的云端，只记文件名 */
function memRemote(): RemoteStore & { files: Map<string, number> } {
  const files = new Map<string, number>()
  return {
    id: 'oss', label: '内存', files,
    async list() { return [...files].map(([path, size]) => ({ path, size })) },
    async apply(up: Upload[], del: string[], onDone) {
      for (const u of up) { files.set(u.path, u.bytes.length); await onDone(u.path, 'upload') }
      for (const d of del) { files.delete(d); await onDone(d, 'delete') }
    },
    async get() { return null },
    async downloadAll() { return 0 },
    async test() {},
  }
}

describe('最近删除', () => {
  it('删除时日记和这天的图片移到 trash/，diary/ 里不再有', async () => {
    await write('2026-10-04', '今天\n\n![](../../attachments/2026/2026-10-04_1.jpg)', 4)
    await store.writeBase64('diary/attachments/2026/2026-10-04_1.jpg', 'AAAA')
    await store.writeBase64('diary/attachments/2026/2026-10-03_1.jpg', 'BBBB')
    const t = await trashEntry(repo, '2026-10-04', new Date(2026, 9, 4, 22))
    expect(t?.files).toEqual(['entries/2026/2026-10-04.md', 'attachments/2026/2026-10-04_1.jpg'])
    expect(await store.stat(entryPath('2026-10-04'))).toBeNull()
    expect(await store.stat('diary/attachments/2026/2026-10-04_1.jpg')).toBeNull()
    // 别的日子的图片不动
    expect(await store.readBase64('diary/attachments/2026/2026-10-03_1.jpg')).toBe('BBBB')
    const list = await listTrash(store)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ date: '2026-10-04', preview: '今天', mood: 4 })
  })

  it('被其他日记引用的图片留在原处', async () => {
    await write('2026-10-04', '原文')
    await write('2026-10-05', '转贴昨天的图 ![](../../attachments/2026/2026-10-04_1.jpg)')
    await store.writeBase64('diary/attachments/2026/2026-10-04_1.jpg', 'AAAA')
    await store.writeBase64('diary/attachments/2026/2026-10-04_2.jpg', 'CCCC')
    expect(await ownImages(repo, '2026-10-04')).toEqual(['attachments/2026/2026-10-04_2.jpg'])
    await trashEntry(repo, '2026-10-04')
    expect(await store.readBase64('diary/attachments/2026/2026-10-04_1.jpg')).toBe('AAAA')
    expect(await store.stat('diary/attachments/2026/2026-10-04_2.jpg')).toBeNull()
  })

  it('恢复后内容逐字节不变；这一天已有新日记时拒绝恢复', async () => {
    await write('2026-10-04', '第一版')
    const raw = await repo.readEntryRaw('2026-10-04')
    await store.writeBase64('diary/attachments/2026/2026-10-04_1.jpg', 'AAAA')
    const t = (await trashEntry(repo, '2026-10-04'))!
    await write('2026-10-04', '删除后又写的')
    await expect(restoreTrash(repo, t.id)).rejects.toThrow('已经有新写的日记')
    expect(await listTrash(store)).toHaveLength(1)
    await repo.deleteEntry('2026-10-04')
    expect(await restoreTrash(repo, t.id)).toBe('2026-10-04')
    expect(await repo.readEntryRaw('2026-10-04')).toBe(raw)
    expect(await store.readBase64('diary/attachments/2026/2026-10-04_1.jpg')).toBe('AAAA')
    expect(await listTrash(store)).toHaveLength(0)
  })

  it('超过 30 天的自动清掉，彻底删除立即生效', async () => {
    await write('2026-09-01', 'a')
    await write('2026-09-02', 'b')
    await write('2026-09-03', 'c')
    await trashEntry(repo, '2026-09-01', new Date(2026, 8, 1))
    const keep = (await trashEntry(repo, '2026-09-02', new Date(2026, 8, 20)))!
    const gone = (await trashEntry(repo, '2026-09-03', new Date(2026, 8, 25)))!
    expect(await purgeTrash(store, new Date(2026, 9, 4))).toBe(1)
    await purgeTrashItem(store, gone.id)
    expect((await listTrash(store)).map((t) => t.id)).toEqual([keep.id])
  })

  it('删除后同步会删掉云端的日记和图片；回收站本身不上传', async () => {
    const engine = new SyncEngine(repo, store)
    const remote = memRemote()
    await write('2026-10-04', '要删的')
    await write('2026-10-05', '留着的')
    await store.writeBase64('diary/attachments/2026/2026-10-04_1.jpg', 'AAAA')
    await engine.sync(remote)
    expect(remote.files.has('entries/2026/2026-10-04.md')).toBe(true)
    expect(remote.files.has('attachments/2026/2026-10-04_1.jpg')).toBe(true)
    await trashEntry(repo, '2026-10-04')
    expect(await engine.sync(remote)).toEqual({ uploaded: 0, deleted: 2 })
    expect([...remote.files.keys()].some((p) => p.includes('2026-10-04'))).toBe(false)
    expect([...remote.files.keys()].some((p) => p.startsWith('trash'))).toBe(false)
    expect(remote.files.has('entries/2026/2026-10-05.md')).toBe(true)
  })
})

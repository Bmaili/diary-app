import { beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo, entryPath, FORMAT_JSON, TMP } from '../src/core/repo'
import { parseEntry } from '../src/core/entryFile'
import { bodyFor, openSession } from '../src/core/session'
import { README_MD } from '../src/core/readme'
import { NodeStore } from './nodeStore'

let store: NodeStore
let repo: DiaryRepo

beforeEach(async () => {
  store = await NodeStore.temp()
  repo = new DiaryRepo(store)
  await repo.init()
})

describe('diary/ 文件夹', () => {
  it('初始化时生成 README.md 与 format.json', async () => {
    expect(await store.readText('diary/format.json')).toBe(FORMAT_JSON)
    expect(await store.readText('diary/README.md')).toBe(README_MD)
  })

  it('保存的日记符合格式：路径、字段顺序、时间戳', async () => {
    const now = new Date(2026, 9, 4, 21, 5, 0)
    await repo.saveEntry({ meta: { date: '2026-10-04', mood: 4, tags: ['散步'] }, body: '今天天气很好。', extra: [] }, now)
    const text = (await store.readText('diary/entries/2026/2026-10-04.md'))!
    expect(text).toMatch(
      /^---\ndate: 2026-10-04\ncreated: 2026-10-04T21:05:00[+-]\d\d:\d\d\nupdated: 2026-10-04T21:05:00[+-]\d\d:\d\d\nmood: 4\ntags: \[散步\]\n---\n\n今天天气很好。\n$/,
    )
  })

  it('正文为空时不生成文件', async () => {
    expect(await repo.saveEntry({ meta: { date: '2026-10-04', mood: 3 }, body: '  \n', extra: [] })).toBe(false)
    expect(await store.stat(entryPath('2026-10-04'))).toBeNull()
  })

  it('验收：手动加的未知字段，经 app 编辑保存后仍在', async () => {
    await store.writeText(entryPath('2026-10-01'), '---\ndate: 2026-10-01\nmy_field: 保留我\nmood: 2\n---\n\n原文\n')
    const s = await openSession(repo, '2026-10-01', { append: false })
    s.doc.body = bodyFor(s, '原文，改了一下')
    await repo.saveEntry(s.doc, new Date(2026, 9, 1, 22, 0))
    const after = (await store.readText(entryPath('2026-10-01')))!
    expect(after).toContain('my_field: 保留我')
    expect(parseEntry(after).meta.mood).toBe(2)
    expect(after.indexOf('my_field')).toBeGreaterThan(after.indexOf('updated:'))
  })

  it('created 在后续保存中保持不变，updated 更新', async () => {
    const d = { meta: { date: '2026-10-04' }, body: 'a', extra: [] }
    await repo.saveEntry(d, new Date(2026, 9, 4, 20, 0))
    const s = await openSession(repo, '2026-10-04', { append: false })
    s.doc.body = 'ab'
    await repo.saveEntry(s.doc, new Date(2026, 9, 4, 23, 0))
    const m = parseEntry((await repo.readEntryRaw('2026-10-04'))!).meta
    expect(m.created).toMatch(/T20:00:00/)
    expect(m.updated).toMatch(/T23:00:00/)
  })
})

describe('原子写入（规格 4.4 第 3 条）', () => {
  it('写完后不留下临时文件', async () => {
    await repo.saveEntry({ meta: { date: '2026-10-04' }, body: 'x', extra: [] })
    expect(await store.list(TMP)).toEqual([])
  })

  it('平台不允许重命名覆盖时也能写入', async () => {
    store.renameRefusesOverwrite = true
    await repo.saveEntry({ meta: { date: '2026-10-04' }, body: '第一版', extra: [] })
    await repo.saveEntry({ meta: { date: '2026-10-04' }, body: '第二版', extra: [] })
    expect(await store.readText(entryPath('2026-10-04'))).toContain('第二版')
  })

  it('在“删除旧文件、重命名新文件”之间被杀：下次启动从临时文件恢复', async () => {
    const tmp = `${TMP}/${entryPath('2026-10-04').replace(/\//g, '__')}.tmp`
    await store.writeText(tmp, '---\ndate: 2026-10-04\n---\n\n完整的新版本\n')
    await new DiaryRepo(store).init()
    expect(await store.readText(entryPath('2026-10-04'))).toContain('完整的新版本')
    expect(await store.list(TMP)).toEqual([])
  })

  it('临时文件写到一半被杀：目标完好则丢弃临时文件', async () => {
    await repo.saveEntry({ meta: { date: '2026-10-04' }, body: '旧版本', extra: [] })
    const tmp = `${TMP}/${entryPath('2026-10-04').replace(/\//g, '__')}.tmp`
    await store.writeText(tmp, '---\ndate: 2026-10-')
    await new DiaryRepo(store).init()
    expect(await store.readText(entryPath('2026-10-04'))).toContain('旧版本')
    expect(await store.list(TMP)).toEqual([])
  })
})

describe('同一天再次书写（规格 4.4 第 5 条）', () => {
  it('验收：第二次写作在末尾追加 ### HH:mm 段落', async () => {
    await repo.saveEntry({ meta: { date: '2026-10-04' }, body: '上午写的。', extra: [] })
    const s = await openSession(repo, '2026-10-04', { append: true, now: new Date(2026, 9, 4, 22, 40) })
    expect(s.initialText).toBe('上午写的。\n\n### 22:40\n\n')
    s.doc.body = bodyFor(s, s.initialText + '晚上又写了一段。')
    await repo.saveEntry(s.doc)
    const text = (await repo.readEntryRaw('2026-10-04'))!
    expect(text.endsWith('\n\n上午写的。\n\n### 22:40\n\n晚上又写了一段。\n')).toBe(true)
  })

  it('什么都没写就离开，不留下空标题', async () => {
    await repo.saveEntry({ meta: { date: '2026-10-04' }, body: '上午写的。', extra: [] })
    const s = await openSession(repo, '2026-10-04', { append: true, now: new Date(2026, 9, 4, 22, 40) })
    expect(bodyFor(s, s.initialText)).toBe('上午写的。')
    expect(bodyFor(s, s.initialText + '  \n')).toBe('上午写的。')
  })

  it('当天还没有日记时不加标题；从卡片打开已有日记也不加', async () => {
    const a = await openSession(repo, '2026-10-04', { append: true })
    expect(a.initialText).toBe('')
    await repo.saveEntry({ meta: { date: '2026-10-04' }, body: 'x', extra: [] })
    const b = await openSession(repo, '2026-10-04', { append: false })
    expect(b.initialText).toBe('x')
  })

  it('无法解析的文件以只读方式打开，不会被改写', async () => {
    await store.writeText(entryPath('2026-10-02'), '---\ndate: [坏\n---\n\n内容')
    const s = await openSession(repo, '2026-10-02', { append: true })
    expect(s.error).toBeTruthy()
    expect(s.initialText).toContain('内容')
  })
})

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo, entryPath } from '../src/core/repo'
import { DiaryIndex, INDEX_CACHE } from '../src/core/diaryIndex'
import { generateTestEntries } from '../src/core/testData'
import { exportDiaryZip } from '../src/core/exportZip'
import { crc32, MemorySink } from '../src/core/zipWriter'
import { toBase64 } from '../src/core/bytes'
import JSZip from 'jszip'
import { NodeStore } from './nodeStore'

async function setup() {
  const store = await NodeStore.temp()
  const repo = new DiaryRepo(store)
  await repo.init()
  return { store, repo, index: new DiaryIndex(repo, store) }
}

describe('索引（规格 4.7）', () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    s = await setup()
    await generateTestEntries(s.repo, { count: 400, endDate: '2026-10-04' })
    await s.index.load()
  })

  it('验收：删除索引后重建，搜索与日历结果不变', async () => {
    const snapshot = () => ({
      search: s.index.search({ q: '电影' }).map((h) => h.row.date),
      filtered: s.index.search({ tags: ['读书'], moods: [4, 5] }).map((h) => h.row.date),
      month: s.index.month(2026, 3).map((r) => [r.date, r.mood]),
      onThisDay: s.index.onThisDay('2026-10-04').map((r) => r.date),
      values: s.index.values('places'),
    })
    const before = snapshot()
    expect(before.search.length).toBeGreaterThan(0)
    await s.store.remove(INDEX_CACHE)
    const fresh = new DiaryIndex(s.repo, s.store)
    await fresh.load()
    s.index = fresh
    expect(snapshot()).toEqual(before)
    await fresh.rebuild()
    expect(snapshot()).toEqual(before)
  })

  it('重建时并发读文件并报告进度，结果和逐篇读一致', async () => {
    const progress: [number, number][] = []
    const fresh = new DiaryIndex(s.repo, s.store)
    await fresh.rebuild({ onProgress: (d, t) => progress.push([d, t]) })
    expect(fresh.size).toBe(s.index.size)
    expect(fresh.all().map((r) => r.hash)).toEqual(s.index.all().map((r) => r.hash))
    expect(progress[progress.length - 1]).toEqual([400, 400])
    expect(progress.length).toBe(8)
    // 有缓存时什么都不用读，也就没有进度
    const warm: number[] = []
    await new DiaryIndex(s.repo, s.store).load({ onProgress: (d) => warm.push(d) })
    expect(warm).toEqual([])
  })

  it('增量更新：只重新解析被外部修改的文件', async () => {
    const again = new DiaryIndex(s.repo, s.store)
    expect(await again.load()).toBe(0)
    const p = entryPath('2026-10-01')
    const raw = (await s.store.readText(p))!
    await new Promise((r) => setTimeout(r, 20))
    await s.store.writeText(p, raw.replace(/\n\n[\s\S]*$/, '\n\n外部编辑器加了一句：独角兽。\n'))
    await s.store.remove(entryPath('2026-09-30'))
    const third = new DiaryIndex(s.repo, s.store)
    expect(await third.load()).toBe(2)
    expect(third.search({ q: '独角兽' }).map((h) => h.row.date)).toEqual(['2026-10-01'])
    expect(third.get('2026-09-30')).toBeUndefined()
  })

  it('验收：那年今日只在往年同日有日记时出现', async () => {
    const t = await setup()
    for (const d of ['2024-10-04', '2022-10-04', '2025-10-03', '2026-10-04', '2024-02-29']) {
      await t.repo.saveEntry({ meta: { date: d }, body: `写于 ${d}`, extra: [] })
    }
    await t.index.load()
    expect(t.index.onThisDay('2026-10-04').map((r) => r.date)).toEqual(['2024-10-04', '2022-10-04'])
    expect(t.index.onThisDay('2026-10-05')).toEqual([])
    expect(t.index.onThisDay('2028-02-29').map((r) => r.date)).toEqual(['2024-02-29'])
    expect(t.index.onThisDay('2027-03-01')).toEqual([])
  })

  it('无法解析的文件进入索引并标出错误，正文仍可搜索', async () => {
    await s.store.writeText(entryPath('2020-01-01'), '---\ndate: [坏\n---\n\n恐龙')
    await s.index.load()
    expect(s.index.get('2020-01-01')?.error).toBeTruthy()
    expect(s.index.search({ q: '恐龙' }).length).toBe(1)
  })

  it('测试数据带标记，可一键识别', () => {
    expect(s.index.testRows().length).toBe(400)
  })
})

describe('搜索性能（验收：3650 篇，200 毫秒内）', () => {
  let s: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => {
    s = await setup()
    await generateTestEntries(s.repo, { count: 3650, endDate: '2026-10-04' })
    const t0 = performance.now()
    await s.index.load()
    console.log(`冷启动建索引 3650 篇：${Math.round(performance.now() - t0)} ms`)
  }, 120000)

  it.each([
    ['中文单字', '茶'],
    ['中文词语', '电影'],
    ['地点名', '江边公园'],
    ['多个词', '小王 面馆'],
  ])('%s「%s」', (_, q) => {
    const t0 = performance.now()
    const hits = s.index.search({ q })
    const ms = performance.now() - t0
    console.log(`搜索「${q}」：${hits.length} 篇，${ms.toFixed(1)} ms`)
    expect(hits.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(200)
  })

  it('命中片段高亮', () => {
    const hit = s.index.search({ q: '电影' })[0]
    expect(hit.snippet.some((g) => g.hit && g.text === '电影')).toBe(true)
  })
})

describe('导出 zip', () => {
  it('验收：zip 中的文件与 diary/ 逐字节一致（含图片），文字压缩、图片原样存', async () => {
    const s = await setup()
    await s.repo.saveEntry({ meta: { date: '2026-10-04', mood: 5, tags: ['导出'] }, body: '# 标题\n\n- 列表\n- **加粗**\n\n' + '今天去江边散步。'.repeat(200), extra: [] })
    const img = new Uint8Array(300_000).map((_, i) => (i * 7919) % 251)
    await s.store.writeBase64('diary/attachments/2026/2026-10-04_1.jpg', toBase64(img))
    const sink = new MemorySink()
    const progress: number[] = []
    const r = await exportDiaryZip(s.repo, sink, (d) => progress.push(d))
    const bytes = sink.bytes()
    expect(r).toEqual({ files: 4, bytes: bytes.length })
    expect(progress[progress.length - 1]).toBe(4)
    const zip = await JSZip.loadAsync(bytes)
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort()
    expect(names).toEqual(['diary/README.md', 'diary/attachments/2026/2026-10-04_1.jpg', 'diary/entries/2026/2026-10-04.md', 'diary/format.json'])
    expect(await zip.file('diary/entries/2026/2026-10-04.md')!.async('string')).toBe(
      await s.store.readText('diary/entries/2026/2026-10-04.md'),
    )
    expect(await zip.file('diary/attachments/2026/2026-10-04_1.jpg')!.async('uint8array')).toEqual(img)
    // 文字被压缩了，图片原样存：整个包比图片加文字的原始大小小
    const textLen = new TextEncoder().encode((await s.store.readText('diary/entries/2026/2026-10-04.md'))!).length
    expect(bytes.length).toBeLessThan(img.length + textLen)
  })

  it('CRC32 与标准值一致', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })
})

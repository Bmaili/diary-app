/** 导入日记（规格 5.12）：zip 读取、浮生记 zip、Markdown 文件夹、冲突处理 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo, entryPath } from '../src/core/repo'
import { exportDiaryZip } from '../src/core/exportZip'
import { MemorySink, ZipWriter, crc32 } from '../src/core/zipWriter'
import { bytesAccess, readZipEntries, readZipFile } from '../src/core/zipReader'
import { applyImport, findDate, planImport, type ImportFile } from '../src/core/importDiary'
import { parseEntry } from '../src/core/entryFile'
import { fromBase64, toBase64, utf8 } from '../src/core/bytes'
import { NodeStore } from './nodeStore'

let store: NodeStore
let repo: DiaryRepo

beforeEach(async () => {
  store = await NodeStore.temp()
  repo = new DiaryRepo(store)
  await repo.init()
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const sink = new MemorySink()
  const z = new ZipWriter(sink)
  for (const [name, data] of Object.entries(files)) {
    await z.add(name, typeof data === 'string' ? utf8(data) : data, { compress: typeof data === 'string' })
  }
  await z.finish()
  return sink.bytes()
}

async function filesOfZip(bytes: Uint8Array): Promise<ImportFile[]> {
  const acc = bytesAccess(bytes)
  return (await readZipEntries(acc)).filter((e) => !e.dir).map((e) => ({ path: e.name, size: e.size, read: () => readZipFile(acc, e) }))
}

/** 手工拼一个不带 UTF-8 标志、文件名是 GBK 的 zip（Windows 中文系统压的包就是这样） */
function gbkZip(nameBytes: Uint8Array, data: Uint8Array): Uint8Array {
  const crc = crc32(data)
  const local = new Uint8Array(30 + nameBytes.length + data.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint32(14, crc, true)
  lv.setUint32(18, data.length, true)
  lv.setUint32(22, data.length, true)
  lv.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30)
  local.set(data, 30 + nameBytes.length)
  const cd = new Uint8Array(46 + nameBytes.length)
  const cv = new DataView(cd.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(4, 20, true)
  cv.setUint16(6, 20, true)
  cv.setUint32(16, crc, true)
  cv.setUint32(20, data.length, true)
  cv.setUint32(24, data.length, true)
  cv.setUint16(28, nameBytes.length, true)
  cv.setUint32(42, 0, true)
  cd.set(nameBytes, 46)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, cd.length, true)
  ev.setUint32(16, local.length, true)
  const out = new Uint8Array(local.length + cd.length + end.length)
  out.set(local)
  out.set(cd, local.length)
  out.set(end, local.length + cd.length)
  return out
}

describe('读 zip', () => {
  it('读出 app 自己导出的 zip：文字（deflate）和图片（原样存）都一字不差', async () => {
    const text = '---\ndate: 2026-10-01\n---\n\n' + '很长的一段话。'.repeat(200) + '\n'
    const bytes = await zipOf({ 'diary/entries/2026/2026-10-01.md': text, 'diary/attachments/2026/2026-10-01_1.png': PNG })
    const files = await filesOfZip(bytes)
    expect(files.map((f) => f.path)).toEqual(['diary/entries/2026/2026-10-01.md', 'diary/attachments/2026/2026-10-01_1.png'])
    expect(new TextDecoder().decode(await files[0].read())).toBe(text)
    expect(await files[1].read()).toEqual(PNG)
  })

  it('没标 UTF-8 的文件名按 GBK 解', async () => {
    // “日记.md” 的 GBK 编码
    const name = new Uint8Array([0xc8, 0xd5, 0xbc, 0xc7, 0x2e, 0x6d, 0x64])
    const files = await filesOfZip(gbkZip(name, utf8('hi')))
    expect(files[0].path).toBe('日记.md')
  })

  it('不是 zip 时给出看得懂的错误', async () => {
    await expect(readZipEntries(bytesAccess(utf8('hello world, not a zip file at all')))).rejects.toThrow('不是一个 zip')
  })
})

describe('找日期', () => {
  it('认得常见写法', () => {
    expect(findDate('2024-01-02')).toBe('2024-01-02')
    expect(findDate('日记 2024_1_2 晴')).toBe('2024-01-02')
    expect(findDate('2024.01.02.md')).toBe('2024-01-02')
    expect(findDate('notes/2024/01/02')).toBe('2024-01-02')
    expect(findDate('20240102')).toBe('2024-01-02')
    expect(findDate('2024年1月2日 星期二')).toBe('2024-01-02')
    expect(findDate('2024-02-30')).toBeNull()
    expect(findDate('读书笔记')).toBeNull()
    expect(findDate('电话 13820240102')).toBeNull()
  })
})

describe('导入浮生记导出的 zip', () => {
  it('换手机：在空的手机上导入，日记和图片一字不差', async () => {
    // 在另一台“手机”上写日记并导出
    const other = new DiaryRepo(await NodeStore.temp())
    await other.init()
    await other.store.writeText(entryPath('2026-10-01'), '---\ndate: 2026-10-01\nmood: 4\nmy_field: 保留\n---\n\n去海边\n\n![日出](../../attachments/2026/2026-10-01_1.png)\n')
    await other.store.writeText(entryPath('2026-10-02'), '---\ndate: 2026-10-02\nmood: 2\n---\n')
    await other.store.writeBase64('diary/attachments/2026/2026-10-01_1.png', toBase64(PNG))
    await other.store.writeBase64('diary/attachments/2026/2026-09-30_1.png', toBase64(PNG2))
    await other.store.writeText('diary/summaries/2026-09.md', '九月总结')
    const sink = new MemorySink()
    await exportDiaryZip(other, sink)

    const plan = await planImport(await filesOfZip(sink.bytes()), repo)
    expect(plan.kind).toBe('fusheng')
    expect(plan.entries.map((e) => e.date)).toEqual(['2026-10-01', '2026-10-02'])
    expect(plan.imageCount).toBe(1)
    const r = await applyImport(plan, repo, { mode: 'keep' })
    expect(r.imported).toEqual(['2026-10-01', '2026-10-02'])
    expect(await store.readText(entryPath('2026-10-01'))).toBe(await other.store.readText(entryPath('2026-10-01')))
    expect(await store.readText(entryPath('2026-10-02'))).toBe('---\ndate: 2026-10-02\nmood: 2\n---\n')
    expect(fromBase64((await store.readBase64('diary/attachments/2026/2026-10-01_1.png'))!)).toEqual(PNG)
    // 没被引用的图片和总结也带过来
    expect(fromBase64((await store.readBase64('diary/attachments/2026/2026-09-30_1.png'))!)).toEqual(PNG2)
    expect(await store.readText('diary/summaries/2026-09.md')).toBe('九月总结')
  })

  it('同一天两边都有：默认保留手机上的；一样的跳过；图片重名而内容不同时换名字', async () => {
    await store.writeText(entryPath('2026-10-01'), '---\ndate: 2026-10-01\n---\n\n手机上的\n')
    await store.writeText(entryPath('2026-10-02'), '---\ndate: 2026-10-02\n---\n\n一样\n')
    await store.writeBase64('diary/attachments/2026/2026-10-03_1.png', toBase64(PNG2))
    const zip = await zipOf({
      'diary/format.json': '{"format_version": 1}\n',
      'diary/entries/2026/2026-10-01.md': '---\ndate: 2026-10-01\n---\n\n包里的\n',
      'diary/entries/2026/2026-10-02.md': '---\ndate: 2026-10-02\n---\n\n一样\n',
      'diary/entries/2026/2026-10-03.md': '---\ndate: 2026-10-03\n---\n\n![](../../attachments/2026/2026-10-03_1.png)\n',
      'diary/attachments/2026/2026-10-03_1.png': PNG,
    })
    const plan = await planImport(await filesOfZip(zip), repo)
    expect(plan.entries.map((e) => `${e.date}:${e.local}`)).toEqual(['2026-10-01:differ', '2026-10-02:same', '2026-10-03:none'])
    const r = await applyImport(plan, repo, { mode: 'keep' })
    expect(r).toMatchObject({ imported: ['2026-10-03'], kept: ['2026-10-01'], same: 1 })
    expect(await store.readText(entryPath('2026-10-01'))).toContain('手机上的')
    // 手机上原来的 _1 没被覆盖，导入的图换成 _2
    expect(fromBase64((await store.readBase64('diary/attachments/2026/2026-10-03_1.png'))!)).toEqual(PNG2)
    expect(fromBase64((await store.readBase64('diary/attachments/2026/2026-10-03_2.png'))!)).toEqual(PNG)
    expect(await store.readText(entryPath('2026-10-03'))).toContain('](../../attachments/2026/2026-10-03_2.png)')
  })

  it('选“接在后面”：导入的正文加“### 导入”标题接在后面，心情只在手机上没有时补上', async () => {
    await store.writeText(entryPath('2026-10-01'), '---\ndate: 2026-10-01\ntags: [工作]\n---\n\n手机上的\n')
    const zip = await zipOf({
      'diary/format.json': '{}',
      'diary/entries/2026/2026-10-01.md': '---\ndate: 2026-10-01\nmood: 3\ntags: [散步]\n---\n\n包里的\n',
    })
    const r = await applyImport(await planImport(await filesOfZip(zip), repo), repo, { mode: 'append' })
    expect(r.appended).toEqual(['2026-10-01'])
    const doc = parseEntry((await store.readText(entryPath('2026-10-01')))!, '2026-10-01')
    expect(doc.body).toBe('手机上的\n\n### 导入\n包里的')
    expect(doc.meta.mood).toBe(3)
    expect(doc.meta.tags).toEqual(['工作', '散步'])
  })
})

describe('导入 Markdown 文件夹', () => {
  it('日期从 front matter、文件名、标题里找；图片复制进来并改链接；认不出的列出来', async () => {
    const zip = await zipOf({
      'Journal/2024-01-02.md': '# 2024-01-02 星期二\n\n今天很冷。\n\n![猫](assets/cat.png)\n',
      'Journal/随笔.md': '---\ndate: 2024-01-03 21:00\ntags: [读书]\nmood: 4\nsource: obsidian\n---\n\n读完了一本书。![[cat.png]]\n',
      'Journal/旅行.md': '# 2024年1月4日\n\n到了杭州。\n\n![远处](https://example.com/a.jpg)\n![丢了](missing.png)\n',
      'Journal/assets/cat.png': PNG,
      'Journal/读书清单.md': '- 某本书\n',
      'Journal/.obsidian/workspace.md': '2024-01-05',
      '__MACOSX/Journal/._2024-01-02.md': 'x',
    })
    const plan = await planImport(await filesOfZip(zip), repo)
    expect(plan.kind).toBe('markdown')
    expect(plan.entries.map((e) => e.date)).toEqual(['2024-01-02', '2024-01-03', '2024-01-04'])
    expect(plan.unrecognized).toEqual(['Journal/读书清单.md'])
    expect(plan.imageCount).toBe(1)
    expect(plan.missingImages).toBe(1)
    const r = await applyImport(plan, repo, { mode: 'keep' })
    expect(r.imported).toHaveLength(3)

    const d2 = parseEntry((await store.readText(entryPath('2024-01-02')))!, '2024-01-02')
    expect(d2.body).toBe('今天很冷。\n\n![猫](../../attachments/2024/2024-01-02_1.png)')
    expect(fromBase64((await store.readBase64('diary/attachments/2024/2024-01-02_1.png'))!)).toEqual(PNG)

    const raw3 = (await store.readText(entryPath('2024-01-03')))!
    const d3 = parseEntry(raw3, '2024-01-03')
    expect(d3.meta).toMatchObject({ date: '2024-01-03', mood: 4, tags: ['读书'] })
    expect(raw3).toContain('source: obsidian')
    // 同一张图被两篇引用：只复制一份，两篇都指向它
    expect(d3.body).toBe('读完了一本书。![](../../attachments/2024/2024-01-02_1.png)')
    expect(await store.stat('diary/attachments/2024/2024-01-03_1.png')).toBeNull()

    const d4 = parseEntry((await store.readText(entryPath('2024-01-04')))!, '2024-01-04')
    expect(d4.body).toBe('到了杭州。\n\n![远处](https://example.com/a.jpg)\n![丢了](missing.png)')
  })

  it('同一天好几个文件合成一篇，每个文件一段；直接选的 .md 文件也能导', async () => {
    const files: ImportFile[] = [
      { path: '2024-03-01 早上.md', size: 1, read: async () => utf8('起得很早') },
      { path: '2024-03-01 晚上.md', size: 1, read: async () => utf8('---\nmood: 5\n---\n\n吃了火锅') },
      { path: '2024-03-02.txt', size: 1, read: async () => utf8('  \n') },
    ]
    const plan = await planImport(files, repo)
    expect(plan.entries).toHaveLength(1)
    expect(plan.empty).toEqual(['2024-03-02.txt'])
    await applyImport(plan, repo, { mode: 'keep' })
    const doc = parseEntry((await store.readText(entryPath('2024-03-01')))!, '2024-03-01')
    expect(doc.body).toBe('### 2024-03-01 早上\n起得很早\n\n### 2024-03-01 晚上\n吃了火锅')
    expect(doc.meta.mood).toBe(5)
  })

  it('front matter 写坏了也不丢字：整篇当正文', async () => {
    const files: ImportFile[] = [{ path: '2024-05-01.md', size: 1, read: async () => utf8('---\ntags: [a\n---\n\n正文') }]
    await applyImport(await planImport(files, repo), repo, { mode: 'keep' })
    const doc = parseEntry((await store.readText(entryPath('2024-05-01')))!, '2024-05-01')
    expect(doc.body).toContain('tags: [a')
    expect(doc.body).toContain('正文')
  })
})

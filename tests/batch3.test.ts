/** 分享进来（5.15）、朱批（4.9、5.16）、年度日记本（5.17） */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiaryRepo } from '../src/core/repo'
import { joinShare, shareFileKind, shareSummary, shareText } from '../src/core/shareIn'
import {
  annotationPath, annotationPrompt, cleanAnnotation, parseAnnotation, serializeAnnotation, type Annotation,
} from '../src/core/annotation'
import { annotateEntry } from '../src/core/llm/annotate'
import { ANNOTATE_FIXED, PROMPTS } from '../src/core/llm/prompts'
import { listTrash, restoreTrash, trashEntry, trashLetter } from '../src/core/trash'
import { bookImages, buildYearbook, cnChars, cnInt, cnYear, estimatePages, yearStats } from '../src/core/yearbook'
import type { LlmConfig } from '../src/core/llm/client'
import { startLlmMock, type LlmMock } from './mocks/llmServer'
import { NodeStore } from './nodeStore'

describe('分享进来', () => {
  it('网页分享：标题在 subject、链接在 text，拼成两行；标题已在文字里就不重复', () => {
    expect(shareText('https://example.com/a', '一篇文章')).toBe('一篇文章\nhttps://example.com/a')
    expect(shareText('一篇文章 https://example.com/a', '一篇文章')).toBe('一篇文章 https://example.com/a')
    expect(shareText('', '只有标题')).toBe('只有标题')
    expect(shareText('  一段话\r\n第二行 ', '')).toBe('一段话\n第二行')
  })

  it('接在时间标题下面不空行；接在正文后面空一行；空的直接放', () => {
    expect(joinShare('早上下了雨。\n\n### 14:32\n', 'X')).toBe('早上下了雨。\n\n### 14:32\nX\n')
    expect(joinShare('早上下了雨。', 'X')).toBe('早上下了雨。\n\nX\n')
    expect(joinShare('早上下了雨。\n\n\n', 'X')).toBe('早上下了雨。\n\nX\n')
    expect(joinShare('', 'X')).toBe('X\n')
    expect(joinShare('原文', '')).toBe('原文')
  })

  it('提示条的一句话', () => {
    expect(shareSummary(2, '一篇文章\nhttps://example.com/a')).toBe('放进了 2 张图、1 个链接和一些文字')
    expect(shareSummary(2, 'https://example.com/a')).toBe('放进了 2 张图和 1 个链接')
    expect(shareSummary(1, '')).toBe('放进了 1 张图')
    expect(shareSummary(0, '今天看到一句话')).toBe('放进了一段文字')
  })

  it('文件分类：图片、zip、其他', () => {
    expect(shareFileKind({ name: 'a.jpg', mime: 'image/jpeg' })).toBe('image')
    expect(shareFileKind({ name: 'x', mime: 'image/svg+xml' })).toBe('other')
    expect(shareFileKind({ name: 'diary.zip', mime: 'application/octet-stream' })).toBe('zip')
    expect(shareFileKind({ name: 'b', mime: 'application/x-zip-compressed' })).toBe('zip')
    expect(shareFileKind({ name: 'IMG_1.HEIC', mime: '' })).toBe('image')
    expect(shareFileKind({ name: 'a.pdf', mime: 'application/pdf' })).toBe('other')
  })
})

describe('朱批', () => {
  let store: NodeStore
  let repo: DiaryRepo
  beforeEach(async () => {
    store = await NodeStore.temp()
    repo = new DiaryRepo(store)
    await repo.init()
  })

  const A = (text: string): Annotation => ({ date: '2026-10-09', created: '2026-10-13T21:05:00+08:00', model: 'm', text, extra: [] })

  it('文件格式：front matter 加批语，读回来一样；不认识的字段保留', () => {
    const t = serializeAnnotation(A('难的一天，你没有躲开它。'))
    expect(t).toBe('---\ndate: 2026-10-09\ncreated: 2026-10-13T21:05:00+08:00\nmodel: m\n---\n\n难的一天，你没有躲开它。\n')
    expect(parseAnnotation(t, '2026-10-09')).toMatchObject({ text: '难的一天，你没有躲开它。', model: 'm' })
    const x = parseAnnotation('---\ndate: 2026-10-09\nmine: 留着\n---\n\n批语\n', '2026-10-09')
    expect(serializeAnnotation(x)).toContain('mine: 留着')
    expect(annotationPath('2026-10-09')).toBe('diary/annotations/2026/2026-10-09.md')
  })

  it('清理模型输出：引号、Markdown、换行、前缀、署名；太长截到句末', () => {
    expect(cleanAnnotation('批语：“**会上说不出的话**，\n夜里都改进了方案里。”')).toBe('会上说不出的话，夜里都改进了方案里。')
    expect(cleanAnnotation('<think>想想</think>好好睡一觉。—— 老友')).toBe('好好睡一觉。')
    const long = `${'这一天过得很满。'.repeat(12)}`
    const c = cleanAnnotation(long)
    expect(c.length).toBeLessThanOrEqual(80)
    expect(c.endsWith('。')).toBe(true)
  })

  it('用户消息：日期、心情、正文；图片换成说明；换一句时带上上一句', () => {
    const doc = { meta: { date: '2026-10-09', mood: 2 }, body: '项目评审。\n\n![会议室](../../attachments/2026/a.webp)\n\n晚上改到九点。', extra: [] }
    const p = annotationPrompt(doc)
    expect(p).toContain('日期：2026-10-09')
    expect(p).toContain('心情：不好')
    expect(p).toContain('（照片：会议室）')
    expect(p).not.toContain('attachments')
    expect(annotationPrompt(doc, '旧的一句')).toContain('上次的批语是“旧的一句”')
  })

  it('固定部分写明格式和心情不好时只陪伴，可编辑部分里没有', () => {
    expect(ANNOTATE_FIXED).toContain('不超过 60 个字')
    expect(ANNOTATE_FIXED).toContain('纯文本')
    expect(ANNOTATE_FIXED).toMatch(/“不好”或“很差”.*只陪伴/)
    expect(PROMPTS.annotate.text).not.toContain('60')
  })

  let mock: LlmMock | undefined
  afterEach(() => mock?.close())

  it('调模型：系统提示词是可编辑部分加固定部分，结果清理过', async () => {
    mock = await startLlmMock(() => ({ text: '“难的一天，你没有躲开它。”' }))
    const cfg: LlmConfig = { protocol: 'openai', baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'm', apiKey: 'k' }
    const t = await annotateEntry(cfg, { meta: { date: '2026-10-09', mood: 2 }, body: '评审不顺。', extra: [] }, '自定义规则')
    expect(t).toBe('难的一天，你没有躲开它。')
    const msgs = mock.requests[0].body.messages as { role: string; content: string }[]
    expect(msgs[0].content.startsWith('自定义规则')).toBe(true)
    expect(msgs[0].content).toContain(ANNOTATE_FIXED)
    expect(msgs[1].content).toContain('评审不顺。')
  })

  it('删除日记时朱批一起进最近删除，恢复时一起回来', async () => {
    await repo.saveEntry({ meta: { date: '2026-10-09' }, body: '今天', extra: [] })
    await store.mkdirp('diary/annotations/2026')
    await store.writeText(annotationPath('2026-10-09'), serializeAnnotation(A('批')))
    const t = await trashEntry(repo, '2026-10-09')
    expect(t!.files).toContain('annotations/2026/2026-10-09.md')
    expect(await store.stat(annotationPath('2026-10-09'))).toBeNull()
    const [item] = await listTrash(store)
    await restoreTrash(repo, item.id)
    expect(await store.readText(annotationPath('2026-10-09'))).toContain('批')
  })
})

describe('年度日记本', () => {
  const entry = (date: string, body: string, meta: Record<string, unknown> = {}) => ({ date, meta: { date, ...meta }, html: body })

  it('封面、每月一页、心情小日历、总结、朱批', () => {
    const html = buildYearbook({
      year: '2026',
      entries: [
        entry('2026-09-08', '<p>江边散步</p>', { mood: 4, weather: { text: '晴', temp_c: 19.4 }, starred: true }),
        entry('2026-10-03', '<p>国庆回家</p>', { mood: 5 }),
      ].map((e, i) => (i === 1 ? { ...e, annotation: '家里的饭最香。' } : e)),
      moods: { '2026-09-08': 4, '2026-10-03': 5 },
      monthly: { '10': '<p>十月的总结</p>' },
      yearly: '<p>这一年的总结</p>',
      photos: true,
      starredOnly: false,
      today: '2026-10-13',
      lunar: () => '农历七月十七',
    })
    expect(html).toContain('二〇二六')
    expect(html).toContain('写了 2 天')
    expect(html).toContain('2026.09.08 — 2026.10.03')
    expect(html.match(/<section class="month">/g)).toHaveLength(2)
    expect(html).toContain('<div class="mn kai">九<span class="yue">月</span></div>')
    // 月扉页：这个月的两个节气、应季的诗（九月第一个节气白露）
    expect(html).toContain('<em>白露</em>九月七日')
    expect(html).toContain('<em>秋分</em>九月二十三日')
    expect(html).toContain('九月八日<span class="wd">')
    expect(html).toContain('农历七月十七 · 晴 19° · 心情不错')
    expect(html).toContain('<span class="star" title="珍藏">藏</span>')
    // 扉页、牌记
    expect(html).toContain('浮生若梦，为欢几何。')
    expect(html).toContain('二〇二六 · 岁次丙午')
    expect(html).toContain('凡二篇')
    expect(html).toContain('二〇二六年十月十三日排印')
    expect(html).toContain('十月的总结')
    expect(html).toContain('这一年的总结')
    expect(html).toContain('家里的饭最香。')
    // 十月一日是周四：前面空三格；三号有心情色
    const oct = html.slice(html.indexOf('<div class="mn kai">十<span'))
    expect(oct.indexOf('<i class="e"></i><i class="e"></i><i class="e"></i><i>')).toBeGreaterThan(0)
    expect(oct).toContain('background:#e3a33b')
  })

  it('只要珍藏时封面写“珍藏的 N 天”，条目上不再标珍藏', () => {
    const html = buildYearbook({
      year: '2025', entries: [entry('2025-03-01', '<p>a</p>', { starred: true })], moods: {}, photos: true, starredOnly: true, today: '2026-10-13',
    })
    expect(html).toContain('珍藏的 1 天')
    expect(html).not.toContain('<span class="star"')
  })

  it('这一年：几个数、一月一枝、常去常提起；短的月度总结放在月扉页上，长的另起', () => {
    const rows = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05', '2026-03-01'].map((date, i) => ({
      date, chars: 1000 * (i + 1), images: i % 2, places: i < 3 ? ['西湖'] : ['书店'], people: i < 2 ? ['阿禾'] : [], tags: ['散步'],
    }))
    const st = yearStats(rows)
    expect(st).toMatchObject({ longest: 3, chars: 15000, photos: 2, places: ['西湖', '书店'], people: ['阿禾'], tags: ['散步'] })
    const html = buildYearbook({
      year: '2026', entries: [entry('2026-01-01', '<p>a</p>'), entry('2026-03-01', '<p>b</p>')], moods: { '2026-01-01': 5 },
      monthly: { '01': '<p>短的总结</p>', '03': `<p>${'长'.repeat(400)}</p>` },
      stats: st, photos: true, starredOnly: false, today: '2026-10-14',
    })
    expect(html).toContain('写了<b>5</b>天，最长一次连着写了<b>3</b>天')
    expect(html).toContain('<b>1.5</b>万字，存了<b>2</b>张照片')
    expect(html).toContain('常去西湖、书店；常提起阿禾；常写散步。')
    expect(html.match(/<div class="twig">/g)).toHaveLength(12)
    expect(html).toContain('<div class="msum"><p>短的总结</p></div>')
    expect(html).toContain('<div class="summary"><p class="sl">这个月</p><p>长')
  })

  it('汉字数目', () => {
    expect([10, 12, 20, 101, 110, 1010, 10086, 186000, 1000000].map(cnInt)).toEqual(
      ['十', '十二', '二十', '一百零一', '一百一十', '一千零一十', '一万零八十六', '十八万六千', '一百万'],
    )
    expect(cnChars(254)).toBe('二百五十四字')
    expect(cnChars(186432)).toBe('约十八万六千字')
  })

  it('照片：不要时去掉，要时把说明印在图下面', () => {
    const h = '<p>看海</p>\n<p><span class="figure"><img src="attachments/2026/a.webp" alt="海边"><span class="img-cap">海边</span></span></p>\n<p><img src="b.webp" alt=""></p>'
    expect(bookImages(h, false)).toBe('<p>看海</p>\n')
    const y = bookImages(h, true)
    expect(y).toContain('<span class="fig"><img src="attachments/2026/a.webp" alt="海边"><span class="cap">海边</span></span>')
    expect(y).toContain('<span class="fig"><img src="b.webp" alt=""></span>')
    expect(y.match(/海边<\/span>/g)).toHaveLength(1)
  })

  it('估页数、年份大写', () => {
    expect(cnYear('2026')).toBe('二〇二六')
    const few = estimatePages([{ chars: 300, images: 0 }], 1, true, 0)
    const many = estimatePages(Array.from({ length: 200 }, () => ({ chars: 500, images: 1 })), 12, true, 12)
    expect(few).toBeGreaterThanOrEqual(2)
    expect(many).toBeGreaterThan(250)
    expect(estimatePages(Array.from({ length: 200 }, () => ({ chars: 500, images: 1 })), 12, false, 0)).toBeLessThan(many)
  })
})

describe('随信附上的照片', () => {
  it('封存的正文：文字在前、照片在后；摘要去掉照片；找出引用的照片', async () => {
    const { letterBody, letterImages, letterText } = await import('../src/core/letters')
    const b = letterBody('  一年后的我：\n\n你好。 ', ['img/a.webp', 'img/b.jpg'])
    expect(b).toBe('一年后的我：\n\n你好。\n\n![](img/a.webp)\n\n![](img/b.jpg)')
    expect(letterBody('', ['img/a.webp'])).toBe('![](img/a.webp)')
    expect(letterImages(b)).toEqual(['img/a.webp', 'img/b.jpg'])
    expect(letterImages('![](../../attachments/2026/x.webp)')).toEqual([])
    expect(letterText(b)).toBe('一年后的我：\n\n你好。')
  })

  it('撤回、删除信时照片一起进最近删除，恢复时一起回来', async () => {
    const store = await NodeStore.temp()
    const repo = new DiaryRepo(store)
    await repo.init()
    await store.mkdirp('diary/letters/img')
    await store.writeText('diary/letters/2026-10-13_1.md', '---\nwritten: x\nopen_on: 2027-10-13\n---\n\n你好\n\n![](img/p1.webp)\n')
    await store.writeBase64('diary/letters/img/p1.webp', 'AAAA')
    await store.writeBase64('diary/letters/img/other.webp', 'BBBB')
    const t = await trashLetter(store, '2026-10-13_1', '（一封撤回的信，没拆过）', new Date(), ['img/p1.webp'])
    expect(t!.files).toEqual(['letters/2026-10-13_1.md', 'letters/img/p1.webp'])
    expect(await store.stat('diary/letters/img/p1.webp')).toBeNull()
    expect(await store.stat('diary/letters/img/other.webp')).not.toBeNull()
    await restoreTrash(repo, t!.id)
    expect(await store.readBase64('diary/letters/img/p1.webp')).toBe('AAAA')
  })
})

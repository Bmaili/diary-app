/**
 * 2026-10-13 第三批的端到端测试：分享进来、插图多选、朱批、年度日记本。
 * 截图在 e2e/out/b3-*.png（亮色、暗色）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'
import { startLlmMock, type LlmMock } from '../tests/mocks/llmServer'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4177
const BASE = `http://127.0.0.1:${PORT}/`
const DEVICE = {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' as const,
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': '*',
}

let server: ChildProcess
let browser: Browser
let llm: LlmMock

type Store = { writeText(p: string, t: string): Promise<void>; readText(p: string): Promise<string | null>; stat(p: string): Promise<unknown>; list(p: string): Promise<{ name: string }[]>; writeBase64(p: string, b: string): Promise<void> }
type W = {
  __diary: { repo: { readEntryRaw(d: string): Promise<string | null>; store: Store }; share(p: unknown): Promise<void>; prefs: Record<string, any> }
  __dialogLog: string[]
  __yearbookCapture?: (h: string) => void
  __yb?: string
}

async function forward(route: Route, url: string) {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
  const res = await route.fetch({ url, method: req.method(), headers: await req.allHeaders(), postData: req.postDataBuffer() ?? undefined })
  await route.fulfill({ status: res.status(), headers: { ...res.headers(), ...CORS }, body: await res.body() })
}

async function newPage(opts: { dark?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ ...DEVICE, colorScheme: opts.dark ? 'dark' : 'light' })
  await ctx.route(/^https:\/\/api\.deepseek\.com\//, (r) => forward(r, r.request().url().replace('https://api.deepseek.com', `http://127.0.0.1:${llm.port}`)))
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)(?!api\.deepseek\.com)/, (r) => r.abort())
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await ctx.addInitScript(autoDialog)
  await page.goto(BASE)
  await page.waitForFunction(() => (window as unknown as { __diary?: { share?: unknown } }).__diary?.share && document.querySelector('.shell'))
  return { ctx, page, errors }
}

const today = () => new Date(Date.now() - 4 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 10)

async function seed(page: Page, files: Record<string, string>, b64: Record<string, string> = {}) {
  await page.evaluate(async ([fs, bs]) => {
    const s = (window as unknown as W).__diary.repo.store
    for (const [p, t] of Object.entries(fs)) await s.writeText(p, t)
    for (const [p, t] of Object.entries(bs)) await s.writeBase64(p, t)
  }, [files, b64] as const)
  await page.reload()
  await page.waitForFunction(() => (window as unknown as { __diary?: { share?: unknown } }).__diary?.share && document.querySelector('.shell'))
}

/** 等页面里的异步条件成立（waitForFunction 不会等函数返回的 Promise） */
async function until<A>(page: Page, fn: (a: A) => Promise<boolean>, arg: A, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn, arg)) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('等不到条件成立')
}

const entry = (date: string, body: string, extra = '') => ({ [`diary/entries/${date.slice(0, 4)}/${date}.md`]: `---\ndate: ${date}\n${extra}---\n\n${body}\n` })
const raw = (page: Page, d: string) => page.evaluate((x) => (window as unknown as W).__diary.repo.readEntryRaw(x), d)
const text = (page: Page) => page.getByLabel('日记正文').inputValue()

async function addAi(page: Page) {
  await page.goto(BASE + '#/ai')
  await page.getByRole('link', { name: '添加 AI 服务' }).click()
  await page.getByRole('combobox').first().selectOption('DeepSeek')
  await page.getByLabel('模型名').fill('deepseek-test')
  await page.getByLabel('API Key').fill('sk-e2e')
  await page.getByRole('button', { name: '保存' }).click()
  await page.waitForURL(/#\/ai$/)
}

beforeAll(async () => {
  llm = await startLlmMock(() => ({ text: '你好' }), { key: 'sk-e2e' })
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  llm?.close()
})

describe('从别的 app 分享进来', () => {
  it('图片和链接接在今天后面（新起一段），可以撤销，撤销后文件一字不差、图片删掉', async () => {
    const t = today()
    const { ctx, page, errors } = await newPage()
    await seed(page, entry(t, '早上下了点雨，地铁里人特别多。', 'mood: 4\n'))
    const before = await raw(page, t)
    await page.evaluate((png) => (window as unknown as W).__diary.share({
      text: 'https://mp.weixin.qq.com/s/abc', subject: '一篇好文章', skipped: 0,
      files: [{ path: `data:image/png;base64,${png}`, name: 'a.png', mime: 'image/png', size: 70 }, { path: `data:image/png;base64,${png}`, name: 'b.png', mime: 'image/png', size: 70 }],
    }), PNG)
    await page.waitForURL(new RegExp(`#/entry/${t}\\?append=1&share=`))
    await page.getByRole('status').filter({ hasText: '放进了 2 张图、1 个链接和一些文字' }).waitFor()
    const v = await text(page)
    expect(v).toMatch(/早上下了点雨，地铁里人特别多。\n\n### \d\d:\d\d\n!\[\]\(\.\.\/\.\.\/attachments\/\d{4}\/[\d-]+_1\.webp\)\n\n!\[\]\(\.\.\/\.\.\/attachments\/\d{4}\/[\d-]+_2\.webp\)\n\n一篇好文章\nhttps:\/\/mp\.weixin\.qq\.com\/s\/abc\n$/)
    await until(page, ([d]) => (window as unknown as W).__diary.repo.readEntryRaw(d).then((r) => !!r?.includes('mp.weixin')), [t])
    await page.screenshot({ path: OUT + 'b3-01-share-in.png' })
    await page.getByRole('button', { name: '撤销分享进来的内容' }).click()
    await until(page, ([d, b]) => (window as unknown as W).__diary.repo.readEntryRaw(d).then((r) => r === b), [t, before])
    expect(await text(page)).not.toContain('mp.weixin')
    const imgs = await page.evaluate((y) => (window as unknown as W).__diary.repo.store.list(`diary/attachments/${y}`), t.slice(0, 4))
    expect(imgs.length).toBe(0)
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('今天还没写：分享的文字成为今天的日记；撤销后这天又没有了；暗色截图', async () => {
    const t = today()
    const { ctx, page, errors } = await newPage({ dark: true })
    await page.evaluate(() => (window as unknown as W).__diary.share({ text: '今天看到一句话：慢慢来，比较快。', subject: '', files: [], skipped: 1 }))
    await page.getByRole('status').filter({ hasText: '放进了一段文字，有 1 个没收下' }).waitFor()
    expect(await text(page)).toBe('今天看到一句话：慢慢来，比较快。\n')
    await until(page, ([d]) => (window as unknown as W).__diary.repo.readEntryRaw(d).then((r) => !!r?.includes('慢慢来')), [t])
    await page.screenshot({ path: OUT + 'b3-02-share-in-dark.png' })
    await page.getByRole('button', { name: '撤销分享进来的内容' }).click()
    // 等它出现在最近删除里
    await until(page, ([d]) => {
      const s = (window as unknown as W).__diary.repo.store
      const rel = `entries/${d.slice(0, 4)}/${d}.md`
      return s.list('trash').then(async (l) => {
        for (const x of l) if ((await s.readText(`trash/${x.name}/${rel}`)) != null) return (await s.readText(`diary/${rel}`)) == null
        return false
      })
    }, [t])
    // 接着写字就没有撤销了
    await page.evaluate(() => (window as unknown as W).__diary.share({ text: '第二次', subject: '', files: [], skipped: 0 }))
    await page.waitForURL(/share=2/)
    await page.getByRole('button', { name: '撤销分享进来的内容' }).waitFor()
    await page.getByLabel('日记正文').press('End')
    await page.keyboard.type('后来写的')
    await page.getByRole('button', { name: '撤销分享进来的内容' }).waitFor({ state: 'detached' })
    expect(await text(page)).toBe('第二次\n后来写的')
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('zip 分享进来走导入；收不了的东西给提示', async () => {
    const { ctx, page, errors } = await newPage()
    const zip = new JSZip()
    zip.file('diary/entries/2024/2024-02-03.md', '---\ndate: 2024-02-03\nmood: 3\n---\n\n分享进来的旧日记。\n')
    const b64 = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64')
    await page.evaluate((b) => (window as unknown as W).__diary.share({
      text: '', subject: '', skipped: 0, files: [{ path: `data:application/zip;base64,${b}`, name: '浮生记备份.zip', mime: 'application/zip', size: 100 }],
    }), b64)
    await page.waitForURL(/#\/settings\/import$/)
    await page.getByText('浮生记备份.zip').waitFor()
    await page.getByText(/1 篇/).first().waitFor()
    await page.screenshot({ path: OUT + 'b3-03-share-zip.png' })
    await page.evaluate(() => (window as unknown as W).__diary.share({
      text: '', subject: '', skipped: 0, files: [{ path: 'data:application/pdf;base64,AAAA', name: 'a.pdf', mime: 'application/pdf', size: 3 }],
    }))
    await page.waitForFunction(() => (window as unknown as W).__dialogLog.some((t) => t.includes('收不了这个')))
    expect(errors).toEqual([])
    await ctx.close()
  })
})

describe('插图多选', () => {
  it('浏览器里“从相册选”用选文件，可以一次插好几张，不弹说明框；有“用系统的选择器”', async () => {
    const { ctx, page, errors } = await newPage()
    writeFileSync(OUT + 'b3-a.png', Buffer.from(PNG, 'base64'))
    writeFileSync(OUT + 'b3-b.png', Buffer.from(PNG, 'base64'))
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByLabel('日记正文').fill('三张图里的两张。')
    await page.getByRole('button', { name: '插图' }).click()
    await page.getByRole('button', { name: '用系统的选择器' }).waitFor()
    await page.screenshot({ path: OUT + 'b3-04-image-source.png' })
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /从相册选/ }).click()
    const fc = await chooser
    expect(fc.isMultiple()).toBe(true)
    await fc.setFiles([OUT + 'b3-a.png', OUT + 'b3-b.png'])
    await page.waitForFunction(() => ((document.querySelector('textarea') as HTMLTextAreaElement).value.match(/!\[\]/g) ?? []).length === 2)
    await expect(page.locator('.sheet').filter({ hasText: '图片说明' }).count()).resolves.toBe(0)
    expect(errors).toEqual([])
    await ctx.close()
  })
})

describe('朱批', () => {
  it('请批、换一句、删去；AI 不读的那篇没有“请批”；提示词在系统提示词里能改', async () => {
    let n = 0
    llm.script = ({ turns }) => {
      n++
      const u = turns[turns.length - 1]?.text ?? ''
      return { text: u.includes('上次的批语') ? '“晚上改到九点，改完反而不糟——这份笃定是你自己挣来的。”' : '会上说不出的话，夜里都改进了方案里。难的一天，你没有躲开它。' }
    }
    const { ctx, page, errors } = await newPage()
    await seed(page, {
      ...entry('2026-10-09', '项目评审，方案被挑了不少问题。会上没说出话来，回来路上一直在想当时应该怎么回。\n\n晚上和阿杰一起改到九点，改完反而觉得没那么糟。', 'mood: 2\nweather:\n  text: 晴\n  temp_c: 19\n'),
      ...entry('2026-10-08', '不想给 AI 看的一篇。', 'ai_exclude: true\n'),
    })
    await addAi(page)
    await page.goto(BASE + '#/entry/2026-10-08')
    await page.locator('.reading').waitFor()
    await expect(page.getByRole('button', { name: '请批' }).count()).resolves.toBe(0)
    await page.goto(BASE + '#/entry/2026-10-09')
    await page.getByRole('button', { name: '请批' }).click()
    await page.getByText('难的一天，你没有躲开它。').waitFor()
    const file = await page.evaluate(() => (window as unknown as W).__diary.repo.store.readText('diary/annotations/2026/2026-10-09.md'))
    expect(file).toMatch(/^---\ndate: 2026-10-09\ncreated: .+\nmodel: deepseek-test\n---\n\n会上说不出的话/)
    const req = llm.requests[llm.requests.length - 1].body as { messages: { content: string }[] }
    expect(req.messages[0].content).toContain('只陪伴和体谅')
    expect(req.messages[1].content).toContain('心情：不好')
    await page.screenshot({ path: OUT + 'b3-05-zhupi.png', fullPage: true })
    await page.getByRole('button', { name: '换一句' }).click()
    await page.getByText('这份笃定是你自己挣来的。').waitFor()
    expect((llm.requests[llm.requests.length - 1].body as { messages: { content: string }[] }).messages[1].content).toContain('上次的批语是“会上说不出的话')
    expect(n).toBe(2)
    await page.getByRole('button', { name: '删去' }).click()
    await page.getByRole('button', { name: '请批' }).waitFor()
    expect(await page.evaluate(() => (window as unknown as W).__diary.repo.store.stat('diary/annotations/2026/2026-10-09.md'))).toBeNull()
    // 提示词：可编辑，固定部分写着格式和心情规则
    await page.goto(BASE + '#/settings/ai/prompt/annotate')
    await page.getByText('不超过 60 个字').first().waitFor()
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('暗色下的朱批', async () => {
    const { ctx, page } = await newPage({ dark: true })
    await seed(page, {
      ...entry('2026-10-09', '晚上和阿杰一起改到九点，改完反而觉得没那么糟。', 'mood: 2\n'),
      'diary/annotations/2026/2026-10-09.md': '---\ndate: 2026-10-09\n---\n\n难的一天，你没有躲开它。\n',
    })
    await page.goto(BASE + '#/entry/2026-10-09')
    await page.getByText('难的一天，你没有躲开它。').waitFor()
    // 没配 AI 服务：已有的批语照常显示，可以删，不能换
    await expect(page.getByRole('button', { name: '换一句' }).count()).resolves.toBe(0)
    await page.getByRole('button', { name: '删去' }).waitFor()
    await page.screenshot({ path: OUT + 'b3-06-zhupi-dark.png' })
    await ctx.close()
  })
})

describe('年度日记本', () => {
  it('从日历页进来，选年份和范围，排出来的网页带日记、照片、总结、朱批', async () => {
    const { ctx, page, errors } = await newPage()
    await seed(page, {
      ...entry('2026-09-08', '下班后去江边公园散步，风很舒服。\n\n![江边](../../attachments/2026/2026-09-08_1.png)', 'mood: 4\nstarred: true\n'),
      ...entry('2026-10-03', '国庆回家，吃了妈妈做的饭。', 'mood: 5\n'),
      ...entry('2025-05-01', '去年的一篇。', 'mood: 3\n'),
      'diary/summaries/monthly/2026-10.md': '---\ntype: monthly-summary\nperiod: 2026-10\n---\n\n十月你回了一趟家。\n',
      'diary/annotations/2026/2026-10-03.md': '---\ndate: 2026-10-03\n---\n\n家里的饭最香。\n',
    }, { 'diary/attachments/2026/2026-09-08_1.png': PNG })
    await page.goto(BASE + '#/calendar')
    await page.getByRole('link', { name: /年度日记本/ }).click()
    await page.waitForURL(/#\/yearbook$/)
    await page.getByRole('radio', { name: '2025' }).waitFor()
    await page.getByText(/约 \d+ 页/).waitFor()
    await page.screenshot({ path: OUT + 'b3-07-yearbook.png' })
    await page.evaluate(() => {
      const w = window as unknown as W
      w.__yearbookCapture = (h) => (w.__yb = h)
    })
    await page.getByRole('button', { name: '排版并打印 / 存为 PDF' }).click()
    await page.waitForFunction(() => !!(window as unknown as W).__yb)
    const html = await page.evaluate(() => (window as unknown as W).__yb!)
    expect(html).toContain('二〇二六')
    expect(html).toContain('写了 2 天')
    expect(html).toContain('江边公园')
    expect(html).toContain('data:image/')
    expect(html).toContain('<span class="cap">江边</span>')
    expect(html).toContain('十月你回了一趟家。')
    expect(html).toContain('家里的饭最香。')
    expect(html).not.toContain('去年的一篇')
    // 只要珍藏、不要照片
    await page.getByRole('button', { name: '只要珍藏' }).click()
    await page.getByRole('switch', { name: '放进照片' }).click()
    await page.evaluate(() => ((window as unknown as W).__yb = undefined))
    await page.getByRole('button', { name: '排版并打印 / 存为 PDF' }).click()
    await page.waitForFunction(() => !!(window as unknown as W).__yb)
    const h2 = await page.evaluate(() => (window as unknown as W).__yb!)
    expect(h2).toContain('珍藏的 1 天')
    expect(h2).not.toContain('<img')
    expect(h2).not.toContain('国庆回家')
    // 排出来的书用 Chromium 打成 PDF 看看（和安卓系统打印用的是同一个排版引擎）
    const book = await ctx.newPage()
    await book.setContent(html)
    await book.pdf({ path: OUT + 'b3-08-yearbook.pdf', preferCSSPageSize: true })
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('暗色的日历页和年度日记本', async () => {
    const { ctx, page } = await newPage({ dark: true })
    await seed(page, entry('2026-10-03', '国庆回家。', 'mood: 5\n'))
    await page.goto(BASE + '#/calendar')
    await page.getByRole('link', { name: /年度日记本/ }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: OUT + 'b3-09-calendar-dark.png', fullPage: true })
    await page.getByRole('link', { name: /年度日记本/ }).click()
    await page.getByText(/约 \d+ 页/).waitFor()
    await page.screenshot({ path: OUT + 'b3-10-yearbook-dark.png' })
    await ctx.close()
  })
})

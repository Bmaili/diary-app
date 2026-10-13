/**
 * 2026-10-13 第四批：信里附照片、日历点年月跳转、设置页重新分组、防止截屏。
 * 截图在 e2e/out/b4-*.png（亮色、暗色）。
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
const PORT = 4178
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

describe('信里附照片', () => {
  it('写信时附上照片、去掉一张、封存；照片存在 letters/img/', async () => {
    const { ctx, page, errors } = await newPage()
    writeFileSync(OUT + 'b4-a.png', Buffer.from(PNG, 'base64'))
    writeFileSync(OUT + 'b4-b.png', Buffer.from(PNG, 'base64'))
    await page.goto(BASE + '#/letters/new')
    await page.getByPlaceholder(/一年后的我/).fill('一年后的我：\n\n这是今天窗外的样子。')
    await page.getByRole('button', { name: '附上照片' }).click()
    await page.getByRole('dialog', { name: '附上照片' }).waitFor()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /从相册选/ }).click()
    await (await chooser).setFiles([OUT + 'b4-a.png', OUT + 'b4-b.png'])
    await page.waitForFunction(() => document.querySelectorAll('.ph img').length === 2)
    const imgs = await page.evaluate(() => (window as unknown as W).__diary.prefs.letterDraft.images as string[])
    expect(imgs).toHaveLength(2)
    await page.screenshot({ path: OUT + 'b4-01-letter-photos.png' })
    await page.getByRole('button', { name: '去掉这张照片' }).first().click()
    await page.waitForFunction(() => document.querySelectorAll('.ph img').length === 1)
    await until(page, (p) => (window as unknown as W).__diary.repo.store.stat(`diary/letters/${p}`).then((x) => x == null), imgs[0])
    await page.getByRole('button', { name: '封存' }).click()
    await page.waitForURL(/#\/letters$/)
    const raw = await page.evaluate(() => (window as unknown as W).__diary.repo.store.list('diary/letters'))
    const md = raw.map((f) => f.name).find((n) => n.endsWith('.md'))!
    const text = await page.evaluate((n) => (window as unknown as W).__diary.repo.store.readText(`diary/letters/${n}`), md)
    expect(text).toContain(`这是今天窗外的样子。\n\n![](${imgs[1]})\n`)
    expect(await page.evaluate(() => (window as unknown as W).__diary.prefs.letterDraft.images.length)).toBe(0)
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('拆开的信里能看到照片，点开看大图（没有分享按钮）；暗色', async () => {
    const { ctx, page, errors } = await newPage({ dark: true })
    await seed(page, {
      'diary/letters/2025-10-01_1.md': '---\nwritten: 2025-10-01T21:00:00+08:00\nopen_on: 2026-10-01\n---\n\n一年前的我：\n\n记得去看海。\n\n![](img/2025-10-01_sea.png)\n',
    }, { 'diary/letters/img/2025-10-01_sea.png': PNG })
    await page.goto(BASE + '#/letters/2025-10-01_1')
    await page.locator('.letter-body img[src^="data:"]').waitFor()
    await page.screenshot({ path: OUT + 'b4-02-letter-read-dark.png' })
    await page.locator('.letter-body img').click()
    await page.locator('.viewer, [role="dialog"]').first().waitFor()
    await expect(page.getByRole('button', { name: '分享' }).count()).resolves.toBe(0)
    expect(errors).toEqual([])
    await ctx.close()
  })
})

describe('日历点年月跳转', () => {
  it('点“10 月 2026”弹出年月，选 2025 年 5 月就跳过去', async () => {
    for (const dark of [false, true]) {
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, { ...entry('2025-05-03', '五月的一篇。', 'mood: 4\n'), ...entry('2025-05-04', '又一篇。') })
      await page.goto(BASE + '#/calendar')
      await page.getByRole('button', { name: /点一下选年月/ }).click()
      await page.getByRole('radio', { name: '2025' }).click()
      await page.getByRole('button', { name: '2025 年 5 月，写了 2 天' }).waitFor()
      await page.screenshot({ path: OUT + `b4-03-calendar-jump${dark ? '-dark' : ''}.png` })
      await page.getByRole('button', { name: '2025 年 5 月，写了 2 天' }).click()
      await page.getByRole('button', { name: '2025 年 5 月，点一下选年月' }).waitFor()
      await page.getByText('这个月写了').waitFor()
      expect(await page.locator('.summary strong').first().textContent()).toBe('2')
      expect(errors).toEqual([])
      await ctx.close()
    }
  })
})

describe('设置页', () => {
  it('分组：数据、写日记、首页与日历、AI、隐私、维护；防止截屏默认打开', async () => {
    for (const dark of [false, true]) {
      const { ctx, page, errors } = await newPage({ dark })
      await page.goto(BASE + '#/settings')
      await page.getByRole('heading', { name: '隐私' }).waitFor()
      const groups = await page.locator('.settings section > h2').allTextContents()
      expect(groups).toEqual(['数据', '写日记', '首页与日历', 'AI', '隐私', '维护'])
      expect(await page.getByRole('switch', { name: '防止截屏' }).getAttribute('aria-checked')).toBe('true')
      await page.screenshot({ path: OUT + `b4-04-settings${dark ? '-dark' : ''}.png`, fullPage: true })
      expect(errors).toEqual([])
      await ctx.close()
    }
  })
})

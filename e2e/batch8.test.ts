/**
 * 2026-10-19 第二批的端到端测试：返回键先关底部面板、新版本弹窗、首页右上角的搜索。
 * 截图在 e2e/out/b8-*.png（亮色、暗色）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { startLlmMock, type LlmMock } from '../tests/mocks/llmServer'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4182
const BASE = `http://127.0.0.1:${PORT}/`
const DEVICE = {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' as const,
}
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': '*',
}

let server: ChildProcess
let browser: Browser
let llm: LlmMock

type W = { __diary: { repo: { store: { writeText(p: string, t: string): Promise<void>; readText(p: string): Promise<string | null> } } } }

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
  await page.waitForFunction(() => (window as unknown as { __diary?: unknown }).__diary && document.querySelector('.shell'))
  return { ctx, page, errors }
}

const today = () => new Date(Date.now() - 4 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 10)
const year = () => today().slice(0, 4)

const AI = 'ai:\n  extracted_at: 2099-01-01T00:00:00+08:00\n  model: test\n'
const entry = (date: string, body: string, meta: string) => ({
  [`diary/entries/${date.slice(0, 4)}/${date}.md`]: `---\ndate: ${date}\nupdated: ${date}T21:00:00+08:00\n${meta}${AI}---\n\n${body}\n`,
})

/** 一年里和阿禾、外婆、西湖有关的几天（虚构） */
function diary(): Record<string, string> {
  const y = year()
  return {
    ...entry(`${y}-01-05`, '和阿禾第一次去旧书店。', 'mood: 3\npeople: [阿禾]\nplaces: [旧书店]\ntags: [读书]\n'),
    ...entry(`${y}-03-16`, '阿禾说春天要去看樱花。', 'mood: 4\npeople: [阿禾]\nplaces: [西湖]\ntags: [散步]\n'),
    ...entry(`${y}-06-02`, '加班到很晚。', 'mood: 2\ntags: [工作]\n'),
    ...entry(`${y}-09-08`, '凌晨四点和阿禾出门，海边风很大。今年最开心的一天，大概就是这一天了。', 'mood: 5\npeople: [阿禾]\nplaces: [海边]\ntags: [散步]\nstarred: true\n'),
    ...entry(`${y}-09-20`, '去外婆家，吃了桂花糖。', 'mood: 4\npeople: [外婆]\nplaces: [外婆家]\ntags: [家]\n'),
    ...entry(`${y}-10-02`, '晚上和阿禾在西湖边走了一圈，她说起外婆家门口的桂树。', 'mood: 4\npeople: [阿禾, 外婆]\nplaces: [西湖]\ntags: [散步]\n'),
    ...entry(`${y}-10-05`, '和阿禾在西湖边喝茶。', 'mood: 4\npeople: [阿禾]\nplaces: [西湖]\ntags: [散步]\n'),
    ...entry(`${y}-10-06`, '又去西湖走了走，一个人。', 'mood: 3\nplaces: [西湖]\ntags: [散步]\n'),
    ...entry(`${y}-10-07`, '在家读书，读完了一本。', 'mood: 3\ntags: [读书]\n'),
    ...entry(`${y}-10-09`, '不想给 AI 看的一篇，和阿禾吵了一架。', 'mood: 1\npeople: [阿禾]\nai_exclude: true\n'),
  }
}

async function seed(page: Page, files: Record<string, string>) {
  await page.evaluate(async (fs) => {
    const s = (window as unknown as W).__diary.repo.store
    for (const [p, t] of Object.entries(fs)) await s.writeText(p, t)
  }, files)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('.shell'))
}

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
  await llm?.close()
})



type D = { __diary: Record<string, unknown> }
const back = (page: Page) => page.evaluate(() => ((window as unknown as D).__diary.back as () => void)())

describe('返回键、更新弹窗、首页右上角（2026-10-19）', () => {
  it('返回键先关底部面板，再按才离开页面', async () => {
    const { ctx, page, errors } = await newPage()
    await seed(page, diary())
    await addAi(page)
    await page.getByRole('button', { name: /陪你聊的是老友/ }).click()
    await page.getByRole('dialog', { name: '谁来陪你聊' }).waitFor()
    await back(page)
    await page.getByRole('dialog', { name: '谁来陪你聊' }).waitFor({ state: 'detached' })
    expect(page.url()).toMatch(/#\/ai$/)
    // 以前的对话：同样先关面板
    await page.getByRole('button', { name: '以前的对话' }).click()
    await page.getByRole('dialog', { name: '以前的对话' }).waitFor()
    await back(page)
    await page.getByRole('dialog', { name: '以前的对话' }).waitFor({ state: 'detached' })
    expect(page.url()).toMatch(/#\/ai$/)
    // 没有面板了：底部导航的页面回到首页
    await back(page)
    await page.waitForURL(/#\/$/)
    expect(errors).toEqual([])
    await ctx.close()
  })

  for (const dark of [false, true]) {
    it(`有新版时弹窗：“暂不”后这一版不再弹；写日记时不弹；可以关掉${dark ? '（暗色）' : ''}`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, diary())
      // 这里要自己点弹窗里的按钮
      await page.evaluate(() => ((window as unknown as { __noAutoDialog: boolean }).__noAutoDialog = true))
      const prompt = () => page.evaluate(() => ((window as unknown as D).__diary.promptUpdate as () => Promise<void>)())
      const setLatest = (v: string) => page.evaluate((ver) => {
        const u = (window as unknown as D).__diary.updateState as Record<string, unknown>
        u.latest = { version: ver, notes: '灯下可以换人陪你聊；回答下面有“接着问”。\n- 搜索挪到了右上角', publishedAt: '', pageUrl: '' }
      }, v)
      // 首页右上角：同步、搜索、设置；“写今天”旁边不再有搜索按钮
      await expect(page.locator('.topbar .acts a').evaluateAll((as) => as.map((a) => a.getAttribute('aria-label')))).resolves
        .toEqual([expect.stringMatching(/同步/), '搜索', '设置'])
      expect(await page.locator('.fab-search').count()).toBe(0)
      await page.screenshot({ path: OUT + `b8-01-home${dark ? '-dark' : ''}.png` })

      await setLatest('9.9.9')
      void prompt()
      const dlg = page.getByRole('alertdialog', { name: '新版本 9.9.9' })
      await dlg.waitFor()
      await dlg.getByText('覆盖安装，日记不会丢。').waitFor()
      await page.screenshot({ path: OUT + `b8-02-update${dark ? '-dark' : ''}.png` })
      await dlg.getByRole('button', { name: '暂不' }).click()
      await dlg.waitFor({ state: 'detached' })
      // 这一版不再弹
      await prompt()
      expect(await page.getByRole('alertdialog').count()).toBe(0)

      // 更新的一版：写日记的页面上不弹
      await setLatest('9.9.10')
      await page.goto(BASE + `#/entry/${today()}`)
      await page.getByLabel('日记正文').waitFor()
      await prompt()
      expect(await page.getByRole('alertdialog').count()).toBe(0)
      // 关掉“有新版时弹窗提醒”后也不弹
      await page.goto(BASE + '#/settings/about')
      await page.getByRole('switch', { name: '有新版时弹窗提醒' }).click()
      await page.goto(BASE + '#/')
      await prompt()
      expect(await page.getByRole('alertdialog').count()).toBe(0)
      // 打开后在首页弹，“更新”去关于页
      await page.goto(BASE + '#/settings/about')
      await page.getByRole('switch', { name: '有新版时弹窗提醒' }).click()
      await page.screenshot({ path: OUT + `b8-03-about${dark ? '-dark' : ''}.png`, fullPage: true })
      await page.goto(BASE + '#/')
      void prompt()
      await page.getByRole('alertdialog', { name: '新版本 9.9.10' }).getByRole('button', { name: '更新' }).click()
      await page.waitForURL(/#\/settings\/about$/)
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

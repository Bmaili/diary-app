/**
 * 2026-10-15 这一批的端到端测试：AI 页的推荐问题、收藏常问、回答里的引文核对和日记小笺、人名地名、
 * 人物小传和“请 AI 写几句”、词表点开小传 / 选择合并。截图在 e2e/out/b6-*.png（亮色、暗色）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { startLlmMock, type LlmMock } from '../tests/mocks/llmServer'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4180
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

describe('AI 页：推荐问题、引文、小笺、收藏', () => {
  for (const dark of [false, true]) {
    it(`问一个推荐的问题，收藏后在首屏再问一次${dark ? '（暗色）' : ''}`, async () => {
      const y = year()
      let asked = 0
      llm.script = ({ system }) => {
        asked++
        // 系统提示词里有引文的写法
        expect(system).toContain('—— YYYY-MM-DD')
        return {
          text: `今年有 **4** 天写到和阿禾见面，十月最多。你们常去西湖边走走。\n\n心情最好的是 ${y}-09-08 去海边，那天你写：\n\n> “今年最开心的一天，大概就是这一天了。”\n> —— ${y}-09-07\n\n> 我们约好明年再去一次。\n> —— ${y}-09-08\n\n相关日期：${y}-09-08、${y}-10-02、${y}-10-05、${y}-03-16、${y}-01-05`,
        }
      }
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, diary())
      await addAi(page)
      // 首屏：从日记里出的题（人名、地名都来自标注）
      await page.locator('.sugs .sug').first().waitFor()
      const sugs = await page.locator('.sugs .sug').allTextContents()
      expect(sugs.length).toBeGreaterThanOrEqual(3)
      expect(sugs.join('|')).toMatch(/阿禾|外婆|西湖|散步|读书/)
      await page.getByText('回答里点问题旁边的星').waitFor()
      await page.screenshot({ path: OUT + `b6-01-hello${dark ? '-dark' : ''}.png` })
      await page.getByRole('button', { name: '换一批' }).click()

      await page.getByLabel('问题').fill('今年和阿禾见了几次？')
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.turn .a blockquote.yin').waitFor()
      // 原文里找得到的排成引文，日子标成真正的那一天；编的那句当普通文字
      await expect(page.locator('blockquote.yin').count()).resolves.toBe(1)
      await expect(page.locator('blockquote.yin cite').textContent()).resolves.toBe('九月八日')
      await expect(page.locator('blockquote.yin cite a').getAttribute('href')).resolves.toBe(`#/entry/${y}-09-08`)
      await page.locator('.turn .a').getByText('我们约好明年再去一次。').waitFor()
      // “相关日期”那一行变成小笺，三条以后折叠
      expect(await page.locator('.turn .a').textContent()).not.toContain('相关日期')
      await expect(page.locator('.note-row').count()).resolves.toBe(3)
      await page.getByRole('button', { name: '还有 2 天' }).waitFor()
      // 人名地名可以点
      await expect(page.locator('.turn .a a.who').first().textContent()).resolves.toBe('阿禾')
      // 收藏这个问题
      await page.getByRole('button', { name: '收藏这个问题' }).click()
      await page.getByRole('button', { name: '不再收藏这个问题' }).waitFor()
      await page.screenshot({ path: OUT + `b6-02-answer${dark ? '-dark' : ''}.png`, fullPage: true })

      // 新对话：首屏多了“常问的”
      await page.getByRole('button', { name: '新对话' }).click()
      await page.getByText('常问的').waitFor()
      await page.locator('.pin').getByText(/答“今年有 4 天写到和阿禾见面/).waitFor()
      await page.screenshot({ path: OUT + `b6-03-pinned${dark ? '-dark' : ''}.png` })
      const before = asked
      await page.locator('.pin').getByRole('button', { name: '再问一次' }).click()
      await page.locator('.turn .q').getByText('今年和阿禾见了几次？').waitFor()
      await page.locator('.note-row').first().waitFor()
      expect(asked).toBeGreaterThan(before)
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

describe('小传', () => {
  for (const dark of [false, true]) {
    it(`从回答里点人名打开小传，请 AI 写几句${dark ? '（暗色）' : ''}`, async () => {
      const y = year()
      let portraitReq = ''
      llm.script = ({ system, turns }) => {
        if (system.includes('不超过 120 个字')) {
          portraitReq = turns[turns.length - 1]?.text ?? ''
          return { text: '“你们常在西湖边走到很晚。九月那天凌晨出门看海，是你这一年最开心的一天。”' }
        }
        return { text: `你和阿禾今年常见面。\n\n相关日期：${y}-10-02` }
      }
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, diary())
      await addAi(page)
      await page.getByLabel('问题').fill('阿禾')
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.turn .a a.who').first().click()
      await page.waitForURL(/#\/who\/people\//)
      await page.locator('.seal').getByText('阿禾').waitFor()
      // 天数包括设了不让 AI 读的那篇（只在手机上算），发给 AI 的不包括
      await page.locator('.facts').getByText('今年写到的天数').waitFor()
      await expect(page.locator('.facts b').first().textContent()).resolves.toBe('6')
      await page.getByText('常一起去').waitFor()
      await page.getByRole('button', { name: /请 AI 写几句“你和阿禾的这些日子”/ }).getByText('会把提到阿禾的 5 篇日记发给').waitFor()
      await page.screenshot({ path: OUT + `b6-04-who${dark ? '-dark' : ''}.png` })
      await page.getByRole('button', { name: /请 AI 写几句/ }).click()
      await page.locator('.portrait').getByText('你们常在西湖边走到很晚。').waitFor()
      expect(portraitReq).toContain('一共写到 5 天')
      expect(portraitReq).not.toContain('吵了一架')
      // 本机存下来，回来还在
      expect(await page.evaluate(async () => (await (window as unknown as W).__diary.repo.store.readText('ai/portraits.json')) ?? '')).toContain('西湖边')
      await page.screenshot({ path: OUT + `b6-05-who-portrait${dark ? '-dark' : ''}.png`, fullPage: true })
      // 常一起出现的点开是另一个小传
      await page.locator('.with').getByRole('link', { name: /西湖/ }).click()
      await page.waitForURL(/#\/who\/places\//)
      await page.locator('.facts').getByText('常一起来').waitFor()
      expect(errors).toEqual([])
      await ctx.close()
    })
  }

  it('词表：点一下打开小传；“选择”后点选，合并按钮出现', async () => {
    const { ctx, page, errors } = await newPage()
    await seed(page, diary())
    await addAi(page)
    await page.goto(BASE + '#/ai?tab=tidy')
    await page.locator('.vals').getByRole('button', { name: /西湖/ }).click()
    await page.waitForURL(/#\/who\/places\//)
    await page.goBack()
    await page.getByRole('button', { name: '选择' }).click()
    await page.locator('.vals').getByRole('button', { name: /西湖/ }).click()
    await page.locator('.vals').getByRole('button', { name: /海边/ }).click()
    await page.getByRole('button', { name: '合并这 2 个' }).waitFor()
    expect(page.url()).toMatch(/tab=tidy/)
    await page.screenshot({ path: OUT + 'b6-06-vocab-select.png' })
    await page.getByRole('button', { name: '取消选择' }).click()
    await page.getByRole('button', { name: '选择' }).waitFor()
    expect(errors).toEqual([])
    await ctx.close()
  })
})

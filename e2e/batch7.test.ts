/**
 * 2026-10-19 这一批的端到端测试：灯下（原来的 AI 页）的人物、首屏问候、接着问、自己添加的人物。
 * 截图在 e2e/out/b7-*.png（亮色、暗色）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { startLlmMock, type LlmMock } from '../tests/mocks/llmServer'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4181
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


describe('灯下：人物、问候、接着问', () => {
  for (const dark of [false, true]) {
    it(`换人物、点接着问、添加自己的人物${dark ? '（暗色）' : ''}`, async () => {
      const y = year()
      const systems: string[] = []
      llm.script = ({ system }) => {
        systems.push(system)
        const cat = system.includes('## 这次陪他聊的是：猫')
        return {
          text: cat
            ? `喵。${y}-10-05 你们在西湖边喝茶，回来身上一股茶味。\n\n相关日期：${y}-10-05\n接着问：那天还聊了什么？｜我们常去哪家茶馆？`
            : `你们十月去了好几回西湖，${y}-10-02 那晚她还说起外婆家门口的桂树。\n\n相关日期：${y}-10-02、${y}-10-05\n接着问：第一次和阿禾去西湖是什么时候？｜外婆家的桂树还开吗？`,
        }
      }
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, diary())
      await addAi(page)
      // 底部导航叫“灯下”，页面标题也是
      await page.getByRole('link', { name: '灯下' }).waitFor()
      await page.locator('.topbar h1').getByText('灯下').waitFor()
      // 输入框上面一句问候；左边是陪聊的人物
      await page.locator('.composer .greet').waitFor()
      expect((await page.locator('.composer .greet').textContent())!.trim().length).toBeGreaterThan(3)
      await page.getByRole('button', { name: /陪你聊的是老友/ }).waitFor()
      expect(await page.getByLabel('问题').getAttribute('placeholder')).toBe('和老友聊聊你的日记')
      await page.screenshot({ path: OUT + `b7-01-hello${dark ? '-dark' : ''}.png` })

      await page.getByLabel('问题').fill('最近和阿禾去西湖了吗？')
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.next .nq').first().waitFor()
      expect(systems[0]).toContain('## 这次陪他聊的是：老友')
      expect(systems[0]).toContain('不管扮演谁，下面几条优先')
      expect(systems[0]).toContain('接着问：')
      // 问候收起；“接着问”那一行变成按钮，不留在正文里；日期显示成“10月2日”
      expect(await page.locator('.composer .greet').count()).toBe(0)
      await expect(page.locator('.next .nq').allTextContents()).resolves.toEqual(['第一次和阿禾去西湖是什么时候？', '外婆家的桂树还开吗？'])
      expect(await page.locator('.turn .a .prose').textContent()).not.toContain('接着问')
      await expect(page.locator('.turn .a a.dl').first().textContent()).resolves.toBe('10月2日')
      await page.locator('.turn .by').getByText('老友').waitFor()
      await page.getByText(/这次翻了 1 回/).waitFor()
      await page.screenshot({ path: OUT + `b7-02-answer${dark ? '-dark' : ''}.png`, fullPage: true })

      // 换成猫：从下一句开始
      await page.getByRole('button', { name: /陪你聊的是老友/ }).click()
      await page.getByRole('dialog', { name: '谁来陪你聊' }).waitFor()
      await expect(page.locator('.pitem .pname').allTextContents()).resolves.toEqual(['老友', '知音', '说书人', '损友', '元气同桌', '猫'])
      await page.waitForTimeout(500)
      await page.screenshot({ path: OUT + `b7-03-personas${dark ? '-dark' : ''}.png` })
      await page.getByRole('radio', { name: /^猫/ }).click()
      await page.getByRole('button', { name: /陪你聊的是猫/ }).waitFor()
      // 点“接着问”：同一个对话里接着问，由猫来答
      await page.locator('.next .nq').first().click()
      await page.locator('.turn').nth(1).locator('.by').getByText('猫').waitFor()
      expect(systems[systems.length - 1]).toContain('## 这次陪他聊的是：猫')
      await expect(page.locator('.turn .q').allTextContents()).resolves.toEqual(['最近和阿禾去西湖了吗？', '第一次和阿禾去西湖是什么时候？'])
      // 只有最后一个回答下面有“接着问”
      await expect(page.locator('.next').count()).resolves.toBe(1)
      await page.screenshot({ path: OUT + `b7-04-cat${dark ? '-dark' : ''}.png`, fullPage: true })

      // 添加自己的人物：照着老友改一份
      await page.getByRole('button', { name: /陪你聊的是猫/ }).click()
      await page.getByRole('link', { name: '添加人物' }).click()
      await page.waitForURL(/#\/ai\/persona\/new$/)
      await page.getByRole('button', { name: '老友' }).click()
      expect(await page.getByLabel('名字').inputValue()).toBe('我的老友')
      await page.getByLabel('名字').fill('外婆')
      await page.getByLabel('说话的样子').fill('你是我外婆，叫我“乖乖”，说话慢，爱念叨我吃没吃饭、穿没穿暖。')
      await page.getByLabel(/一句例句/).fill('乖乖，今天吃饭了没有？')
      await page.screenshot({ path: OUT + `b7-05-custom${dark ? '-dark' : ''}.png` })
      await page.getByRole('button', { name: '添加并换上' }).click()
      await page.waitForURL(/#\/ai$/)
      await page.getByRole('button', { name: /陪你聊的是外婆/ }).waitFor()
      // 新对话也用外婆；问一句，提示词里是外婆的设定，底线照旧
      await page.getByRole('button', { name: '新对话' }).click()
      await page.getByRole('button', { name: /陪你聊的是外婆/ }).waitFor()
      await page.locator('.composer .greet').waitFor()
      await page.getByLabel('问题').fill('最近怎么样？')
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.turn .by').getByText('外婆').waitFor()
      expect(systems[systems.length - 1]).toContain('## 这次陪他聊的是：外婆')
      expect(systems[systems.length - 1]).toContain('乖乖，今天吃饭了没有？')
      expect(systems[systems.length - 1]).toContain('不管扮演谁，下面几条优先')
      // 改和删：删掉后换回老友
      await page.getByRole('button', { name: /陪你聊的是外婆/ }).click()
      await page.getByRole('link', { name: '修改外婆' }).click()
      await page.getByRole('button', { name: '删去' }).click()
      await page.waitForURL(/#\/ai$/)
      await page.getByRole('button', { name: /陪你聊的是老友/ }).waitFor()
      // 以前的回答上还留着外婆的名字
      await page.locator('.turn .by').getByText('外婆').waitFor()
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

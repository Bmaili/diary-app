/**
 * 2026-10-22 的端到端测试：心情颜色可以换、灯下的人物放在系统提示词最后、收藏对话。
 * 截图在 e2e/out/b9-*.png（亮色、暗色）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { startLlmMock, type LlmMock } from '../tests/mocks/llmServer'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4183
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




const cssVar = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name)

describe('心情颜色、人物、收藏对话（2026-10-22）', () => {
  for (const dark of [false, true]) {
    it(`设置里换心情颜色，日历、首页跟着变${dark ? '（暗色）' : ''}`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, diary())
      const sfx = dark ? '-dark' : ''
      // 开关不跟着心情色走
      const okBefore = await cssVar(page, '--ok')
      await page.goto(BASE + '#/settings')
      await page.getByRole('link', { name: /心情颜色/ }).click()
      await page.waitForURL(/mood-colors/)
      await page.getByRole('button', { name: /^青黛/ }).waitFor()
      expect(await page.getByRole('button', { name: /^青黛/ }).getAttribute('aria-pressed')).toBe('true')
      await page.screenshot({ path: OUT + `b9-01-mood-default${sfx}.png`, fullPage: true })

      await page.getByRole('button', { name: /^朱金/ }).click()
      const m5 = await cssVar(page, '--m5')
      if (!dark) expect(m5).toBe('#d6452f')
      else expect(m5).not.toBe('#d6452f')
      expect(await cssVar(page, '--m4')).not.toBe(dark ? '#8db27a' : '#6f9460')
      expect(await cssVar(page, '--ok')).toBe(okBefore)
      await page.screenshot({ path: OUT + `b9-02-mood-zhujin${sfx}.png`, fullPage: true })

      // 单独换“一般”的颜色：成了“自己调过”
      await page.getByRole('radio', { name: /^一般/ }).click()
      await page.getByRole('button', { name: '藕荷', exact: true }).click()
      expect(await cssVar(page, '--m3')).toBe(dark ? await cssVar(page, '--m3') : '#9a8aa8')
      await page.getByText('现在是你自己调过的颜色。').waitFor()
      // 两档一样时提醒
      await page.getByRole('radio', { name: /^不好/ }).click()
      await page.getByRole('button', { name: '藕荷', exact: true }).click()
      await page.getByText(/“不好”和“一般”颜色太像/).waitFor()
      await page.screenshot({ path: OUT + `b9-03-mood-custom${sfx}.png`, fullPage: true })

      // 重开 app 还在；日历用的是新颜色
      await page.reload()
      await page.waitForFunction(() => document.querySelector('.shell'))
      if (!dark) expect(await cssVar(page, '--m2')).toBe('#9a8aa8')
      await page.goto(BASE + '#/calendar')
      await page.locator('.cell.has').first().waitFor()
      await page.screenshot({ path: OUT + `b9-04-calendar${sfx}.png` })
      await page.goto(BASE + '#/')
      await page.waitForTimeout(400)
      await page.screenshot({ path: OUT + `b9-05-home${sfx}.png` })

      // 恢复默认：样式表去掉
      await page.goto(BASE + '#/settings/mood-colors')
      await page.getByRole('button', { name: /恢复默认/ }).click()
      expect(await page.locator('#mood-colors').count()).toBe(0)
      expect(await cssVar(page, '--m5')).toBe(dark ? '#eab055' : '#e3a33b')
      expect(errors).toEqual([])
      await ctx.close()
    })
  }

  for (const dark of [false, true]) {
    it(`人物放在系统提示词最后；对话可以收藏${dark ? '（暗色）' : ''}`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, diary())
      await addAi(page)
      const sfx = dark ? '-dark' : ''
      const before = llm.requests.length
      await page.getByRole('button', { name: /陪你聊的是/ }).click()
      await page.getByRole('dialog', { name: '谁来陪你聊' }).getByRole('radio', { name: /猫/ }).last().click()
      await page.getByLabel('问题').fill('最近和阿禾去西湖了吗？')
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.turn .a').first().waitFor()
      const body = llm.requests[before].body as { messages?: { role: string; content: string }[]; system?: string }
      const sys = body.system ?? body.messages!.find((m) => m.role === 'system')!.content
      expect(sys.lastIndexOf('## 这次陪他聊的是：猫')).toBeGreaterThan(sys.lastIndexOf('接着问：'))
      expect(sys).toContain('铲屎的')
      expect(sys.trim().endsWith('用平常的说法。')).toBe(true)

      // 收藏这段对话
      const mark = page.getByRole('button', { name: '收藏这段对话' })
      await mark.click()
      await page.getByRole('button', { name: '取消收藏这段对话' }).waitFor()
      // 再开一段新对话
      await page.getByRole('button', { name: '新对话' }).click()
      await page.getByLabel('问题').fill('今年读了几本书？')
      await page.getByRole('button', { name: '发送' }).click()
      await page.locator('.turn .a').first().waitFor()
      await page.getByRole('button', { name: '以前的对话' }).click()
      const sheet = page.getByRole('dialog', { name: '以前的对话' })
      await sheet.getByRole('heading', { name: '收藏的' }).waitFor()
      await sheet.getByRole('heading', { name: '最近的' }).waitFor()
      expect(await sheet.locator('.hist').first().textContent()).toContain('最近和阿禾去西湖了吗')
      await page.screenshot({ path: OUT + `b9-06-history${sfx}.png` })
      // 记录里存着
      const saved = await page.evaluate(() => (window as unknown as W).__diary.repo.store.readText('ai/chats.json'))
      const list = JSON.parse(saved!) as { title: string; starred?: boolean }[]
      expect(list.find((c) => c.title.startsWith('最近和阿禾'))!.starred).toBe(true)
      expect(list.find((c) => c.title.startsWith('今年读了'))!.starred).toBeUndefined()
      // 删收藏的要先确认（autoDialog 点“删除”）
      await sheet.getByRole('button', { name: '删除这个对话' }).first().click()
      await sheet.getByRole('heading', { name: '收藏的' }).waitFor({ state: 'detached' })
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

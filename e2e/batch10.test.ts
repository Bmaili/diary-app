/**
 * 2026-10-26 的端到端测试：日历“心情多是”按天数最多的一档、第一次写也标上时间、每日清单。
 * 截图在 e2e/out/b10-*.png（亮色、暗色）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4184
const BASE = `http://127.0.0.1:${PORT}/`
const DEVICE = {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' as const,
}

let server: ChildProcess
let browser: Browser

type W = { __diary: { repo: { store: { writeText(p: string, t: string): Promise<void>; readText(p: string): Promise<string | null> } } } }

async function newPage(opts: { dark?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ ...DEVICE, colorScheme: opts.dark ? 'dark' : 'light' })
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort())
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await ctx.addInitScript(autoDialog)
  await page.goto(BASE)
  await page.waitForFunction(() => (window as unknown as { __diary?: unknown }).__diary && document.querySelector('.shell'))
  return { ctx, page, errors }
}

const today = () => new Date(Date.now() - 4 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 10)
const WEEK = ['日', '一', '二', '三', '四', '五', '六']
const weekdayOf = (d: string) => WEEK[new Date(`${d}T12:00:00Z`).getUTCDay()]

/** 上个月的头 14 天：10 天“不错”、2 天“很差”、2 天“不好”（平均是“一般”） */
function lastMonth(): Record<string, string> {
  const t = today()
  let y = Number(t.slice(0, 4))
  let m = Number(t.slice(5, 7)) - 1
  if (m === 0) { m = 12; y-- }
  const moods = [4, 4, 1, 4, 4, 2, 4, 4, 1, 4, 4, 2, 4, 4]
  const out: Record<string, string> = {}
  moods.forEach((mood, i) => {
    const d = `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
    out[`diary/entries/${y}/${d}.md`] = `---\ndate: ${d}\nupdated: ${d}T21:00:00+08:00\nmood: ${mood}\n---\n\n这天的事。\n`
  })
  return out
}

async function seed(page: Page, files: Record<string, string>) {
  await page.evaluate(async (fs) => {
    const s = (window as unknown as W).__diary.repo.store
    for (const [p, t] of Object.entries(fs)) await s.writeText(p, t)
  }, files)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('.shell'))
}

const readEntry = (page: Page, d: string) =>
  page.evaluate((p) => (window as unknown as W).__diary.repo.store.readText(p), `diary/entries/${d.slice(0, 4)}/${d}.md`)

beforeAll(async () => {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
})

describe('心情统计、时间标题、每日清单（2026-10-26）', () => {
  for (const dark of [false, true]) {
    const sfx = dark ? '-dark' : ''

    it(`日历：心情多是天数最多的一档${dark ? '（暗色）' : ''}`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, lastMonth())
      await page.goto(BASE + '#/calendar')
      await page.getByRole('button', { name: '上个月' }).click()
      await page.locator('.summary').getByText(/心情多是\s*不错（10 天）/).waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: OUT + `b10-01-calendar${sfx}.png` })
      expect(errors).toEqual([])
      await ctx.close()
    })

    it(`设置每日清单；写今天时预填清单和时间，勾一项就记下${dark ? '（暗色）' : ''}`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      const t = today()
      const wd = weekdayOf(t)
      await page.goto(BASE + '#/settings')
      await page.getByRole('switch', { name: '第一次写也标上时间' }).click()
      await page.getByRole('link', { name: /每日清单/ }).click()
      await page.waitForURL(/settings\/checklist/)
      await page.screenshot({ path: OUT + `b10-02-checklist-empty${sfx}.png` })

      const add = async (text: string, pick?: () => Promise<void>) => {
        await page.getByRole('button', { name: '添一项' }).click()
        const sheet = page.getByRole('dialog', { name: '添一项' })
        await sheet.getByLabel('要做的事').fill(text)
        if (pick) await pick()
        await sheet.getByRole('button', { name: '完成' }).click()
        await sheet.waitFor({ state: 'detached' })
      }
      await add('喝够八杯水')
      await add('读书半小时')
      await add(`倒垃圾`, async () => {
        const sheet = page.getByRole('dialog', { name: '添一项' })
        await sheet.getByRole('button', { name: `周${wd}`, exact: true }).click()
        await page.screenshot({ path: OUT + `b10-03-checklist-sheet${sfx}.png` })
      })
      await add('永远不会出现', async () => {
        const sheet = page.getByRole('dialog', { name: '添一项' })
        const other = WEEK[(WEEK.indexOf(wd) + 1) % 7]
        await sheet.getByRole('button', { name: `周${other}`, exact: true }).click()
      })
      await page.getByText(`周${wd}`, { exact: true }).waitFor()
      await page.screenshot({ path: OUT + `b10-04-checklist${sfx}.png`, fullPage: true })

      // 写今天：清单 + 时间标题
      await page.goto(BASE + '#/')
      await page.getByRole('button', { name: '写今天' }).click()
      await page.waitForURL(/#\/entry\//)
      const box = page.getByLabel('日记正文')
      await box.waitFor()
      const value = await box.inputValue()
      expect(value).toMatch(/^- \[ \] 喝够八杯水\n- \[ \] 读书半小时\n- \[ \] 倒垃圾\n\n### \d\d:\d\d\n$/)
      expect(value).not.toContain('永远不会出现')
      await page.screenshot({ path: OUT + `b10-05-editor${sfx}.png` })

      // 没动过就离开：不保存
      await page.goBack()
      await page.waitForURL(/#\/$/)
      expect(await readEntry(page, t)).toBeNull()

      // 再进来，到阅读视图里勾一项
      await page.getByRole('button', { name: '写今天' }).click()
      await page.waitForURL(/#\/entry\//)
      await page.getByRole('button', { name: '阅读视图' }).click()
      const boxes = page.locator('.reading input[type="checkbox"]')
      await boxes.first().waitFor()
      expect(await boxes.count()).toBe(3)
      await boxes.first().check()
      await page.waitForTimeout(1500)
      await page.screenshot({ path: OUT + `b10-06-reading${sfx}.png` })
      const saved = (await readEntry(page, t))!
      expect(saved).toContain('- [x] 喝够八杯水\n- [ ] 读书半小时\n- [ ] 倒垃圾\n')
      expect(saved).not.toMatch(/### \d\d:\d\d\s*$/)

      // 之后再写今天：不再填清单，照常追加时间
      await page.goBack()
      await page.waitForURL(/#\/$/)
      await page.getByRole('button', { name: '写今天' }).click()
      await page.waitForURL(/#\/entry\//)
      await box.waitFor()
      expect(await box.inputValue()).toMatch(/^- \[x\] 喝够八杯水\n- \[ \] 读书半小时\n- \[ \] 倒垃圾\n\n### \d\d:\d\d\n$/)
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

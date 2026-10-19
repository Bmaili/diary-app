/**
 * 2026-10-14 这一批的端到端测试：寄往来日的文字、AI 标注一览、去掉的图片进最近删除、清理没用到的图片、
 * 水墨版年度日记本。截图在 e2e/out/b5-*.png（亮色、暗色）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4179
const BASE = `http://127.0.0.1:${PORT}/`
const DEVICE = {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' as const,
}
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

let server: ChildProcess
let browser: Browser

type Store = { writeText(p: string, t: string): Promise<void>; readText(p: string): Promise<string | null>; stat(p: string): Promise<unknown>; list(p: string): Promise<{ name: string; type: string }[]>; writeBase64(p: string, b: string): Promise<void> }
type W = {
  __diary: { repo: { readEntryRaw(d: string): Promise<string | null>; store: Store } }
  __dialogLog: string[]
  __yearbookCapture?: (h: string) => void
  __yb?: string
}

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

async function seed(page: Page, files: Record<string, string>, b64: Record<string, string> = {}) {
  await page.evaluate(async ([fs, bs]) => {
    const s = (window as unknown as W).__diary.repo.store
    for (const [p, t] of Object.entries(fs)) await s.writeText(p, t)
    for (const [p, t] of Object.entries(bs)) await s.writeBase64(p, t)
  }, [files, b64] as const)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('.shell'))
}

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
const trashDirs = (page: Page) => page.evaluate(async () => (await (window as unknown as W).__diary.repo.store.list('trash')).map((f) => f.name))

beforeAll(async () => {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
})

describe('寄往来日的文字', () => {
  for (const dark of [false, true]) {
    it(`卡片、信匣、空信匣${dark ? '（暗色）' : ''}`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      await page.goto(BASE + '#/letters')
      await page.getByText('匣中尚无来信。').waitFor()
      await page.getByText('生日、新年，或只是一年后的今天——写几句给那时的自己。').waitFor()
      await page.screenshot({ path: OUT + `b5-01-letters-empty${dark ? '-dark' : ''}.png` })
      await seed(page, { 'diary/letters/2026-10-01_1.md': '---\nwritten: 2026-10-01T10:00:00+08:00\nopen_on: 2030-10-01\n---\n\n给以后的自己。\n' })
      await page.goto(BASE + '#/letters')
      await page.getByText('尺素一封，寄与来日。').waitFor()
      await page.getByText('云中谁寄锦书来——是从前的你。').waitFor()
      expect(await page.getByText('没有加密').count()).toBe(0)
      await page.screenshot({ path: OUT + `b5-02-letters${dark ? '-dark' : ''}.png` })
      await page.goto(BASE + '#/calendar')
      await page.locator('.post').scrollIntoViewIfNeeded()
      await expect(page.locator('.post-sub').textContent()).resolves.toBe('尺素一封，寄与来日。')
      await page.locator('.post').screenshot({ path: OUT + `b5-03-post-card${dark ? '-dark' : ''}.png` })
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

describe('AI 标注一览', () => {
  for (const dark of [false, true]) {
    it(`已标注、待标注、跳过三组${dark ? '（暗色）' : ''}`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, {
        ...entry('2026-10-12', '晚上和阿禾在湖边走了一圈。她说起外婆家门口的桂树。', 'updated: 2026-10-12T21:00:00+08:00\nplaces: [西湖]\npeople: [阿禾, 外婆]\ntags: [散步]\nlocked: [people]\nai:\n  extracted_at: 2026-10-12T22:00:00+08:00\n  model: test\n'),
        ...entry('2026-10-11', '下午去旧书店。', 'updated: 2026-10-11T21:00:00+08:00\nai:\n  extracted_at: 2026-10-11T22:00:00+08:00\n  model: test\n'),
        ...entry('2026-10-13', '一整天的雨。', 'updated: 2026-10-13T23:00:00+08:00\nai:\n  extracted_at: 2026-10-13T22:00:00+08:00\n  model: test\n'),
        ...entry('2026-10-14', '还没标注的一篇。'),
        ...entry('2026-09-30', '不想给 AI 看的一篇。', 'ai_exclude: true\n'),
        ...entry('2026-09-29', '', 'mood: 3\n'),
      })
      // 有 AI 服务时才有“整理”页；这里只要有个服务配置在，不会真的请求
      await page.evaluate(() => {
        const w = window as unknown as { __diary: { prefs: { ai: { profiles: unknown[] } } } }
        w.__diary.prefs.ai.profiles.push({ id: 't', name: '测试', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', model: 'm' })
      })
      await page.goto(BASE + '#/ai?tab=tidy')
      await page.getByRole('link', { name: '整理过的' }).click()
      await page.waitForURL(/#\/ai\/tagged/)
      await page.getByRole('tab', { name: /整理过 2/ }).waitFor()
      await page.getByText('西湖').waitFor()
      await expect(page.locator('.tag.manual').count()).resolves.toBe(2)
      await page.getByText('没标出地点、人物或标签').waitFor()
      await page.screenshot({ path: OUT + `b5-04-tagged${dark ? '-dark' : ''}.png` })
      await page.getByRole('tab', { name: /还没整理 2/ }).click()
      await page.getByText('还没整理过').waitFor()
      await page.getByText('整理后又改过').waitFor()
      await page.screenshot({ path: OUT + `b5-05-pending${dark ? '-dark' : ''}.png` })
      await page.getByRole('tab', { name: /跳过 2/ }).click()
      await page.getByText('设了不让 AI 读').waitFor()
      await page.getByText('只记了心情，没有正文').waitFor()
      await page.screenshot({ path: OUT + `b5-06-skipped${dark ? '-dark' : ''}.png` })
      // 点一篇打开那天
      await page.getByRole('link', { name: /9 月 30 日/ }).click()
      await page.waitForURL(/#\/entry\/2026-09-30/)
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

describe('去掉的图片', () => {
  it('编辑时插了又删掉的图、删掉引用的旧图，离开时进最近删除；恢复时带着说明接回末尾', async () => {
    const { ctx, page, errors } = await newPage()
    const d = today()
    const y = d.slice(0, 4)
    await seed(page, entry(d, `早上。\n\n![桂花](../../attachments/${y}/${d}_1.png)`), { [`diary/attachments/${y}/${d}_1.png`]: PNG })
    writeFileSync(OUT + 'b5-a.png', Buffer.from(PNG, 'base64'))
    await page.goto(BASE + `#/entry/${d}`)
    await page.getByRole('button', { name: '编辑' }).click()
    await page.getByLabel('日记正文').waitFor()
    await page.getByRole('button', { name: '插图' }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: /从相册选/ }).click()
    await (await chooser).setFiles([OUT + 'b5-a.png'])
    await page.waitForFunction(() => ((document.querySelector('textarea') as HTMLTextAreaElement).value.match(/!\[/g) ?? []).length >= 2)
    await new Promise((r) => setTimeout(r, 1500))
    // 把两张图都删掉，只留文字
    await page.getByLabel('日记正文').fill('早上。')
    await page.goBack()
    await until(page, async () => {
      const s = (window as unknown as W).__diary.repo.store
      return (await s.list('trash')).some((f) => f.name.startsWith('images_'))
    }, null)
    expect(await page.evaluate(async (p) => !!(await (window as unknown as W).__diary.repo.store.stat(p)), `diary/attachments/${y}/${d}_1.png`)).toBe(false)
    expect(await raw(page, d)).not.toContain('attachments')

    await page.goto(BASE + '#/settings/trash')
    await page.getByText(/去掉的 2 张图片/).waitFor()
    await page.getByText(/恢复时接回/).waitFor()
    await page.screenshot({ path: OUT + 'b5-07-trash-images.png' })
    await page.getByRole('button', { name: '恢复' }).click()
    await page.getByText(/图片已放回/).waitFor()
    const after = (await raw(page, d))!
    expect(after).toContain(`早上。\n\n![桂花](../../attachments/${y}/${d}_1.png)`)
    expect(after.match(/attachments\//g)).toHaveLength(2)
    expect(await trashDirs(page)).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('设置里清理：刚存的图不动（可能正插在没保存的日记里），没有就说没有', async () => {
    const { ctx, page, errors } = await newPage({ dark: true })
    await seed(page, entry('2026-10-01', '一篇。'), { 'diary/attachments/2026/2026-10-01_7.png': PNG })
    await page.goto(BASE + '#/settings')
    await page.getByText('清理没用到的图片').scrollIntoViewIfNeeded()
    await page.locator('.item').filter({ hasText: '清理没用到的图片' }).getByRole('button', { name: '查找' }).click()
    await page.getByText('没有找到没用到的图片。').waitFor()
    await page.locator('.item').filter({ hasText: '清理没用到的图片' }).screenshot({ path: OUT + 'b5-08-cleanup-dark.png' })
    expect(await trashDirs(page)).toEqual([])
    expect(errors).toEqual([])
    await ctx.close()
  })
})

describe('水墨版年度日记本', () => {
  for (const dark of [false, true]) {
    it(`选项页的小书${dark ? '（暗色）' : ''}，排出来的书`, async () => {
      const { ctx, page, errors } = await newPage({ dark })
      const files: Record<string, string> = {}
      for (const [i, dd] of ['2026-01-05', '2026-01-06', '2026-01-07', '2026-03-20', '2026-10-08', '2026-10-11'].entries()) {
        Object.assign(files, entry(dd, `第 ${i + 1} 篇。${i === 5 ? '\n\n![江边](../../attachments/2026/2026-10-11_1.png)' : ''}`, `mood: ${(i % 5) + 1}\nplaces: [江边公园]\n${i === 4 ? 'starred: true\n' : ''}`))
      }
      files['diary/summaries/monthly/2026-10.md'] = '---\ntype: monthly-summary\nperiod: 2026-10\n---\n\n十月你回了一趟家。\n'
      await seed(page, files, { 'diary/attachments/2026/2026-10-11_1.png': PNG })
      await page.goto(BASE + '#/yearbook')
      await page.getByText(/约 \d+ 页/).waitFor()
      await page.screenshot({ path: OUT + `b5-09-yearbook${dark ? '-dark' : ''}.png` })
      if (!dark) {
        await page.evaluate(() => {
          const w = window as unknown as W
          w.__yearbookCapture = (h) => (w.__yb = h)
        })
        await page.getByRole('button', { name: '排版并打印 / 存为 PDF' }).click()
        await page.waitForFunction(() => !!(window as unknown as W).__yb)
        const html = await page.evaluate(() => (window as unknown as W).__yb!)
        expect(html).toContain('写了<b>6</b>天，最长一次连着写了<b>3</b>天')
        expect(html).toContain('常去江边公园')
        expect(html).toContain('<em>寒露</em>十月八日')
        expect(html).toContain('<div class="msum"><p>十月你回了一趟家。</p>')
        expect(html).toContain('十月八日<span class="wd">')
        expect(html).toContain('岁次丙午')
        const book = await ctx.newPage()
        await book.setContent(html)
        await book.pdf({ path: OUT + 'b5-10-yearbook.pdf', preferCSSPageSize: true, printBackground: true })
      }
      expect(errors).toEqual([])
      await ctx.close()
    })
  }
})

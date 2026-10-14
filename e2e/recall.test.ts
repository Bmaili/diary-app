/**
 * 2026-10-13 这一批的端到端测试：只记心情、珍藏、随手翻、备份提醒、导入日记、AI 页的引导。
 * 截图在 e2e/out/recall-*.png（亮色、暗色、360 宽小屏）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { autoDialog } from './autoDialog.mjs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4176
const BASE = `http://127.0.0.1:${PORT}/`
const DEVICE = {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' as const,
}

let server: ChildProcess
let browser: Browser

type W = { __diary: { repo: { readEntryRaw(d: string): Promise<string | null>; store: { writeText(p: string, t: string): Promise<void>; readText(p: string): Promise<string | null> } }; index: { all(): { date: string; text: string; starred?: boolean }[] }; prefs: Record<string, any> } }

async function newPage(opts: { dark?: boolean; width?: number } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({
    ...DEVICE,
    ...(opts.width ? { viewport: { width: opts.width, height: 780 } } : {}),
    colorScheme: opts.dark ? 'dark' : 'light',
  })
  // 外部请求（诗词、节假日、天气）一律不通，测试只看本地功能
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort())
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await ctx.addInitScript(autoDialog)
  await page.goto(BASE)
  await page.waitForFunction(() => (window as unknown as { __diary?: unknown }).__diary && document.querySelector('.shell'))
  return { ctx, page, errors }
}

const today = () => {
  const d = new Date(Date.now() - 4 * 3600e3 + 8 * 3600e3)
  return d.toISOString().slice(0, 10)
}

async function seed(page: Page, files: Record<string, string>) {
  await page.evaluate(async (fs) => {
    const w = window as unknown as W
    for (const [p, t] of Object.entries(fs)) await w.__diary.repo.store.writeText(p, t)
  }, files)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('.shell'))
}

const entry = (date: string, body: string, extra = '') => ({ [`diary/entries/${date.slice(0, 4)}/${date}.md`]: `---\ndate: ${date}\n${extra}---\n\n${body}\n` })

beforeAll(async () => {
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
})

describe('只记心情、珍藏、随手翻', () => {
  it('拖一下心情就保存；首页显示“只记了心情”；点开编辑又删光时不留文件', async () => {
    const { ctx, page, errors } = await newPage()
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByLabel('日记正文').waitFor()
    await expect(page.getByLabel('日记正文').getAttribute('placeholder')).resolves.toContain('拖一下心情也算记了')
    await page.getByRole('button', { name: '不好', exact: true }).click()
    await page.getByText('已记下心情').waitFor()
    await page.screenshot({ path: OUT + 'recall-01-mood-only-editor.png' })
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL(BASE + '#/')
    const raw = await page.evaluate((d) => (window as unknown as W).__diary.repo.readEntryRaw(d), today())
    expect(raw).toMatch(/^---\ndate: \d{4}-\d\d-\d\d\ncreated: .+\nupdated: .+\nmood: 2\n---\n$/)
    await page.getByText('只记了心情：不好').waitFor()
    await page.screenshot({ path: OUT + 'recall-02-home-mood-only.png' })

    // 再点开、点“不记”撤掉心情：离开时问要不要删除（测试里自动确认），删除后移到最近删除
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByRole('button', { name: '不记' }).click()
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL(BASE + '#/')
    await expect.poll(() => page.evaluate((d) => (window as unknown as W).__diary.repo.readEntryRaw(d), today())).toBeNull()
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('珍藏：顶栏点星，首页和珍藏集里都能看到；首页旧页可以换一页、点开', async () => {
    const { ctx, page, errors } = await newPage()
    await seed(page, {
      ...entry('2026-06-01', '搬进新家的第一个晚上，坐在纸箱上吃了一碗面。', 'mood: 3\n'),
      ...entry('2026-08-08', '和小雨去海边，看了日出。', 'mood: 5\nplaces: [海边]\npeople: [小雨]\n'),
      ...entry('2025-12-31', '跨年在外婆家，她包的饺子还是那个味道。', 'mood: 5\nstarred: true\n'),
    })
    await page.locator('.row[data-date="2026-08-08"]').click()
    // 编辑时不显示星（顶栏要放保存状态），阅读视图里才有
    await page.getByRole('button', { name: '编辑' }).click()
    await expect(page.getByRole('button', { name: '珍藏这一天' }).count()).resolves.toBe(0)
    await page.getByRole('button', { name: '阅读视图' }).click()
    await page.getByRole('button', { name: '珍藏这一天' }).click()
    await page.locator('.star.on').waitFor()
    await page.screenshot({ path: OUT + 'recall-03-editor-star.png' })
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL(BASE + '#/')
    await page.locator('.row[data-date="2026-08-08"] .starred').waitFor()
    // 旧页卡片：首页摆一篇旧日记，可以换一页
    const old = page.locator('.oldpage')
    await old.waitFor()
    await page.screenshot({ path: OUT + 'recall-04-home-oldpage.png' })
    const firstOld = await old.locator('.op-date').innerText()
    await old.getByRole('button', { name: '换一页' }).click()
    await expect.poll(() => old.locator('.op-date').innerText()).not.toBe(firstOld)

    await page.locator('.oldpage .op-main').click()
    await page.waitForURL(/#\/entry\/\d{4}-\d\d-\d\d$/)
    expect(['2026-06-01', '2026-08-08', '2025-12-31']).toContain(page.url().split('/').pop())

    // 搜索：从首页的悬浮按钮进去；搜索框右边的星星只看珍藏
    await page.goto(BASE + '#/')
    await page.getByRole('link', { name: '搜索' }).click()
    await page.waitForURL(/#\/search$/)
    await page.getByRole('button', { name: '只看珍藏' }).click()
    await page.getByText('共 2 篇').waitFor()
    await expect(page.locator('.hit .hd').allInnerTexts()).resolves.toEqual(['2026.08.08', '2025.12.31'])
    await page.screenshot({ path: OUT + 'recall-05-search-starred.png' })
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL(BASE + '#/')
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('暗色和 360 宽小屏：编辑页顶栏放得下，珍藏集、首页不出错', async () => {
    const { ctx, page } = await newPage({ dark: true, width: 360 })
    await seed(page, {
      ...entry('2026-08-08', '和小雨去海边，看了日出。今年最开心的一天。', 'mood: 5\nstarred: true\nplaces: [海边]\n'),
      ...entry('2026-08-09', '', 'mood: 2\n'),
    })
    await page.screenshot({ path: OUT + 'recall-06-home-dark-360.png' })
    await page.locator('.row[data-date="2026-08-08"]').click()
    await page.locator('.star.on').waitFor()
    // 顶栏不换行、不溢出：最后一个按钮的右边不超出屏幕
    const right = await page.locator('.editor .topbar .icon-btn').last().evaluate((el) => el.getBoundingClientRect().right)
    expect(right).toBeLessThanOrEqual(360)
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(scrollW).toBeLessThanOrEqual(360)
    await page.screenshot({ path: OUT + 'recall-07-editor-dark-360.png' })
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL(BASE + '#/')
    await page.locator('.row[data-date="2026-08-09"]').click()
    await page.getByText('这天只记了心情').waitFor()
    await page.screenshot({ path: OUT + 'recall-08-mood-only-read-dark.png' })
    await page.goto(BASE + '#/search')
    await page.getByRole('button', { name: '只看珍藏' }).click()
    await page.getByText('共 1 篇').waitFor()
    // 搜索栏四个元素在小屏上都放得下，页面不被撑宽
    expect(await page.locator('.filter-btn').evaluate((el) => el.getBoundingClientRect().right)).toBeLessThanOrEqual(360)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
    await page.screenshot({ path: OUT + 'recall-09-search-starred-dark-360.png' })
    await ctx.close()
  })
})

describe('备份提醒', () => {
  it('写满 10 篇、没开同步时首页提醒；点 × 后不再出现', async () => {
    const { ctx, page, errors } = await newPage()
    const files: Record<string, string> = {}
    for (let i = 1; i <= 10; i++) Object.assign(files, entry(`2026-09-${String(i).padStart(2, '0')}`, `第 ${i} 篇`, 'mood: 3\n'))
    await seed(page, files)
    await page.getByText('这些日记还没有备份').waitFor()
    await page.screenshot({ path: OUT + 'recall-10-backup.png' })
    await page.getByRole('button', { name: '不再提醒' }).click()
    await expect.poll(() => page.getByText('这些日记还没有备份').count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as W).__diary.prefs.backup.dismissed)).toBe(true)
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('暗色下的备份提醒', async () => {
    const { ctx, page } = await newPage({ dark: true })
    const files: Record<string, string> = {}
    for (let i = 1; i <= 12; i++) Object.assign(files, entry(`2026-09-${String(i).padStart(2, '0')}`, `第 ${i} 篇`, `mood: ${(i % 5) + 1}\n`))
    await seed(page, files)
    await page.getByText('这些日记还没有备份').waitFor()
    await page.screenshot({ path: OUT + 'recall-11-backup-dark.png' })
    await ctx.close()
  })
})

describe('导入日记', () => {
  it('导入 Markdown 文件夹的 zip：先看预览，再导入，日记和图片都进来了', async () => {
    const zip = new JSZip()
    zip.file('Journal/2024-01-02.md', '# 2024-01-02 星期二\n\n今天很冷。\n\n![猫](assets/cat.png)\n')
    zip.file('Journal/随笔.md', '---\ndate: 2024-01-03\nmood: 4\n---\n\n读完了一本书。\n')
    zip.file('Journal/读书清单.md', '- 某本书\n')
    // 1x1 的 PNG
    zip.file('Journal/assets/cat.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'))
    const path = OUT + 'import-sample.zip'
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))

    const { ctx, page, errors } = await newPage()
    await seed(page, entry('2024-01-03', '手机上已经有的一篇', 'mood: 2\n'))
    await page.goto(BASE + '#/settings')
    await page.getByRole('link', { name: /导入日记/ }).click()
    await page.waitForURL(/#\/settings\/import$/)
    await page.screenshot({ path: OUT + 'recall-12-import-start.png' })
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '选择文件' }).click()
    await (await chooser).setFiles(path)
    await page.getByText('认不出日期的文件').waitFor()
    await page.getByText('手机上也有、内容不同').waitFor()
    await page.screenshot({ path: OUT + 'recall-13-import-preview.png', fullPage: true })
    await page.getByRole('button', { name: /导入 1 篇/ }).click()
    await page.getByText('导入完成').waitFor()
    await page.screenshot({ path: OUT + 'recall-14-import-done.png', fullPage: true })

    const raw = await page.evaluate(() => (window as unknown as W).__diary.repo.readEntryRaw('2024-01-02'))
    expect(raw).toContain('今天很冷。')
    expect(raw).toContain('](../../attachments/2024/2024-01-02_1.png)')
    // 手机上原有的那天没被动
    expect(await page.evaluate(() => (window as unknown as W).__diary.repo.readEntryRaw('2024-01-03'))).toContain('手机上已经有的一篇')
    // 首页能看到导入的日记
    await page.getByRole('button', { name: '回到日记' }).click()
    await page.locator('.row[data-date="2024-01-02"]').waitFor()
    // 阅读视图里图片能显示
    await page.locator('.row[data-date="2024-01-02"]').click()
    await page.locator('article.reading img').waitFor()
    expect(await page.locator('article.reading img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('暗色下的导入预览', async () => {
    const { ctx, page } = await newPage({ dark: true })
    await page.goto(BASE + '#/settings/import')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '选择文件' }).click()
    await (await chooser).setFiles(OUT + 'import-sample.zip')
    await page.getByText('认不出日期的文件').waitFor()
    await page.screenshot({ path: OUT + 'recall-15-import-preview-dark.png', fullPage: true })
    await ctx.close()
  })
})

describe('app 自己的提示框', () => {
  it('删除确认和“正文删光了”二选一，亮色暗色截图；返回键按安全选项处理', async () => {
    for (const dark of [false, true]) {
      const { ctx, page, errors } = await newPage({ dark })
      await seed(page, entry('2026-08-08', '和小雨去海边，看了日出。', 'mood: 5\n'))
      await page.evaluate(() => ((window as unknown as { __noAutoDialog: boolean }).__noAutoDialog = true))
      await page.locator('.row[data-date="2026-08-08"]').click()
      await page.getByRole('button', { name: '删除这篇日记' }).click()
      const dlg = page.getByRole('alertdialog')
      await dlg.getByText('删除 8 月 8 日的日记？').waitFor()
      await page.screenshot({ path: OUT + `recall-20-dialog-delete${dark ? '-dark' : ''}.png` })
      await dlg.getByRole('button', { name: '取消' }).click()
      await expect.poll(() => dlg.count()).toBe(0)

      // 删光正文、留着心情离开：问只保留心情还是恢复
      await page.getByRole('button', { name: '编辑' }).click()
      await page.getByLabel('日记正文').fill('')
      await page.waitForTimeout(1300)
      await page.getByRole('button', { name: '返回' }).click()
      await dlg.getByText('正文已经删光了').waitFor()
      await page.screenshot({ path: OUT + `recall-21-dialog-choose${dark ? '-dark' : ''}.png` })
      // Esc（和安卓返回键一样）按“恢复原来的正文”
      await page.keyboard.press('Escape')
      await page.waitForURL(BASE + '#/')
      await expect.poll(() => page.evaluate(() => (window as unknown as W).__diary.repo.readEntryRaw('2026-08-08'))).toContain('看了日出')
      expect(errors).toEqual([])
      await ctx.close()
    }
  })
})

describe('写给未来的信', () => {
  it('写一封、封存；信匣里只看到日期；改日期；撤回后进最近删除且不露内容', async () => {
    const { ctx, page, errors } = await newPage()
    await seed(page, entry('2026-06-01', '搬家', 'mood: 3\n'))
    // 寄往来日在日历页
    await page.getByRole('link', { name: '日历' }).click()
    await page.getByLabel('寄往来日').waitFor()
    await page.screenshot({ path: OUT + 'recall-29-calendar-post.png' })
    await page.getByLabel('寄往来日').getByRole('link', { name: '信匣' }).click()
    await page.waitForURL(/#\/letters$/)
    await page.getByText('匣中尚无来信').waitFor()
    await page.screenshot({ path: OUT + 'recall-30-letters-empty.png' })
    await page.getByRole('link', { name: '写一封', exact: true }).click()
    await page.waitForURL(/#\/letters\/new$/)
    await page.getByLabel('信的内容').fill('一年后的我：\n\n现在是寒露，刚换了工作。希望你还在写。')
    // 写到一半离开，回来还在
    await page.getByRole('button', { name: '返回' }).click()
    await page.getByRole('link', { name: '写一封', exact: true }).click()
    await expect(page.getByLabel('信的内容').inputValue()).resolves.toContain('刚换了工作')
    await page.getByRole('button', { name: /明年元日/ }).click()
    await page.screenshot({ path: OUT + 'recall-31-letter-write.png' })
    await page.getByRole('button', { name: '封存' }).click()
    await page.waitForURL(/#\/letters$/)
    const nextYear = Number(today().slice(0, 4)) + 1
    await page.getByText(`${nextYear}.1.1 元日`).waitFor()
    // 封着的信不露内容
    expect(await page.locator('.letters-page').innerText()).not.toContain('刚换了工作')
    await page.screenshot({ path: OUT + 'recall-32-letters-sealed.png' })
    const files = await page.evaluate(async () => (window as unknown as { __diary: { repo: { store: { list(d: string): Promise<{ name: string }[]> } } } }).__diary.repo.store.list('diary/letters'))
    expect(files).toHaveLength(1)
    const raw = await page.evaluate((n) => (window as unknown as W).__diary.repo.store.readText(`diary/letters/${n}`), files[0].name)
    expect(raw).toMatch(new RegExp(`^---\\nwritten: .+\\nopen_on: ${nextYear}-01-01\\nremind: true\\n---\\n\\n一年后的我：`))
    // 草稿清掉了
    expect(await page.evaluate(() => (window as unknown as W).__diary.prefs.letterDraft.body)).toBe('')

    // 改日期
    await page.locator('.env').first().click()
    await page.getByRole('button', { name: '三年后' }).click()
    await page.getByRole('button', { name: '保存日期' }).click()
    await page.getByText(`还有`).first().waitFor()
    await expect.poll(() => page.evaluate((n) => (window as unknown as W).__diary.repo.store.readText(`diary/letters/${n}`), files[0].name)).toContain(`open_on: ${nextYear + 2}-`)
    // 撤回
    await page.locator('.env').first().click()
    await page.getByRole('button', { name: '撤回这封信' }).click()
    await page.getByText('匣中尚无来信').waitFor()
    await page.goto(BASE + '#/settings/trash')
    await page.getByText('写的信').waitFor()
    expect(await page.locator('.settings').innerText()).not.toContain('刚换了工作')
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('信到了：首页弹出信封，拆开后记下拆信时间，信匣里移到“已拆开”', async () => {
    for (const dark of [false, true]) {
      const { ctx, page, errors } = await newPage({ dark })
      const t = today()
      const lastYear = `${Number(t.slice(0, 4)) - 1}${t.slice(4)}`
      await seed(page, {
        ...entry('2026-06-01', '搬家', 'mood: 3\n'),
        [`diary/letters/${lastYear}_1.md`]: `---\nwritten: ${lastYear}T21:00:00+08:00\nopen_on: ${t}\nremind: true\n---\n\n一年后的我：\n\n希望你还在写。\n`,
      })
      const sheet = page.getByRole('dialog', { name: /一年前的你，寄来一封信/ })
      await sheet.waitFor()
      await page.screenshot({ path: OUT + `recall-33-letter-arrived${dark ? '-dark' : ''}.png` })
      // 晚点再看：日历页的邮票变成“启”，在那里也能拆
      await sheet.getByRole('button', { name: '晚点再看' }).click()
      await page.getByRole('link', { name: '日历' }).click()
      await page.getByText('有一封信到了，还没拆。').waitFor()
      await page.screenshot({ path: OUT + `recall-36-calendar-arrived${dark ? '-dark' : ''}.png` })
      await page.getByLabel('寄往来日').getByRole('link', { name: '拆开' }).click()
      await page.waitForURL(/#\/letters\/.+$/)
      await page.getByText('希望你还在写。').waitFor()
      await page.screenshot({ path: OUT + `recall-34-letter-read${dark ? '-dark' : ''}.png` })
      await expect.poll(() => page.evaluate((p) => (window as unknown as W).__diary.repo.store.readText(p), `diary/letters/${lastYear}_1.md`)).toMatch(/\nopened: .+\n/)
      await page.getByRole('button', { name: '返回' }).click()
      await page.goto(BASE + '#/letters')
      await page.getByText('已拆开').waitFor()
      // 回首页不再弹
      await page.goto(BASE + '#/')
      await page.locator('.shell').waitFor()
      await page.waitForTimeout(500)
      await expect(sheet.count()).resolves.toBe(0)
      expect(errors).toEqual([])
      await ctx.close()
    }
  })

  it('每日诗词、旧页默认打开，设置里可以关', async () => {
    const { ctx, page } = await newPage()
    await seed(page, entry('2026-06-01', '搬家', 'mood: 3\n'))
    expect(await page.evaluate(() => (window as unknown as W).__diary.prefs.daily.mode)).toBe('local')
    await page.locator('.poem').waitFor()
    await page.locator('.oldpage').waitFor()
    await page.goto(BASE + '#/settings')
    await page.getByRole('switch', { name: '旧页' }).click()
    await page.goto(BASE + '#/')
    await page.locator('.poem').waitFor()
    await expect(page.locator('.oldpage').count()).resolves.toBe(0)
    await ctx.close()
  })

  it('换一页：旧的一页像撕下来一样飘落（开着动画时）', async () => {
    const ctx = await browser.newContext({ ...DEVICE, reducedMotion: 'no-preference' })
    await ctx.addInitScript(autoDialog)
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort())
    const page = await ctx.newPage()
    await page.goto(BASE)
    await page.waitForFunction(() => document.querySelector('.shell'))
    await seed(page, {
      ...entry('2026-06-01', '搬进新家的第一个晚上，坐在纸箱上吃了一碗面。', 'mood: 3\n'),
      ...entry('2026-05-01', '五一去爬山，山顶风很大。', 'mood: 4\n'),
    })
    await page.waitForTimeout(2500)
    await page.locator('.oldpage').getByRole('button', { name: '换一页' }).click()
    await page.locator('.leaf').waitFor()
    await page.waitForTimeout(450)
    await page.screenshot({ path: OUT + 'recall-35-leaf-falling.png' })
    // 落完就移除，不留在页面上；页面不会被撑宽
    await expect.poll(() => page.locator('.leaf').count(), { timeout: 3000 }).toBe(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(393)
    await ctx.close()
  })
})

describe('AI 页', () => {
  it('还没接 AI 服务：示例问答和 DeepSeek 三步；点按钮进添加页时选好了 DeepSeek 模板', async () => {
    for (const dark of [false, true]) {
      const { ctx, page, errors } = await newPage({ dark })
      await page.goto(BASE + '#/ai')
      await page.getByText('接上一个 AI 服务，就能这样问你的日记').waitFor()
      await page.screenshot({ path: OUT + `recall-16-ai-empty${dark ? '-dark' : ''}.png`, fullPage: true })
      if (!dark) {
        await page.getByRole('link', { name: '添加 AI 服务' }).click()
        await page.waitForURL(/#\/settings\/ai\/new/)
        await expect(page.locator('input.field').nth(0).inputValue()).resolves.toBe('DeepSeek')
        await expect(page.getByPlaceholder('https://…/v1').inputValue()).resolves.toBe('https://api.deepseek.com/v1')
      }
      expect(errors).toEqual([])
      await ctx.close()
    }
  })
})

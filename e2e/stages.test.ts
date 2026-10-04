/**
 * 阶段 2–4 的端到端测试：在手机尺寸的 Chromium 里操作真实界面。
 * 阿里云 OSS、GitHub、高德、天气、LLM 的请求都被拦截并转发到本地模拟服务器。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { startOssMock, type OssMock } from '../tests/mocks/ossServer'
import { startGitHubMock, type GitHubMock } from '../tests/mocks/githubServer'
import { lastToolResult, startLlmMock, type LlmMock, type Script } from '../tests/mocks/llmServer'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4175
const BASE = `http://127.0.0.1:${PORT}/`
const DEVICE = {
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
  // 关掉动画，截图不会拍到切换到一半的画面
  reducedMotion: 'reduce' as const,
}
const OSS = { id: 'LTAI5tE2E', secret: 'e2e-secret', bucket: 'my-diary' }
const GH_TOKEN = 'github_pat_e2e'

let server: ChildProcess
let browser: Browser
let oss: OssMock
let gh: GitHubMock
let llm: LlmMock

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': '*',
}

/** 把请求转发到本地地址，并加上跨域响应头 */
async function forward(route: Route, url: string) {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
  const res = await route.fetch({ url, method: req.method(), headers: await req.allHeaders(), postData: req.postDataBuffer() ?? undefined })
  await route.fulfill({ status: res.status(), headers: { ...res.headers(), ...CORS }, body: await res.body() })
}

const AMAP = {
  regeo: { status: '1', info: 'OK', infocode: '10000', regeocode: { formatted_address: '广东省广州市海珠区阅江西路222号', addressComponent: { city: '广州市', district: '海珠区' } } },
  around: {
    status: '1', info: 'OK', infocode: '10000',
    pois: [
      { id: 'B00140TEST', name: '广州塔', address: '阅江西路222号', type: '风景名胜;风景名胜', location: '113.324520,23.106414', distance: '35' },
      { id: 'B00140EAT1', name: '老王烧烤', address: '艺苑路18号', type: '餐饮服务;中餐厅', location: '113.326000,23.105000', distance: '180' },
    ],
  },
}

async function wire(ctx: BrowserContext) {
  await ctx.route(/^https:\/\/my-diary\.oss-cn-hangzhou\.aliyuncs\.com\//, (r) =>
    forward(r, r.request().url().replace('https://my-diary.oss-cn-hangzhou.aliyuncs.com/', `http://127.0.0.1:${oss.port}/my-diary/`)))
  await ctx.route(/^https:\/\/api\.github\.com\//, (r) => forward(r, r.request().url().replace('https://api.github.com', `http://127.0.0.1:${gh.port}`)))
  await ctx.route(/^https:\/\/api\.deepseek\.com\//, (r) => forward(r, r.request().url().replace('https://api.deepseek.com', `http://127.0.0.1:${llm.port}`)))
  await ctx.route(/^https:\/\/restapi\.amap\.com\//, (r) => {
    const u = new URL(r.request().url())
    const body = u.pathname.includes('regeo') ? AMAP.regeo : AMAP.around
    return r.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  await ctx.route(/^https:\/\/api\.open-meteo\.com\//, (r) =>
    r.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ current: { temperature_2m: 27.4, weather_code: 1 } }) }))
}

async function newPage(opts: { geo?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({
    ...DEVICE,
    ...(opts.geo ? { geolocation: { latitude: 23.109, longitude: 113.319, accuracy: 15 }, permissions: ['geolocation'] } : {}),
  })
  await wire(ctx)
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()))
  await page.goto(BASE)
  await page.waitForFunction(() => (window as unknown as { __diary?: unknown }).__diary && !document.body.innerText.includes('正在读取日记'))
  return { ctx, page, errors }
}

async function writeToday(page: Page, text: string) {
  await page.goto(BASE + '#/')
  await page.getByRole('button', { name: '写今天' }).click()
  await page.getByLabel('日记正文').waitFor()
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
  await page.keyboard.type(text)
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')
  // 浏览器先改 URL 再执行离开页面时的保存，所以等索引里出现这篇
  await page.waitForFunction((t) => (window as unknown as { __diary: { index: { all(): { text: string }[] } } }).__diary.index.all().some((r) => r.text.includes(t)), text)
}

async function until(fn: () => boolean | Promise<boolean>, ms = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

beforeAll(async () => {
  oss = await startOssMock({ bucket: OSS.bucket, region: 'cn-hangzhou', id: OSS.id, secret: OSS.secret })
  gh = await startGitHubMock({ owner: 'me', repo: 'diary', token: GH_TOKEN })
  llm = await startLlmMock(() => ({ text: '你好' }), { key: 'sk-e2e' })
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  await Promise.all([oss?.close(), gh?.close(), llm?.close()])
})

describe('阶段 2：同步与恢复', () => {
  it('配置 OSS、测试连接、开启后写一篇并退出编辑页，几秒内出现在 Bucket 中', async () => {
    const { ctx, page, errors } = await newPage()
    await page.goto(BASE + '#/settings/sync/oss')
    await page.getByPlaceholder('oss-cn-hangzhou.aliyuncs.com').fill('oss-cn-hangzhou.aliyuncs.com')
    await page.getByPlaceholder('my-diary').fill(OSS.bucket)
    await page.getByLabel('AccessKey ID').fill(OSS.id)
    await page.getByLabel('AccessKey Secret').fill(OSS.secret)
    await page.getByRole('button', { name: '测试连接' }).click()
    await page.getByText('连接成功').waitFor()
    await page.screenshot({ path: OUT + '20-oss-config.png' })
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/sync$/)
    await page.getByRole('switch', { name: '同步到阿里云 OSS' }).click()
    await page.locator('[role=switch][aria-label="同步到阿里云 OSS"][aria-checked="true"]').waitFor()

    await writeToday(page, '开了 OSS 同步之后写的第一篇。')
    const ok = await until(() => [...oss.objects.keys()].some((k) => k.startsWith('diary/entries/') && oss.objects.get(k)!.body.toString().includes('第一篇')))
    expect(ok).toBe(true)
    await page.locator('a[aria-label="已同步"]').waitFor({ timeout: 10000 })
    await page.screenshot({ path: OUT + '21-home-synced.png' })
    await page.goto(BASE + '#/settings/sync')
    await page.getByText(/^已同步/).first().waitFor()
    await page.screenshot({ path: OUT + '22-sync-settings.png' })
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('同时开启 GitHub：一次同步只产生一个 commit；GitHub 失败不影响 OSS', async () => {
    const { ctx, page } = await newPage()
    // OSS
    await page.goto(BASE + '#/settings/sync/oss')
    await page.getByPlaceholder('oss-cn-hangzhou.aliyuncs.com').fill('oss-cn-hangzhou.aliyuncs.com')
    await page.getByPlaceholder('my-diary').fill(OSS.bucket)
    await page.getByLabel('AccessKey ID').fill(OSS.id)
    await page.getByLabel('AccessKey Secret').fill(OSS.secret)
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/sync$/)
    // GitHub（故意填错 token）
    await page.goto(BASE + '#/settings/sync/github')
    await page.getByPlaceholder('your-name').fill('me')
    await page.getByPlaceholder('diary', { exact: true }).fill('diary')
    await page.getByLabel('Token').fill('wrong-token')
    await page.getByRole('button', { name: '测试连接' }).click()
    await page.getByText(/Token 无效/).waitFor()
    await page.getByLabel('Token').fill(GH_TOKEN)
    await page.getByRole('button', { name: '测试连接' }).click()
    await page.getByText('连接成功').waitFor()
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/sync$/)
    // 云端 OSS 已有上一个测试留下的日记，开启时会建议先恢复：这里选“直接开启”
    page.removeAllListeners('dialog')
    page.on('dialog', (d) => (d.message().includes('建议先从云端恢复') ? d.dismiss() : d.accept()))
    await page.getByRole('switch', { name: '同步到阿里云 OSS' }).click()
    await page.locator('[role=switch][aria-label="同步到阿里云 OSS"][aria-checked="true"]').waitFor()
    await page.getByRole('switch', { name: '同步到GitHub' }).click()
    await page.locator('[role=switch][aria-label="同步到GitHub"][aria-checked="true"]').waitFor()
    // 等初次同步完全结束（空仓库会先有一个初始化 commit，再有一次同步 commit）
    await page.waitForFunction(() => {
      const s = (window as unknown as { __diary: { syncState: Record<string, { status: string; pending: number }> } }).__diary.syncState
      return s.github.status === 'ok' && s.github.pending === 0 && s.oss.status !== 'syncing'
    }, null, { timeout: 20000 })
    const commits = gh.commits().length

    await writeToday(page, '两个都开着。')
    await until(() => gh.commits().length === commits + 1)
    expect(gh.commits().length).toBe(commits + 1)
    expect([...gh.files().keys()].some((k) => k.startsWith('entries/'))).toBe(true)

    // GitHub 改坏 token：OSS 照常完成
    await page.goto(BASE + '#/settings/sync/github')
    await page.getByLabel('Token').fill('bad')
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/sync$/)
    const before = oss.requests.length
    await page.goto(BASE + '#/')
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByLabel('日记正文').waitFor()
    await page.keyboard.press('End')
    await page.keyboard.type('再补一句。')
    await page.getByRole('button', { name: '返回' }).click()
    expect(await until(() => oss.requests.slice(before).some((r) => r.method === 'PUT' && r.key.includes('entries/')))).toBe(true)
    await page.goto(BASE + '#/settings/sync')
    await page.getByText(/^失败/).waitFor({ timeout: 15000 })
    await page.screenshot({ path: OUT + '23-sync-github-failed.png' })
    await ctx.close()
  })

  it('新手机：开启 OSS 时提示先恢复，恢复后日记都回来了', async () => {
    const { ctx, page } = await newPage()
    await page.goto(BASE + '#/settings/sync/oss')
    await page.getByPlaceholder('oss-cn-hangzhou.aliyuncs.com').fill('oss-cn-hangzhou.aliyuncs.com')
    await page.getByPlaceholder('my-diary').fill(OSS.bucket)
    await page.getByLabel('AccessKey ID').fill(OSS.id)
    await page.getByLabel('AccessKey Secret').fill(OSS.secret)
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/sync$/)
    const msgs: string[] = []
    page.removeAllListeners('dialog')
    page.on('dialog', (d) => {
      msgs.push(d.message())
      d.accept()
    })
    await page.getByRole('switch', { name: '同步到阿里云 OSS' }).click()
    await page.waitForURL(/#\/settings\/restore/)
    expect(msgs[0]).toMatch(/云端已有 \d+ 篇日记/)
    await page.getByText(/云端有/).waitFor()
    await page.screenshot({ path: OUT + '24-restore-preview.png' })
    await page.getByRole('button', { name: '开始恢复' }).click()
    await page.getByText(/恢复完成/).waitFor()
    await page.screenshot({ path: OUT + '25-restore-done.png' })
    await page.getByRole('button', { name: '回到日记' }).click()
    await page.getByText('两个都开着。').waitFor()
    // 恢复后不会全量重新上传
    const pending = await page.evaluate(() =>
      (window as unknown as { __diary: { engine: { pending(id: string): Promise<number> } } }).__diary.engine.pending('oss'))
    expect(pending).toBe(0)
    await ctx.close()
  })
})

describe('阶段 3：位置、天气与插图', () => {
  it('当天写日记自动记录地址和天气；附近地点可选；选中后加入“去过的地方”', async () => {
    const { ctx, page, errors } = await newPage({ geo: true })
    await page.goto(BASE + '#/settings/place')
    await page.getByLabel('Web 服务 key').fill('AMAP-KEY')
    await page.getByRole('button', { name: '现在定位一次试试' }).click()
    await page.getByText(/地址：广东省广州市/).waitFor()
    await page.getByText(/天气：晴间多云 27°C/).waitFor()
    await page.screenshot({ path: OUT + '30-place-settings.png' })

    await page.goto(BASE + '#/')
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByLabel('日记正文').waitFor()
    await page.getByRole('button', { name: /海珠区阅江西路/ }).waitFor()
    await page.getByRole('button', { name: '天气：晴间多云 27°C' }).waitFor()
    await page.keyboard.type('在塔下面散步。')
    await page.getByRole('button', { name: /海珠区阅江西路/ }).click()
    await page.getByRole('button', { name: /老王烧烤/ }).waitFor()
    await page.screenshot({ path: OUT + '31-nearby.png' })
    await page.getByRole('button', { name: /老王烧烤/ }).click()
    await page.getByRole('button', { name: '位置：老王烧烤' }).waitFor()
    await page.locator('.tok', { hasText: '老王烧烤' }).waitFor()
    await page.screenshot({ path: OUT + '32-editor-place.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: OUT + '32-editor-place-dark.png' })
    await page.emulateMedia({ colorScheme: 'light' })
    // 点天气只是打开查看，不会重新获取覆盖；不改直接完成，天气不变
    const weatherCalls = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('open-meteo')).length)
    await page.getByRole('button', { name: '天气：晴间多云 27°C' }).click()
    expect(await page.getByRole('textbox', { name: '天气', exact: true }).inputValue()).toBe('晴间多云')
    expect(await page.getByLabel('温度').inputValue()).toBe('27')
    await page.screenshot({ path: OUT + '34-weather-sheet.png' })
    await page.getByRole('button', { name: '完成' }).click()
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('open-meteo')).length)).toBe(weatherCalls)
    await page.getByRole('button', { name: '返回' }).click()
    await page.waitForURL(BASE + '#/')
    const raw: string = await page.evaluate(async () => {
      const d = (window as unknown as { __diary: { repo: { readEntryRaw(d: string): Promise<string> }; index: { all(): { date: string }[] } } }).__diary
      return d.repo.readEntryRaw(d.index.all()[0].date)
    })
    expect(raw).toMatch(/weather: \{text: 晴间多云, temp_c: 27\}/)
    expect(raw).toMatch(/location:\n  name: 老王烧烤\n  address: 艺苑路18号\n  lat: 23\.\d+\n  lng: 113\.\d+\n  crs: wgs84\n  amap_poi_id: B00140EAT1/)
    expect(raw).toContain('places: [老王烧烤]')
    expect(raw).not.toContain('locked')
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('拒绝定位权限时照常写作，位置和天气留空', async () => {
    const { ctx, page } = await newPage({ geo: false })
    await writeToday(page, '没有定位权限的一天。')
    const raw: string = await page.evaluate(async () => {
      const d = (window as unknown as { __diary: { repo: { readEntryRaw(d: string): Promise<string> }; index: { all(): { date: string }[] } } }).__diary
      return d.repo.readEntryRaw(d.index.all()[0].date)
    })
    expect(raw).toContain('没有定位权限的一天。')
    expect(raw).not.toContain('location:')
    await ctx.close()
  })

  it('插图：压缩后存进 attachments，正文插入相对路径，阅读视图能显示', async () => {
    const { ctx, page } = await newPage()
    await page.goto(BASE + '#/')
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByLabel('日记正文').waitFor()
    await page.keyboard.type('拍了一张照片。')
    // 生成一张 3000×2000 的 PNG 作为“相册里的照片”
    const png = await page.evaluate(async () => {
      const c = document.createElement('canvas')
      c.width = 3000
      c.height = 2000
      const g = c.getContext('2d')!
      g.fillStyle = '#3a6'
      g.fillRect(0, 0, 3000, 2000)
      g.fillStyle = '#fc3'
      g.beginPath()
      g.arc(1500, 1000, 600, 0, 7)
      g.fill()
      const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), 'image/png'))
      return Array.from(new Uint8Array(await b.arrayBuffer()))
    })
    await page.getByRole('button', { name: '插图' }).click()
    await page.getByRole('button', { name: '拍照' }).waitFor()
    await page.screenshot({ path: OUT + '35-image-source.png' })
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '从相册选' }).click()
    await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png) })
    await page.waitForFunction(() => (document.querySelector('textarea.input') as HTMLTextAreaElement).value.includes('attachments'))
    const text = await page.getByLabel('日记正文').inputValue()
    const m = /!\[\]\(\.\.\/\.\.\/attachments\/(\d{4})\/(\d{4}-\d{2}-\d{2})_1\.jpg\)/.exec(text)
    expect(m).not.toBeNull()
    const size = await page.evaluate(async (p) => {
      const b64 = await (window as unknown as { __diary: { repo: { store: { readBase64(p: string): Promise<string> } } } }).__diary.repo.store.readBase64(p)
      const img = new Image()
      img.src = 'data:image/jpeg;base64,' + b64
      await img.decode()
      return { w: img.naturalWidth, h: img.naturalHeight, bytes: (b64.length * 3) / 4 }
    }, `diary/attachments/${m![1]}/${m![2]}_1.jpg`)
    expect(size.w).toBe(2048)
    expect(size.h).toBe(1365)
    await page.getByRole('button', { name: '阅读视图' }).click()
    await page.waitForFunction(() => document.querySelector('article.reading img')?.getAttribute('src')?.startsWith('data:image/jpeg'))
    await page.screenshot({ path: OUT + '33-reading-image.png' })
    await ctx.close()
  })
})

describe('阶段 4：AI', () => {
  /** 一个会用工具的模型：问次数时先查词表再计数；抽取时返回 JSON；总结时返回一段文字 */
  const model: Script = ({ system, turns, tools }) => {
    if (system.includes('只输出 JSON')) return { text: '{"places":["老王烧烤"],"people":["阿杰"],"tags":["聚餐"]}' }
    if (system.includes('月度日记总结')) return { text: '## 这个月\n你常去老王烧烤，和阿杰聊了很多。' }
    if (tools.includes('get_time')) return { toolCalls: [{ name: 'get_time', args: {} }] }
    const calls = turns.filter((t) => t.role === 'assistant' && t.toolCalls).flatMap((t) => t.toolCalls!)
    const r = lastToolResult(turns)
    if (!calls.length) return { toolCalls: [{ name: 'list_values', args: { field: 'places', query: '老王' } }] }
    if (calls.length === 1) {
      const names = (r!.values as { value: string }[]).map((v) => v.value)
      return { toolCalls: [{ name: 'count_days', args: { terms: names.length ? names : ['老王烧烤'] } }] }
    }
    const dates = (r!.dates as { date: string }[]).map((d) => d.date)
    return { text: `你去了老王烧烤 **${r!.days} 天**。\n\n相关日期：${dates.join('、')}` }
  }

  it('添加服务、测试、问答（日期可点开）、批量标注、生成月度总结、词表合并', async () => {
    llm.script = model
    const { ctx, page, errors } = await newPage()
    // 准备数据：上个月和这个月各几篇
    await page.evaluate(async () => {
      const d = (window as unknown as { __diary: { repo: { store: { writeText(p: string, t: string): Promise<void> } } } }).__diary
      const now = new Date()
      const days = [1, 3, 9, 15, 33, 40, 47]
      for (const n of days) {
        const x = new Date(now)
        x.setDate(x.getDate() - n)
        const s = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
        const body = n % 2 ? '晚上和阿杰去老王烧烤撸串。' : '在家看书。'
        await d.repo.store.writeText(`diary/entries/${s.slice(0, 4)}/${s}.md`, `---\ndate: ${s}\nupdated: ${s}T21:00:00+08:00\n---\n\n${body}\n`)
      }
    })
    await page.reload()
    await page.waitForFunction(() => !document.body.innerText.includes('正在读取日记'))

    // 添加服务
    await page.goto(BASE + '#/ai')
    await page.getByText('先接上一个 AI 服务').waitFor()
    await page.screenshot({ path: OUT + '40-ai-empty.png' })
    await page.getByRole('link', { name: '添加 AI 服务' }).click()
    await page.getByRole('combobox').first().selectOption('DeepSeek')
    await page.getByLabel('模型名').fill('deepseek-test')
    await page.getByLabel('API Key').fill('sk-e2e')
    await page.getByRole('button', { name: '测试', exact: true }).click()
    await page.getByText(/支持工具调用/).waitFor()
    await page.screenshot({ path: OUT + '41-ai-profile.png' })
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/ai$/)

    // 问答
    await page.goto(BASE + '#/ai')
    await page.getByLabel('问题').fill('我去过几次老王烧烤？')
    await page.getByRole('button', { name: '发送' }).click()
    await page.getByText(/你去了老王烧烤/).waitFor()
    expect(await page.locator('.a strong').first().textContent()).toBe('6 天')
    expect(await page.locator('a.dl').count()).toBe(6)
    await page.getByText(/统计了/).waitFor()
    await page.screenshot({ path: OUT + '42-ai-answer.png' })
    await page.locator('a.dl').first().click()
    await page.waitForURL(/#\/entry\/\d{4}-\d{2}-\d{2}/)
    await page.goBack()

    // 批量标注
    await page.goto(BASE + '#/ai?tab=tidy')
    await page.getByText(/7.*篇还没标注/).waitFor()
    await page.getByRole('button', { name: '开始标注' }).click()
    await page.getByText(/0.*篇还没标注/).waitFor({ timeout: 30000 })
    await page.screenshot({ path: OUT + '43-ai-tidy.png' })

    // 词表合并：把“阿杰”改名为“杰哥”
    await page.getByRole('button', { name: '人物' }).click()
    await page.getByRole('button', { name: /^阿杰/ }).click()
    page.removeAllListeners('dialog')
    page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('杰哥') : d.accept()))
    await page.getByRole('button', { name: '改名' }).click()
    await page.getByText(/已改写 7 篇日记/).waitFor()
    await page.getByRole('button', { name: /^杰哥/ }).waitFor()

    // 首页提示生成上个月总结
    await page.goto(BASE + '#/')
    await page.getByText(/生成 \d+ 月的总结/).click()
    await page.getByText('你常去老王烧烤').waitFor({ timeout: 30000 })
    await page.getByText('最新').waitFor()
    await page.screenshot({ path: OUT + '44-summary.png' })
    // 手动修改后锁定
    await page.getByRole('button', { name: '手动修改' }).click()
    await page.getByLabel('总结内容').fill('我自己写的总结。')
    await page.getByRole('button', { name: '保存' }).click()
    await page.getByText(/已锁定/).waitFor()
    expect(await page.getByRole('button', { name: '重新生成' }).count()).toBe(0)

    // 总结列表
    await page.goto(BASE + '#/ai?tab=summary')
    await page.getByText('已锁定').first().waitFor()
    await page.screenshot({ path: OUT + '45-summary-list.png' })
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('编辑页 AI 标注：先预览，确认后写入；手动改过的字段不覆盖', async () => {
    llm.script = model
    const { ctx, page } = await newPage()
    await page.goto(BASE + '#/settings/ai/new')
    await page.getByRole('combobox').first().selectOption('DeepSeek')
    await page.getByLabel('模型名').fill('deepseek-test')
    await page.getByLabel('API Key').fill('sk-e2e')
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/ai$/)
    await page.goto(BASE + '#/')
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByLabel('日记正文').waitFor()
    await page.keyboard.type('和阿杰去了老王烧烤。')
    await page.getByRole('button', { name: '加标签' }).click()
    await page.getByPlaceholder('输入标签').fill('我的标签')
    await page.getByRole('button', { name: '添加' }).click()
    await page.getByRole('button', { name: '完成' }).click()
    await page.getByRole('button', { name: 'AI 标注' }).click()
    await page.getByText('你改过，不会覆盖').waitFor()
    await page.screenshot({ path: OUT + '46-editor-ai.png' })
    await page.getByRole('button', { name: '写入' }).click()
    await page.locator('.tok', { hasText: '#我的标签' }).waitFor()
    await page.locator('.tok', { hasText: '老王烧烤' }).waitFor()
    await page.getByRole('button', { name: '返回' }).click()
    const raw: string = await page.evaluate(async () => {
      const d = (window as unknown as { __diary: { repo: { readEntryRaw(d: string): Promise<string> }; index: { all(): { date: string }[] } } }).__diary
      return d.repo.readEntryRaw(d.index.all()[0].date)
    })
    expect(raw).toContain('tags: [我的标签]')
    expect(raw).toContain('people: [阿杰]')
    expect(raw).toContain('places: [老王烧烤]')
    expect(raw).toMatch(/ai:\n  extracted_at: .+\n  model: deepseek-test\n  fields: \[people, places\]\nlocked: \[tags\]/)
    await ctx.close()
  })
})


describe('阶段 5：提醒、应用锁、AI 补充说明', () => {
  async function typePin(page: Page, pin: string, ok = false) {
    for (const d of pin) await page.getByRole('button', { name: d, exact: true }).click()
    if (ok) await page.getByRole('button', { name: '确定' }).click()
  }
  async function setVisibility(page: Page, state: 'hidden' | 'visible') {
    await page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
  }

  it('设置 PIN 后重开要解锁；输错会提示；离开后按设定时间重新上锁；关闭需要旧 PIN', async () => {
    const { ctx, page, errors } = await newPage()
    await writeToday(page, '上锁之前写的一句。')
    await page.goto(BASE + '#/settings')
    await page.getByRole('link', { name: /应用锁/ }).click()
    await page.screenshot({ path: OUT + '50-lock-settings.png' })
    await page.getByRole('switch', { name: '启用应用锁' }).click()
    await page.getByText('设置新的 PIN').waitFor()
    await typePin(page, '2580', true)
    await page.getByText('再输一次').waitFor()
    await page.screenshot({ path: OUT + '51-pin-setup.png' })
    // 第二次输错：回到第一步
    await typePin(page, '2581', true)
    await page.getByText('两次输入不一样').waitFor()
    await typePin(page, '2580', true)
    await typePin(page, '2580', true)
    await page.getByRole('switch', { name: '启用应用锁' }).and(page.locator('[aria-checked="true"]')).waitFor()
    await page.getByLabel('离开多久后需要重新解锁').selectOption('0')

    // 重开 app
    await page.waitForTimeout(500)
    await page.goto(BASE + '#/')
    await page.reload()
    await page.getByText('观测站已上锁').waitFor()
    // 底下的内容不可交互
    expect(await page.locator('.shell').getAttribute('inert')).not.toBeNull()
    await typePin(page, '1111')
    await page.getByText('PIN 不对').waitFor()
    await page.screenshot({ path: OUT + '52-lock-screen.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: OUT + '52-lock-screen-dark.png' })
    await page.emulateMedia({ colorScheme: 'light' })
    await typePin(page, '2580')
    await page.getByText('观测站已上锁').waitFor({ state: 'detached' })
    await page.getByText('上锁之前写的一句。').waitFor()

    // 切到后台再回来（延迟设为“立即”）
    await setVisibility(page, 'hidden')
    await setVisibility(page, 'visible')
    await page.getByText('观测站已上锁').waitFor()
    await typePin(page, '2580')
    await page.getByText('观测站已上锁').waitFor({ state: 'detached' })

    // 关闭：要先输旧 PIN
    await page.goto(BASE + '#/settings/lock')
    await page.getByRole('switch', { name: '启用应用锁' }).click()
    await page.getByText('输入现在的 PIN').waitFor()
    await typePin(page, '0000')
    await page.getByText('PIN 不对').waitFor()
    await typePin(page, '2580')
    await page.getByRole('switch', { name: '启用应用锁' }).and(page.locator('[aria-checked="false"]')).waitFor()
    await page.reload()
    await page.waitForFunction(() => !document.body.innerText.includes('正在读取日记'))
    expect(await page.getByText('观测站已上锁').count()).toBe(0)
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('提醒设置页显示带月相的通知预览；AI 补充说明会保存', async () => {
    const { ctx, page, errors } = await newPage()
    await page.goto(BASE + '#/settings')
    await page.getByRole('link', { name: /写日记提醒/ }).click()
    await page.getByText('写一句今天的日记').waitFor()
    expect(await page.locator('.n-body').innerText()).toMatch(/^今晚/)
    await page.getByText('提醒只在手机上有效').waitFor()
    await page.screenshot({ path: OUT + '53-reminder.png' })

    await page.goto(BASE + '#/settings/ai')
    await page.getByPlaceholder(/小雨是我女朋友/).fill('阿杰是我大学室友。')
    await page.waitForTimeout(600)
    await page.screenshot({ path: OUT + '54-ai-notes.png', fullPage: true })
    await page.reload()
    await page.waitForFunction(() => !document.body.innerText.includes('正在读取日记'))
    expect(await page.getByPlaceholder(/小雨是我女朋友/).inputValue()).toBe('阿杰是我大学室友。')
    expect(errors).toEqual([])
    await ctx.close()
  })
})

describe('核对云端、加密、编辑快捷栏', () => {
  const PASS = 'orbit-nebula-42'
  async function configureOss(page: Page) {
    await page.goto(BASE + '#/settings/sync/oss')
    await page.getByPlaceholder('oss-cn-hangzhou.aliyuncs.com').fill('oss-cn-hangzhou.aliyuncs.com')
    await page.getByPlaceholder('my-diary').fill(OSS.bucket)
    await page.getByLabel('AccessKey ID').fill(OSS.id)
    await page.getByLabel('AccessKey Secret').fill(OSS.secret)
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/sync$/)
  }
  const entryKeys = () => [...oss.objects.keys()].filter((k) => k.startsWith('diary/entries/'))

  it('核对云端补传被删的文件；打开加密后云端只剩 .age；新手机输密码恢复', async () => {
    oss.objects.clear()
    const { ctx, page, errors } = await newPage()
    await configureOss(page)
    await page.getByRole('switch', { name: '同步到阿里云 OSS' }).click()
    await writeToday(page, '加密之前写的一篇。')
    expect(await until(() => entryKeys().length === 1)).toBe(true)
    const key = entryKeys()[0]

    // 在控制台里删掉了这篇：核对后补传
    oss.objects.delete(key)
    await page.goto(BASE + '#/settings/sync')
    await page.getByRole('button', { name: '核对' }).click()
    await page.getByText(/云端缺 1 个/).waitFor()
    expect(await until(() => oss.objects.has(key))).toBe(true)

    // 打开加密：先去设置密码，回来后自动把云端换成加密文件
    await page.getByRole('switch', { name: '加密阿里云 OSS 上的副本' }).click()
    await page.waitForURL(/#\/settings\/sync\/encryption/)
    await page.screenshot({ path: OUT + '60-encryption-setup.png', fullPage: true })
    await page.getByLabel('密码', { exact: true }).fill(PASS)
    await page.getByLabel('再输一次密码').fill('different-one')
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: '设置' }).click()
    await page.getByText('两次输入的密码不一样').waitFor()
    await page.getByLabel('再输一次密码').fill(PASS)
    await page.getByRole('button', { name: '设置' }).click()
    await page.waitForURL(/#\/settings\/sync$/, { timeout: 30000 })
    expect(await until(() => entryKeys().length > 0 && entryKeys().every((k) => k.endsWith('.age')), 30000)).toBe(true)
    expect(oss.objects.has('diary/_encryption/identity.age')).toBe(true)
    expect(oss.objects.get(key + '.age')!.body.toString('latin1').startsWith('age-encryption.org/v1')).toBe(true)
    expect([...oss.objects.keys()].filter((k) => !k.includes('_encryption/') && !k.endsWith('.age'))).toEqual([])
    await page.getByText(/^已同步/).first().waitFor()
    await page.screenshot({ path: OUT + '61-sync-encrypted.png', fullPage: true })
    expect(errors).toEqual([])
    await ctx.close()

    // 新手机
    const b = await newPage()
    await configureOss(b.page)
    await b.page.getByRole('switch', { name: '同步到阿里云 OSS' }).click()
    await b.page.waitForURL(/#\/settings\/restore/)
    await b.page.getByText('云端是加密的').waitFor()
    await b.page.getByLabel('同步加密密码').fill('wrong-password-1')
    await b.page.getByRole('button', { name: '开始恢复' }).click()
    await b.page.getByText(/恢复失败：密码不对/).waitFor({ timeout: 30000 })
    await b.page.getByLabel('同步加密密码').fill(PASS)
    await b.page.screenshot({ path: OUT + '62-restore-encrypted.png' })
    await b.page.getByRole('button', { name: '开始恢复' }).click()
    await b.page.getByText(/恢复完成/).waitFor({ timeout: 30000 })
    const texts: string[] = await b.page.evaluate(() =>
      (window as unknown as { __diary: { index: { all(): { text: string }[] } } }).__diary.index.all().map((r) => r.text))
    expect(texts.some((t) => t.includes('加密之前写的一篇。'))).toBe(true)
    // 恢复后继续加密同步，而且不需要重传
    await b.page.goto(BASE + '#/settings/sync')
    await b.page.locator('[role=switch][aria-label="加密阿里云 OSS 上的副本"][aria-checked="true"]').waitFor()
    await b.page.getByText(/^已同步|^已关闭/).first().waitFor()
    const pending = await b.page.evaluate(() => (window as unknown as { __diary: { syncState: { oss: { pending: number } } } }).__diary.syncState.oss.pending)
    expect(pending).toBe(0)
    expect(b.errors).toEqual([])
    await b.ctx.close()
  })

  it('编辑快捷栏：待办、列表续行、加粗；阅读视图里能勾选待办', async () => {
    const { ctx, page, errors } = await newPage()
    await page.goto(BASE + '#/')
    await page.getByRole('button', { name: '写今天' }).click()
    const ta = page.getByLabel('日记正文')
    await ta.waitFor()
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
    await page.getByRole('toolbar', { name: '格式' }).waitFor()
    await page.keyboard.type('购物：')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '待办' }).click()
    await page.keyboard.type('牛奶')
    await page.keyboard.press('Enter')
    await page.keyboard.type('面包')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter') // 空的一项上回车：结束列表
    await page.keyboard.type('然后')
    await page.getByRole('button', { name: '加粗' }).click()
    await page.keyboard.type('看星星')
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '编号' }).click()
    await page.keyboard.type('木星')
    await page.keyboard.press('Enter')
    await page.keyboard.type('土星')
    expect(await ta.inputValue()).toBe('购物：\n- [ ] 牛奶\n- [ ] 面包\n\n然后**看星星**\n1. 木星\n2. 土星')
    await page.screenshot({ path: OUT + '63-editor-toolbar.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: OUT + '63-editor-toolbar-dark.png' })
    await page.emulateMedia({ colorScheme: 'light' })

    // 撤销
    const before = await ta.inputValue()
    await page.getByRole('button', { name: '撤销' }).click()
    expect((await ta.inputValue()).length).toBeLessThan(before.length)
    await page.keyboard.press('Control+Shift+Z').catch(() => {})
    await ta.fill(before)

    // 阅读视图勾选第一个待办
    await page.getByRole('button', { name: '阅读视图' }).click()
    await page.locator('article.reading input[type=checkbox]').first().check()
    const date: string = await page.evaluate(() => location.hash.split('/').pop()!.split('?')[0])
    expect(await until(async () => (await page.evaluate((d) =>
      (window as unknown as { __diary: { repo: { readEntryRaw(d: string): Promise<string> } } }).__diary.repo.readEntryRaw(d), date)).includes('- [x] 牛奶'))).toBe(true)
    await page.screenshot({ path: OUT + '64-reading-tasks.png' })
    expect(errors).toEqual([])
    await ctx.close()
  })
})

describe('删除与最近删除、阅读视图换行、AI 高级设置', () => {
  const diary = (page: Page) => page.evaluate(() =>
    (window as unknown as { __diary: { index: { all(): { date: string; text: string }[] } } }).__diary.index.all().map((r) => r.text))

  it('阅读视图保留单个换行；删除后进最近删除，可以恢复', async () => {
    const { ctx, page, errors } = await newPage()
    await page.goto(BASE + '#/')
    await page.getByRole('button', { name: '写今天' }).click()
    await page.getByLabel('日记正文').waitFor()
    await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA')
    await page.keyboard.type('早上跑步五公里。')
    await page.keyboard.press('Enter')
    await page.keyboard.type('晚上看了木星和四颗卫星。')
    await page.getByRole('button', { name: '阅读视图' }).click()
    expect(await page.locator('article.reading br').count()).toBe(1)
    expect(await page.locator('article.reading').innerText()).toBe('早上跑步五公里。\n晚上看了木星和四颗卫星。')
    await page.screenshot({ path: OUT + '70-reading-breaks.png' })

    // 删除：按钮在顶栏，确认后回到首页
    await page.getByRole('button', { name: '删除这篇日记' }).click()
    await page.waitForURL(BASE + '#/')
    expect(await until(async () => !(await diary(page)).some((t) => t.includes('木星')))).toBe(true)

    await page.goto(BASE + '#/settings')
    await page.getByRole('link', { name: /最近删除/ }).click()
    await page.getByText('早上跑步五公里。').waitFor()
    await page.getByText(/30 天后彻底删除/).waitFor()
    await page.screenshot({ path: OUT + '71-trash.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: OUT + '71-trash-dark.png' })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('button', { name: '恢复' }).click()
    await page.getByText(/已恢复/).waitFor()
    await page.getByText('没有删除过的日记。').waitFor()
    expect((await diary(page)).some((t) => t.includes('木星'))).toBe(true)

    // 日历页：图例只剩心情文字
    await page.goto(BASE + '#/calendar')
    await page.getByText('每天下面是当晚的月相').waitFor()
    expect(await page.getByText('恒星光谱').count()).toBe(0)
    await page.screenshot({ path: OUT + '72-calendar.png' })
    expect(errors).toEqual([])
    await ctx.close()
  })

  it('AI 服务的高级设置和分功能说明会生效；回答下面显示 token 用量', async () => {
    llm.script = ({ tools }) => (tools.includes('get_time') ? { toolCalls: [{ name: 'get_time', args: {} }] } : { text: '这几天你常看星星。' })
    const { ctx, page, errors } = await newPage()
    await page.goto(BASE + '#/settings/ai/new')
    await page.getByRole('combobox').first().selectOption('DeepSeek')
    await page.getByLabel('模型名').fill('deepseek-test')
    await page.getByLabel('API Key').fill('sk-e2e')
    await page.getByRole('button', { name: /高级设置/ }).click()
    await page.getByLabel('上下文长度（tokens）').fill('32000')
    await page.getByLabel('额外请求参数（JSON）').fill('{oops')
    await page.getByRole('button', { name: '保存' }).click()
    await page.getByText('额外参数不是合法的 JSON').waitFor()
    await page.getByLabel('额外请求参数（JSON）').fill('{"enable_thinking": false}')
    await page.getByLabel('温度').fill('0.7')
    await page.getByRole('button', { name: '测试', exact: true }).click()
    await page.getByText(/支持工具调用/).waitFor()
    await page.screenshot({ path: OUT + '73-ai-profile-advanced.png', fullPage: true })
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/ai$|#\/ai$/)

    await page.goto(BASE + '#/settings/ai')
    await page.getByPlaceholder(/小雨是我女朋友/).fill('阿杰是我大学室友。')
    await page.getByRole('button', { name: '分功能的补充说明' }).click()
    await page.getByLabel('只给问答').fill('回答不超过三句话。')
    await page.getByLabel('只给总结').fill('口气轻松一点。')
    await page.waitForTimeout(600)
    await page.screenshot({ path: OUT + '74-ai-settings.png', fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: OUT + '74-ai-settings-dark.png', fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' })

    await page.goto(BASE + '#/ai')
    await page.getByLabel('问题', { exact: true }).fill('最近在忙什么？')
    await page.getByRole('button', { name: '发送' }).click()
    await page.getByText('这几天你常看星星。').waitFor()
    await page.getByText(/调用模型 1 次，输入 100，输出 10 tokens/).waitFor()
    await page.screenshot({ path: OUT + '75-ai-usage.png' })
    const body = llm.requests[llm.requests.length - 1].body as { enable_thinking?: boolean; temperature?: number; messages: { role: string; content: string }[] }
    expect(body.enable_thinking).toBe(false)
    expect(body.temperature).toBe(0.7)
    const system = body.messages[0].content
    expect(system).toContain('阿杰是我大学室友。')
    expect(system).toContain('回答不超过三句话。')
    expect(system).not.toContain('口气轻松一点。')
    expect(errors).toEqual([])
    await ctx.close()
  })
})

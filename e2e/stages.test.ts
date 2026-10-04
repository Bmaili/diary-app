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
    await page.getByRole('button', { name: '重新获取天气' }).filter({ hasText: '晴间多云 27°C' }).waitFor()
    await page.keyboard.type('在塔下面散步。')
    await page.getByRole('button', { name: /海珠区阅江西路/ }).click()
    await page.getByRole('button', { name: /老王烧烤/ }).waitFor()
    await page.screenshot({ path: OUT + '31-nearby.png' })
    await page.getByRole('button', { name: /老王烧烤/ }).click()
    await page.getByRole('button', { name: /^老王烧烤$/ }).first().waitFor()
    await page.screenshot({ path: OUT + '32-editor-place.png' })
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
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '插图' }).click()
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
    await page.getByRole('button', { name: '+ 标签' }).click()
    await page.getByPlaceholder('输入标签').fill('我的标签')
    await page.getByRole('button', { name: '添加' }).click()
    await page.getByRole('button', { name: '完成' }).click()
    await page.getByRole('button', { name: 'AI 标注' }).click()
    await page.getByText('你改过，不会覆盖').waitFor()
    await page.screenshot({ path: OUT + '46-editor-ai.png' })
    await page.getByRole('button', { name: '写入' }).click()
    await page.getByRole('button', { name: '#我的标签' }).waitFor()
    await page.getByRole('button', { name: '老王烧烤' }).waitFor()
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


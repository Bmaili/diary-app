/**
 * README 截图和“关于”页：用一份虚构的三个月日记，加一个会多轮查日记的模拟模型，
 * 拍下 AI 问答和月度总结的样子（e2e/out/readme-*.png），再看一眼关于页。
 * 日记里的人名、地名都是虚构的。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page, type Route } from 'playwright'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { startLlmMock, type LlmMock, type Turn } from '../tests/mocks/llmServer'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4176
const BASE = `http://127.0.0.1:${PORT}/`
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }

let server: ChildProcess
let browser: Browser
let llm: LlmMock

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const md = (s: string) => `${Number(s.slice(5, 7))} 月 ${Number(s.slice(8, 10))} 日`

interface Seed { date: string; mood: number; tags: string[]; people: string[]; places: string[]; weather: string; temp: number; body: string }

/** 从三个月前到昨天，大约七成的日子写了日记 */
function seedEntries(): Seed[] {
  const out: Seed[] = []
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth() - 3, 1)
  const weathers = ['晴', '多云', '小雨', '阴', '晴']
  let i = 0
  for (const d = new Date(start); d < today; d.setDate(d.getDate() + 1), i++) {
    if ((i * 7) % 10 >= 7) continue
    const date = ymd(d)
    const k = i % 9
    const w = weathers[i % weathers.length]
    const temp = 18 + ((i * 3) % 13)
    const s: Seed[] = [
      { date, mood: 4, tags: ['约会'], people: ['小雨'], places: ['江边公园'], weather: w, temp, body: '下班后和小雨去江边公园散步，风很舒服。她说想养一只猫，我们讨论了半天叫什么名字。' },
      { date, mood: 3, tags: ['工作'], people: ['阿杰'], places: ['公司'], weather: w, temp, body: '项目评审，阿杰的方案被挑了不少问题，晚上一起改到九点。' },
      { date, mood: 5, tags: ['聚餐'], people: ['小雨', '阿杰'], places: ['老王烧烤'], weather: w, temp, body: '周末和小雨、阿杰在老王烧烤吃到很晚，阿杰讲了他去西藏的事。' },
      { date, mood: 4, tags: ['运动'], people: [], places: ['健身房'], weather: w, temp, body: '去健身房练了腿，深蹲加到 80 公斤。' },
      { date, mood: 2, tags: ['工作'], people: [], places: ['公司'], weather: w, temp, body: '线上出了故障，排查到半夜，原来是时区问题。很累。' },
      { date, mood: 4, tags: ['读书'], people: [], places: ['图书馆'], weather: w, temp, body: '在图书馆读完了《置身事内》，对地方财政有了新的理解。' },
      { date, mood: 5, tags: ['旅行'], people: ['小雨'], places: ['海边'], weather: '晴', temp, body: '和小雨去海边，看了日出。今年最开心的一天。' },
      { date, mood: 3, tags: ['家人'], people: ['妈妈'], places: [], weather: w, temp, body: '给妈妈打电话，她说家里的桂花开了，让我国庆回去。' },
      { date, mood: 4, tags: ['读书'], people: ['小雨'], places: ['楼下面馆'], weather: w, temp, body: '和小雨在楼下面馆吃牛肉面，聊最近在读的书。' },
    ][k]
    out.push(s)
  }
  return out
}

function fileOf(s: Seed): string {
  const list = (k: string, v: string[]) => (v.length ? `${k}: [${v.join(', ')}]\n` : '')
  return `---\ndate: ${s.date}\ncreated: ${s.date}T21:30:00+08:00\nupdated: ${s.date}T21:30:00+08:00\n` +
    `weather: {text: ${s.weather}, temp_c: ${s.temp}}\nmood: ${s.mood}\n${list('tags', s.tags)}${list('people', s.people)}${list('places', s.places)}---\n\n${s.body}\n`
}

const seeds = seedEntries()
const now = new Date()
const lastMonth = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7)
const lm = Number(lastMonth.slice(5))
const inLast = seeds.filter((s) => s.date.startsWith(lastMonth))
const withYu = inLast.filter((s) => s.people.includes('小雨'))
const byPlace = new Map<string, string[]>()
for (const s of withYu) for (const p of s.places) byPlace.set(p, [...(byPlace.get(p) ?? []), s.date])
const sea = withYu.find((s) => s.places.includes('海边'))

/** 模拟模型：问答时先查词表、再计数、再读原文，最后写一段带表格的回答；总结时写一篇带小标题的月度总结 */
function script({ system, turns, tools }: { system: string; turns: Turn[]; tools: string[] }) {
  if (system.includes('月度日记总结')) {
    const moods = inLast.map((s) => s.mood)
    const good = moods.filter((m) => m >= 4).length
    return {
      text: `## ${lm} 月：忙碌里的小确幸\n\n这个月你写了 **${inLast.length} 篇**，其中 ${good} 天心情不错。工作上起起伏伏，生活里却有不少值得记住的时刻。\n\n` +
        `### 主要的事\n\n- **工作**：项目评审被挑了不少问题，你和阿杰一起改到很晚；中旬一次线上故障排查到半夜，最后发现是时区问题。\n` +
        `- **和小雨**：一起出门 ${withYu.length} 天${sea ? `，${md(sea.date)}去海边看日出，你写下“今年最开心的一天”` : ''}。她想养一只猫，你们为名字讨论了好久。\n` +
        `- **读书和运动**：读完《置身事内》；健身房的深蹲加到了 80 公斤。\n\n` +
        `### 常在一起的人和地方\n\n小雨出现得最多，其次是阿杰。常去的是江边公园、公司和老王烧烤。\n\n` +
        `### 情绪\n\n月初和月中被工作压得有点喘不过气，几次加班的日子心情都偏低；周末和小雨出门、和朋友吃烧烤的日子，心情明显好起来。月底妈妈打来电话说桂花开了，你开始期待国庆回家。`,
    }
  }
  if (tools.includes('get_time')) return { toolCalls: [{ name: 'get_time', args: {} }] }
  const calls = turns.filter((t) => t.role === 'assistant' && t.toolCalls).flatMap((t) => t.toolCalls!)
  const from = `${lastMonth}-01`
  const to = `${lastMonth}-31`
  if (calls.length === 0) return { toolCalls: [{ name: 'list_values', args: { field: 'people', query: '小雨' } }] }
  if (calls.length === 1) return { toolCalls: [{ name: 'count_days', args: { terms: ['小雨'], from, to } }] }
  if (calls.length === 2) return { toolCalls: [{ name: 'get_entries', args: { dates: withYu.map((s) => s.date) } }] }
  const rows = [...byPlace.entries()].sort((a, b) => b[1].length - a[1].length)
  return {
    text: `${lm} 月你和小雨一起出门 **${withYu.length} 天**（按天计，同一天去两个地方算一天），去了这些地方：\n\n` +
      `| 地方 | 天数 |\n| --- | --- |\n${rows.map(([p, d]) => `| ${p} | ${d.length} |`).join('\n')}\n\n` +
      `${sea ? `最特别的是 ${md(sea.date)}去海边看日出，你写下“今年最开心的一天”。` : ''}去江边公园最多，几乎都是下班后散步；有一次她说想养一只猫，你们讨论了半天名字。\n\n` +
      `相关日期：${withYu.map((s) => s.date).join('、')}`,
  }
}

async function forward(route: Route, url: string) {
  const req = route.request()
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
  const res = await route.fetch({ url, method: req.method(), headers: await req.allHeaders(), postData: req.postDataBuffer() ?? undefined })
  await route.fulfill({ status: res.status(), headers: { ...res.headers(), ...CORS }, body: await res.body() })
}

async function open(): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
  })
  await ctx.route(/^https:\/\/api\.deepseek\.com\//, (r) => forward(r, r.request().url().replace('https://api.deepseek.com', `http://127.0.0.1:${llm.port}`)))
  await ctx.route(/holiday-cn|jinrishici/, (r) => r.fulfill({ status: 404, headers: CORS, body: '' }))
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('dialog', (d) => d.accept())
  await page.goto(BASE)
  await page.waitForFunction(() => (window as unknown as { __diary?: unknown }).__diary && document.querySelector('.shell'))
  return { page, errors, close: () => ctx.close() }
}

beforeAll(async () => {
  llm = await startLlmMock(script, { key: 'sk-readme' })
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  await llm?.close()
})

describe('README 截图与关于页', () => {
  it('AI 问答（多轮查日记、表格回答）和月度总结', async () => {
    const { page, errors, close } = await open()
    await page.evaluate(async (files) => {
      const d = (window as unknown as { __diary: { repo: { store: { writeText(p: string, t: string): Promise<void> } } } }).__diary
      for (const [p, t] of files) await d.repo.store.writeText(p, t)
    }, seeds.map((s) => [`diary/entries/${s.date.slice(0, 4)}/${s.date}.md`, fileOf(s)] as [string, string]))
    await page.reload()
    await page.waitForFunction(() => document.querySelector('.shell'))

    await page.goto(BASE + '#/settings/ai/new')
    await page.getByRole('combobox').first().selectOption('DeepSeek')
    await page.getByLabel('模型名').fill('deepseek-chat')
    await page.getByLabel('API Key').fill('sk-readme')
    await page.getByRole('button', { name: '保存' }).click()
    await page.waitForURL(/#\/settings\/ai$|#\/ai$/)

    await page.goto(BASE + '#/ai')
    await page.getByLabel('问题', { exact: true }).fill(`${lm} 月我和小雨都去了哪些地方？`)
    await page.getByRole('button', { name: '发送' }).click()
    await page.getByText(/相关日期|一起出门/).first().waitFor()
    await page.locator('.a table').waitFor()
    expect(await page.locator('a.dl').count()).toBe(withYu.length)
    // 从顶上拍：标签页、问题、查询步骤和回答都在一屏里
    await page.evaluate(() => {
      window.scrollTo(0, 0)
      for (const el of document.querySelectorAll<HTMLElement>('*')) if (el.scrollTop) el.scrollTop = 0
    })
    await page.waitForTimeout(200)
    await page.screenshot({ path: OUT + 'readme-ai.png' })

    await page.goto(BASE + `#/ai/summary/${lastMonth}?generate=1`)
    await page.getByText('忙碌里的小确幸').waitFor({ timeout: 30000 })
    await page.screenshot({ path: OUT + 'readme-summary.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: OUT + 'readme-summary-dark.png' })
    await page.emulateMedia({ colorScheme: 'light' })

    await page.goto(BASE + '#/')
    await page.waitForTimeout(300)
    await page.screenshot({ path: OUT + 'readme-home.png' })
    if (sea) {
      await page.goto(BASE + `#/entry/${sea.date}`)
      await page.locator('article.reading').waitFor()
      await page.screenshot({ path: OUT + 'readme-entry.png' })
    }
    expect(errors).toEqual([])
    await close()
  })

  it('设置里的“关于”', async () => {
    const { page, errors, close } = await open()
    await page.goto(BASE + '#/settings')
    await page.getByRole('link', { name: /关于浮生记/ }).click()
    await page.getByText('浮生如寄，字有归处').waitFor()
    await page.getByText('solidity9527@gmail.com').waitFor()
    await page.getByText('github.com/Bmaili/diary-app').waitFor()
    await page.waitForFunction(() => (document.querySelector('.logo') as HTMLImageElement)?.complete)
    await page.screenshot({ path: OUT + '90-about.png' })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: OUT + '90-about-dark.png' })
    expect(errors).toEqual([])
    await close()
  })
})

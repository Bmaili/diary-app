// 端到端测试：在手机尺寸的 Chromium 里跑真实界面（构建产物），验证阶段 1 的界面相关验收项，并截图。
// 运行：npm run build && npm run e2e
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import JSZip from 'jszip'

const OUT = new URL('./out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })
const PORT = 4173
const BASE = `http://127.0.0.1:${PORT}/`

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  stdio: 'ignore',
})
await new Promise((r) => setTimeout(r, 2500))

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}


/** 等编辑页加载完成（输入框获得焦点或可见）再输入，避免把按键打到空处 */
async function editorReady(page) {
  await page.waitForFunction(() => document.querySelector('textarea.input'))
}
/** 已写过的日记默认是阅读视图，点右上角的笔进入编辑 */
async function toEdit(page) {
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await page.getByLabel('日记正文').waitFor()
}
/** “返回”时浏览器会先改 URL 再执行离开页面的保存，所以等文件内容满足条件，而不是等 URL */
async function waitFile(page, date, pred, timeout = 5000) {
  const t0 = Date.now()
  let raw = null
  while (Date.now() - t0 < timeout) {
    raw = await page.evaluate((d) => window.__diary.repo.readEntryRaw(d), date)
    if (pred(raw)) return raw
    await new Promise((r) => setTimeout(r, 100))
  }
  return raw
}

const browser = await chromium.launch()
const device = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  acceptDownloads: true,
  // 关掉动画，截图不会拍到切换到一半的画面
  reducedMotion: 'reduce',
}

try {
  // ---------- 1. 首次打开、写第一篇 ----------
  const ctx = await browser.newContext(device)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.clock.install({ time: new Date('2026-10-04T21:05:00+08:00') })
  await page.goto(BASE)
  await page.getByText('还没有日记').waitFor()
  await page.screenshot({ path: OUT + '01-empty.png' })

  await page.getByRole('button', { name: '写今天' }).click()
  await page.waitForURL(/#\/entry\/2026-10-04/)
  const ta = page.getByLabel('日记正文')
  await editorReady(page)
  check('打开编辑页即聚焦输入框', await ta.evaluate((el) => el === document.activeElement))
  await ta.pressSequentially('今天早上去江边公园跑了步，路上遇到小王。', { delay: 10 })
  // 拖动心情条：从中间拖到 3/4 处，松手应吸附到“不错”(4)
  const rail = await page.locator('.rail').boundingBox()
  const startX = rail.x + rail.width / 2
  const y = rail.y + rail.height / 2
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(rail.x + rail.width * 0.2, y, { steps: 6 })
  await page.screenshot({ path: OUT + '02a-dragging-sad.png' })
  await page.mouse.move(rail.x + rail.width * 0.72, y, { steps: 8 })
  await page.mouse.up()
  check('拖动心情条后吸附到最近一档', (await page.getByRole('slider', { name: '心情' }).getAttribute('aria-valuenow')) === '4')
  await page.getByRole('button', { name: '标签' }).click()
  await page.getByPlaceholder('输入标签').fill('运动')
  await page.getByRole('button', { name: '添加' }).click()
  await page.getByRole('button', { name: '完成' }).click()
  await page.clock.runFor(1500)
  await page.getByText('已保存').waitFor()
  await page.screenshot({ path: OUT + '02-editor.png' })

  const raw1 = await page.evaluate(() => window.__diary.repo.readEntryRaw('2026-10-04'))
  check(
    '保存的文件符合第 4 节格式',
    /^---\ndate: 2026-10-04\ncreated: 2026-10-04T21:05:\d\d\+08:00\nupdated: .*\nmood: 4\ntags: \[运动\]\nlocked: \[tags\]\n---\n\n今天早上去江边公园跑了步，路上遇到小王。\n$/.test(raw1),
    JSON.stringify(raw1),
  )

  // ---------- 2. 同一天第二次写 ----------
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')
  await page.clock.setFixedTime(new Date('2026-10-04T22:40:00+08:00'))
  await page.getByRole('button', { name: '写今天' }).click()
  await page.waitForURL(/append=1/)
  await editorReady(page)
  check('第二次写作出现 ### 22:40 标题', (await ta.inputValue()).endsWith('### 22:40\n'))
  await page.keyboard.type('晚上又读了一会儿书。')
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')
  const raw2 = await waitFile(page, '2026-10-04', (r) => r?.includes('晚上又读'))
  check('追加段落已写入文件', raw2.endsWith('遇到小王。\n\n### 22:40\n晚上又读了一会儿书。\n'), JSON.stringify(raw2.slice(-60)))

  // 什么都不写就离开：不留空标题
  await page.clock.setFixedTime(new Date('2026-10-04T23:10:00+08:00'))
  await page.getByRole('button', { name: '写今天' }).click()
  await page.waitForURL(/append=1/)
  await editorReady(page)
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')
  await page.waitForTimeout(800)
  const raw3 = await page.evaluate(() => window.__diary.repo.readEntryRaw('2026-10-04'))
  check('空的追加不留下标题', raw3 === raw2)
  await page.screenshot({ path: OUT + '03-home-one.png' })

  // ---------- 3. 凌晨 1 点算前一天 ----------
  await page.clock.setFixedTime(new Date('2026-10-05T01:00:00+08:00'))
  await page.getByRole('button', { name: '写今天' }).click()
  await page.waitForURL(/#\/entry\//)
  check('凌晨 1 点的“写今天”打开前一天', page.url().includes('/entry/2026-10-04'), page.url())
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')

  // ---------- 4. 持续打字时被杀：最多丢 1 秒 ----------
  await page.clock.setFixedTime(new Date('2026-10-06T20:00:00+08:00'))
  await page.getByRole('button', { name: '写今天' }).click()
  await page.waitForURL(/entry\/2026-10-06/)
  await editorReady(page)
  // 解除时间冻结，让真实计时器运行，模拟连续打字 4 秒不停顿
  await page.clock.resume()
  const typed = '一二三四五六七八九十'.repeat(4)
  const t0 = Date.now()
  for (const ch of typed) {
    await page.keyboard.type(ch)
    await page.waitForTimeout(100)
  }
  const elapsed = Date.now() - t0
  // 打完立即从另一个页面读盘（不触发离开、切后台等事件，相当于此刻被杀）
  const spy = await ctx.newPage()
  await spy.goto(BASE)
  await spy.waitForFunction(() => window.__diary)
  const onDisk = await spy.evaluate(async () => (await window.__diary.repo.readEntry('2026-10-06'))?.body ?? '')
  await spy.close()
  const lostChars = typed.length - onDisk.length
  const lostMs = lostChars * (elapsed / typed.length)
  check('连续打字中被杀，最多丢失约 1 秒输入', onDisk.length > 0 && typed.startsWith(onDisk) && lostMs <= 1300,
    `打了 ${typed.length} 字，用时 ${elapsed} ms；盘上 ${onDisk.length} 字，约丢 ${Math.round(lostMs)} ms`)
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')

  // ---------- 5. 未知字段 ----------
  await page.evaluate(() =>
    window.__diary.repo.store.writeText(
      'diary/entries/2026/2026-10-01.md',
      '---\ndate: 2026-10-01\nmy_custom: 别删我\nmood: 2\n---\n\n外部编辑器写的。\n',
    ),
  )
  await page.reload()
  await page.getByText('外部编辑器写的。').click()
  await page.waitForURL(/entry\/2026-10-01/)
  await editorReady(page)
  await page.locator('article.reading').waitFor()
  check('打开已写过的日记默认是阅读视图', await page.locator('article.reading').isVisible())
  await toEdit(page)
  await ta.press('End')
  await page.keyboard.type('在 app 里补了一句。')
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')
  const raw5 = await waitFile(page, '2026-10-01', (r) => r?.includes('补了一句'))
  check('未知字段经 app 编辑后仍在', raw5.includes('my_custom: 别删我') && raw5.includes('在 app 里补了一句'))

  // ---------- 6. 删空正文 ----------
  await page.getByText('外部编辑器写的').click()
  await page.waitForURL(/entry\/2026-10-01/)
  await editorReady(page)
  await toEdit(page)
  await ta.fill('')
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForURL(BASE + '#/')
  check('删空正文并确认后删除文件', (await waitFile(page, '2026-10-01', (r) => r === null)) === null)

  // ---------- 7. 大量数据：生成 3650 篇、搜索、重建索引 ----------
  // 大数据部分用真实时钟的独立环境：假时钟会冻结浏览器 IndexedDB 层依赖的计时器
  const ctx2 = await browser.newContext(device)
  const p2 = await ctx2.newPage()
  p2.on('pageerror', (e) => errors.push(e.message))
  await p2.goto(BASE)
  await p2.getByText('还没有日记').waitFor()
  await p2.evaluate(() => localStorage.setItem('CapacitorStorage.devMode', '1'))
  const todayReal = await p2.evaluate(() => {
    const d = new Date(); if (d.getHours() < 4) d.setDate(d.getDate() - 1)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  })
  const lastYear = String(Number(todayReal.slice(0, 4)) - 1) + todayReal.slice(4)
  await p2.evaluate((d) => window.__diary.repo.store.writeText(`diary/entries/${d.slice(0, 4)}/${d}.md`,
    `---\ndate: ${d}\nmood: 5\n---\n\n去年今天在江边公园看了日落。\n\n### 22:10\n\n晚上和阿杰吃了宵夜。\n`), lastYear)
  await p2.reload()
  await p2.getByRole('link', { name: '设置' }).click()
  await p2.getByLabel('篇数').fill('3650')
  const g0 = Date.now()
  await p2.getByRole('button', { name: '生成', exact: true }).click()
  await p2.getByText(/生成了 \d+ 篇测试日记/).waitFor({ timeout: 300000 })
  console.log(`      生成 3650 篇用时 ${Date.now() - g0} ms`)
  await p2.getByRole('button', { name: '重建', exact: true }).click()
  const rebuildMsg = await p2.getByText(/已从文件重建索引/).textContent({ timeout: 300000 })
  console.log(`      ${rebuildMsg}`)
  await p2.screenshot({ path: OUT + '07-settings.png', fullPage: true })

  const perf = await p2.evaluate(() => {
    const ix = window.__diary.index
    return ['茶', '电影', '江边公园', '小王 面馆'].map((q) => {
      const t = performance.now()
      const n = ix.search({ q }).length
      return { q, n, ms: performance.now() - t }
    })
  })
  for (const p of perf) check(`浏览器内搜索「${p.q}」200 毫秒内`, p.n > 0 && p.ms < 200, `${p.n} 篇，${p.ms.toFixed(1)} ms`)

  // 重建前后搜索结果一致
  const before = await p2.evaluate(() => window.__diary.index.search({ q: '电影' }).map((h) => h.row.date).join())
  await p2.evaluate(() => window.__diary.repo.store.remove('cache/index.json'))
  await p2.reload()
  await p2.waitForFunction(() => window.__diary && document.querySelector('.shell'), null, { timeout: 300000 })
  const after = await p2.evaluate(() => window.__diary.index.search({ q: '电影' }).map((h) => h.row.date).join())
  check('删除索引缓存后重建，搜索结果不变', before === after && before.length > 0,
    `前 ${before.split(',').length} 篇，后 ${after.split(',').length} 篇`)

  // 有缓存时的启动：到首页出现（3650 篇）
  {
    const times = []
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now()
      await p2.reload()
      await p2.waitForFunction(() => window.__diary && document.querySelector('.shell'), null, { timeout: 300000 })
      times.push(Date.now() - t0)
    }
    console.log(`      有缓存时启动到界面出现：${times.join(' / ')} ms`)
  }

  // ---------- 8. 界面：首页、那年今日、日历、搜索 ----------
  await p2.goto(BASE + '#/')
  console.log('      今天 =', await p2.evaluate(() => new Date().toString()), ' 索引篇数 =', await p2.evaluate(() => window.__diary.index.size))
  await p2.getByText('一年前的今天').first().waitFor()
  check('那年今日在往年同日有日记时出现', true)
  await p2.screenshot({ path: OUT + '08-home.png' })

  await p2.getByRole('link', { name: '日历' }).click()
  await p2.getByText(/这个月写了/).waitFor()
  await p2.screenshot({ path: OUT + '09-calendar.png' })

  await p2.getByRole('link', { name: '搜索' }).click()
  const s0 = Date.now()
  await p2.getByLabel('搜索关键词').fill('江边公园')
  await p2.getByText(/共 \d+ 篇/).waitFor()
  check('搜索页显示结果数与高亮', (await p2.locator('mark.hl').count()) > 0, `${Date.now() - s0} ms 含 150ms 输入防抖`)
  await p2.getByRole('button', { name: '筛选' }).click()
  await p2.getByRole('button', { name: /很好/ }).click()
  await p2.screenshot({ path: OUT + '10-search.png' })

  // 阅读视图
  await p2.goto(BASE + '#/entry/' + lastYear)
  await p2.locator('article.reading h3').waitFor()
  await p2.screenshot({ path: OUT + '11-reading.png' })

  // ---------- 9. 导出 zip ----------
  await p2.goto(BASE + '#/settings')
  const dl = p2.waitForEvent('download')
  await p2.getByRole('button', { name: '导出', exact: true }).click()
  const file = await (await dl).path()
  const zip = await JSZip.loadAsync(readFileSync(file))
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const zPath = `diary/entries/${lastYear.slice(0, 4)}/${lastYear}.md`
  const zEntry = await zip.file(zPath)?.async('string')
  const onDisk2 = await p2.evaluate((p) => window.__diary.repo.store.readText(p), zPath)
  check(
    '导出的 zip 包含全部日记且内容一致',
    names.includes('diary/README.md') && names.includes('diary/format.json') &&
      names.filter((n) => n.startsWith('diary/entries/')).length >= 3650 && zEntry === onDisk2,
    `${names.length} 个文件`,
  )

  // ---------- 10. 深色模式截图 ----------
  const dark = await browser.newContext({ ...device, colorScheme: 'dark' })
  const dp = await dark.newPage()
  await dp.goto(BASE)
  await dp.getByText('还没有日记').waitFor()
  // 写 45 天的样例（中间断几天），看深色模式下的首页和日历
  await dp.evaluate(() => {
    const lines = ['下班路上看到很圆的月亮。', '读完了《三体》第二部，面壁者那段太精彩。', '加班调了一晚上 bug，原来是时区问题。',
      '周末宅家打游戏，顺便把显示器支架装好了。', '试了新出的模型，写代码的能力又进步了。', '和阿杰去楼下面馆，聊了聊跳槽的事。']
    const jobs = []
    const now = new Date()
    for (let i = 1; i <= 45; i++) {
      if ([5, 6, 13, 21, 22, 23, 30].includes(i)) continue
      const d = new Date(now); d.setDate(d.getDate() - i); if (now.getHours() < 4) d.setDate(d.getDate() - 1)
      const ds = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const mood = i % 9 === 0 ? '' : `mood: ${1 + ((i * 7) % 5)}\n`
      const tags = i % 3 === 0 ? 'tags: [读书]\n' : i % 4 === 0 ? 'tags: [工作, AI]\n' : ''
      jobs.push(window.__diary.repo.store.writeText(`diary/entries/${ds.slice(0, 4)}/${ds}.md`,
        `---\ndate: ${ds}\n${mood}${tags}---\n\n${lines[i % lines.length]}${lines[(i + 2) % lines.length]}\n`))
    }
    return Promise.all(jobs)
  })
  await dp.reload()
  await dp.getByRole('button', { name: '写今天' }).waitFor()
  await dp.screenshot({ path: OUT + '13-dark-home.png' })
  await dp.getByRole('link', { name: '日历' }).click()
  await dp.getByText(/这个月/).first().waitFor()
  await dp.screenshot({ path: OUT + '14-dark-calendar.png' })
  await dp.getByRole('link', { name: 'AI' }).click()
  await dp.waitForTimeout(300)
  await dp.screenshot({ path: OUT + '15-dark-ai.png' })
  await dp.getByRole('link', { name: '日记' }).click()
  await dp.getByRole('button', { name: '写今天' }).click()
  await dp.getByLabel('日记正文').pressSequentially('深色模式下的样子。')
  await dp.screenshot({ path: OUT + '12-dark-editor.png' })
  await dark.close()

  check('页面没有脚本错误', errors.length === 0, errors.join(' | '))
} catch (e) {
  check('端到端流程跑完', false, e.stack)
} finally {
  await browser.close()
  server.kill()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length ? 1 : 0)

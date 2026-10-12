import { afterEach, describe, expect, it } from 'vitest'
import { captionContext, cleanCaption, listImages, setImageAlt } from '../src/core/imageCaption'
import { captionImage } from '../src/core/llm/caption'
import type { LlmConfig } from '../src/core/llm/client'
import { startLlmMock, type LlmMock } from './mocks/llmServer'

const md = `早上去江边。

![](../../attachments/2026/2026-10-05_1.jpg)

晚上吃烧烤。

![旧的说明](../../attachments/2026/2026-10-05_2.jpg)
![](https://example.com/x.png)`

describe('图片说明（Markdown 替代文字）', () => {
  it('列出本地图片，不含网络图片', () => {
    const imgs = listImages(md)
    expect(imgs.map((i) => [i.alt, i.src])).toEqual([
      ['', '../../attachments/2026/2026-10-05_1.jpg'],
      ['旧的说明', '../../attachments/2026/2026-10-05_2.jpg'],
    ])
  })

  it('改说明，返回改动位置供编辑框保持光标', () => {
    const r = setImageAlt(md, '../../attachments/2026/2026-10-05_1.jpg', '江边的芦苇')!
    expect(r.text).toContain('![江边的芦苇](../../attachments/2026/2026-10-05_1.jpg)')
    expect(r.delta).toBe(5)
    expect(r.at).toBe(md.indexOf('![](') + 2)
    const r2 = setImageAlt(r.text, '../../attachments/2026/2026-10-05_2.jpg', '')!
    expect(r2.text).toContain('![](../../attachments/2026/2026-10-05_2.jpg)')
    expect(r2.delta).toBe(-4)
    expect(setImageAlt(md, '../../attachments/2026/none.jpg', 'x')).toBeNull()
  })

  it('说明里的换行和方括号去掉，限制长度', () => {
    expect(cleanCaption(' 第一行\n第二行 [x] ')).toBe('第一行 第二行 x')
    expect(cleanCaption('字'.repeat(100))).toHaveLength(80)
  })
})

let mock: LlmMock
afterEach(() => mock?.close())
const cfg = (protocol: 'openai' | 'anthropic'): LlmConfig => ({
  protocol,
  baseUrl: protocol === 'openai' ? `http://127.0.0.1:${mock.port}/v1` : `http://127.0.0.1:${mock.port}`,
  model: 'vl-model',
  apiKey: 'sk-test',
})
const image = { mime: 'image/jpeg', data: 'AAAA' }

describe('AI 看图写说明', () => {
  it('openai：图片按 image_url 数据链接发送，附上日记内容', async () => {
    mock = await startLlmMock(({ turns }) => ({ text: turns[0].text?.includes('小雨') ? '“小雨在江边看日落。”' : '江边日落' }))
    const md = '和小雨去江边。![](../../attachments/a.jpg)'
    const t = await captionImage(cfg('openai'), image, { date: '2026-10-05', context: captionContext(md, '../../attachments/a.jpg', 0) })
    expect(t).toBe('小雨在江边看日落')
    const content = (mock.requests[0].body.messages as { role: string; content: unknown }[])[1].content as { type: string; image_url?: { url: string }; text?: string }[]
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } })
    expect(content[1].text).toContain('和小雨去江边。')
    expect(content[1].text).not.toContain('attachments')
    expect(content[1].text).toContain('和小雨去江边。【这张照片】')
    // 照片位置的约定由代码附在系统提示词后面
    expect(JSON.stringify(mock.requests[0].body.messages)).toContain('【这张照片】标出了照片在日记里的位置')
  })

  it('anthropic：图片按 base64 图片块发送', async () => {
    mock = await startLlmMock(() => ({ text: '一碗牛肉面' }))
    expect(await captionImage(cfg('anthropic'), image, { date: '2026-10-05' })).toBe('一碗牛肉面')
    const blocks = (mock.requests[0].body.messages as { content: { type: string; source?: unknown }[] }[])[0].content
    expect(blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } })
    expect(blocks[1].type).toBe('text')
  })

  it('模型不能看图（400）时提示换模型', async () => {
    mock = await startLlmMock(() => ({ text: 'x' }))
    mock.failNext = 1
    mock.failWith = { status: 400, message: 'image input is not supported' }
    await expect(captionImage(cfg('openai'), image, { date: '2026-10-05' })).rejects.toThrow('能看图')
  })
})

describe('看图写说明附上的日记内容', () => {
  const A = '../../attachments/2026/2026-10-05_1.webp'
  const B = '../../attachments/2026/2026-10-05_2.jpg'

  it('短日记：整篇发，标出照片位置，其他图换成说明，附上地点和人物', () => {
    const md = `早上去菜场。\n\n![青菜](${B})\n\n### 18:30\n和小雨去江边。\n\n![](${A})\n\n风很大。`
    const c = captionContext(md, A, 0, { location: '江边公园', places: ['江边公园', '老王烧烤'], people: ['小雨'] })
    expect(c).toContain('这一天的地点：江边公园、老王烧烤')
    expect(c).toContain('这一天提到的人：小雨')
    expect(c).toContain('早上去菜场。\n\n[图：青菜]')
    expect(c).toContain('和小雨去江边。\n\n【这张照片】\n\n风很大。')
    expect(c).not.toContain('attachments')
  })

  it('同一张图出现两次：按第几次标位置', () => {
    const md = `第一处 ![](${A}) 第二处 ![](${A})`
    expect(captionContext(md, A, 1)).toContain('第一处 [图] 第二处 【这张照片】')
  })

  it('长日记：只发照片所在的那一段', () => {
    const long = (s: string) => s.repeat(Math.ceil(800 / s.length))
    const md = `${long('上午的事。')}\n\n### 14:00\n下午去了植物园。\n![](${A})\n看到很多花。\n\n### 21:00\n${long('晚上的事。')}`
    const c = captionContext(md, A, 0)
    expect(c).toContain('### 14:00\n下午去了植物园。\n【这张照片】\n看到很多花。')
    expect(c).toContain('照片所在的一段')
    expect(c).not.toContain('上午的事')
    expect(c).not.toContain('晚上的事')
  })

  it('照片所在的一段也很长：取前后各约 750 字，在换行处断开', () => {
    const lines = (tag: string) => Array.from({ length: 60 }, (_, i) => `${tag}第${i}行写了一些比较长的字，凑够长度。`).join('\n')
    const md = `### 09:00\n${lines('前')}\n![](${A})\n${lines('后')}`
    const c = captionContext(md, A, 0)
    const body = c.slice(c.indexOf('：\n') + 2)
    expect(body).toContain('【这张照片】')
    expect(body.startsWith('（这是当天日记中照片所在的一段）') || body.startsWith('……')).toBe(true)
    expect(c).toContain('前第59行写了一些比较长的字，凑够长度。\n【这张照片】\n后第0行')
    expect(c).not.toContain('前第0行')
    expect(c).not.toContain('后第59行')
    const len = [...c].length
    expect(len).toBeGreaterThan(1200)
    expect(len).toBeLessThan(1800)
  })

  it('没有地点人物时只有日记', () => {
    expect(captionContext(`![](${A})`, A, 0)).toBe('日记（【这张照片】标出了照片的位置）：\n【这张照片】')
  })
})

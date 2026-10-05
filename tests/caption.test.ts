import { afterEach, describe, expect, it } from 'vitest'
import { cleanCaption, listImages, setImageAlt } from '../src/core/imageCaption'
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
  it('openai：图片按 image_url 数据链接发送，附上日记开头', async () => {
    mock = await startLlmMock(({ turns }) => ({ text: turns[0].text?.includes('小雨') ? '“小雨在江边看日落。”' : '江边日落' }))
    const t = await captionImage(cfg('openai'), image, { date: '2026-10-05', excerpt: '和小雨去江边。![](../../attachments/a.jpg)' })
    expect(t).toBe('小雨在江边看日落')
    const content = (mock.requests[0].body.messages as { role: string; content: unknown }[])[1].content as { type: string; image_url?: { url: string }; text?: string }[]
    expect(content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } })
    expect(content[1].text).toContain('和小雨去江边。')
    expect(content[1].text).not.toContain('attachments')
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

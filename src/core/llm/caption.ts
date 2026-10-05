/**
 * AI 看图写一句说明（2026-10-05 加入）。需要能看图的模型（如 qwen-vl、glm-4v、gpt-4o、Claude），
 * 不能看图的模型会报错或答非所问。同时附上这篇日记的开头，方便用上日记里的称呼。
 */
import { chat, LlmError, type ImagePart, type LlmConfig } from './client'
import { cleanCaption } from '../imageCaption'

const SYSTEM = `你给日记里的一张照片写一句说明，会显示在照片下面。
- 只输出这一句话，不要引号、不要解释，不超过 30 个字。
- 写看得见的内容：什么人、什么东西、在哪儿、在做什么、天气和光线。语气平实，像随手记下的。
- 日记正文里能对上照片的称呼和地名（比如“小雨”“老王烧烤”），可以用上；对不上就不要猜名字。`

export async function captionImage(cfg: LlmConfig, image: ImagePart, ctx: { date: string; excerpt?: string }): Promise<string> {
  const excerpt = ctx.excerpt?.replace(/!\[[^\]]*\]\([^)]*\)/g, '').trim().slice(0, 400)
  const user = `这是 ${ctx.date} 的日记里的照片。${excerpt ? `\n日记开头：\n${excerpt}` : ''}`
  let r
  try {
    r = await chat(cfg, { system: SYSTEM, messages: [{ role: 'user', content: user, images: [image] }], maxTokens: 300, temperature: 0.3 })
  } catch (e) {
    if (e instanceof LlmError && (e.status === 400 || e.status === 404 || e.status === 422)) {
      throw new LlmError(`${e.message}。这个模型可能不能看图：到“设置 → AI 服务”里给“图片说明”选一个能看图的模型`, e.status)
    }
    throw e
  }
  const text = cleanCaption(r.text.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '').replace(/[。.]$/, ''))
  if (!text) throw new LlmError('模型没有写出说明，可能不能看图')
  return text
}

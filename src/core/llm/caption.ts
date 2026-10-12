/**
 * AI 看图写一句说明（2026-10-05 加入）。需要能看图的模型（如 qwen-vl、glm-4v、gpt-4o、Claude），
 * 不能看图的模型会报错或答非所问。同时附上这一天的日记（照片所在的位置、地点和人物，
 * 见 imageCaption.ts 的 captionContext；2026-10-12 之前只附开头 400 字），方便用上日记里的称呼。
 */
import { chatText, LlmError, type ImagePart, type LlmConfig } from './client'
import { CAPTION_FIXED, PROMPTS } from './prompts'
import { cleanCaption } from '../imageCaption'


export async function captionImage(cfg: LlmConfig, image: ImagePart, ctx: { date: string; context?: string }, rules: string = PROMPTS.caption.text): Promise<string> {
  const user = `这是 ${ctx.date} 的日记里的照片。${ctx.context?.trim() ? `\n\n${ctx.context.trim()}` : ''}`
  let r
  try {
    r = await chatText(cfg, {
      system: `${rules.trim()}\n${CAPTION_FIXED}`,
      messages: [{ role: 'user', content: user, images: [image] }],
      maxTokens: 1000,
      temperature: 0.3,
    })
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

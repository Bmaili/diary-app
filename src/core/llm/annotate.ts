/**
 * 朱批（2026-10-13 加入）：读一篇日记，写一两句批语。格式要求在 ANNOTATE_FIXED（代码附加，用户改不掉）。
 */
import { chatText, LlmError, type LlmConfig } from './client'
import { ANNOTATE_FIXED, PROMPTS } from './prompts'
import { annotationPrompt, cleanAnnotation } from '../annotation'
import type { EntryDoc } from '../entryFile'

export async function annotateEntry(cfg: LlmConfig, doc: EntryDoc, rules: string = PROMPTS.annotate.text, avoid?: string): Promise<string> {
  const r = await chatText(cfg, {
    system: `${rules.trim()}\n\n${ANNOTATE_FIXED}`,
    messages: [{ role: 'user', content: annotationPrompt(doc, avoid) }],
    maxTokens: 1000,
    // 换一句时放开一点，免得又写出差不多的
    temperature: avoid ? 0.95 : 0.7,
  })
  const text = cleanAnnotation(r.text)
  if (!text) throw new LlmError('模型没有写出批语')
  return text
}

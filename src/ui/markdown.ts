/**
 * 日记、总结、AI 回答的 Markdown 渲染。
 * breaks: true —— 单个换行也显示为换行。手机上写日记习惯一行一句，按 CommonMark 默认规则这些行会被并成一段；
 * Obsidian 默认也是这样显示的。文件内容不受影响，只影响 app 里的显示。
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'

export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false, gfm: true, breaks: true }) as string)
}

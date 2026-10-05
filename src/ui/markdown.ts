/**
 * 日记、总结、AI 回答的 Markdown 渲染。
 * breaks: true —— 单个换行也显示为换行。手机上写日记习惯一行一句，按 CommonMark 默认规则这些行会被并成一段；
 * Obsidian 默认也是这样显示的。文件内容不受影响，只影响 app 里的显示。
 * 图片的替代文字就是图片说明（core/imageCaption.ts），显示在图片下面。
 */
import { Marked } from 'marked'
import DOMPurify from 'dompurify'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    image({ href, title, text }) {
      const img = `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''}>`
      return text.trim() ? `<span class="figure">${img}<span class="img-cap">${esc(text)}</span></span>` : img
    },
  },
})

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.parse(src, { async: false }) as string)
}

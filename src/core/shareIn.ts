/**
 * 从别的 app 分享进来（2026-10-13 加入，规格 5.15）：把分享来的文字、链接、图片拼成一段，接在今天的日记后面。
 * 这里只有和平台无关的拼接规则；读文件、存图、跳转见 shareService.ts 和 ui/editor/useShareIn.ts。
 */

const URL_RE = /https?:\/\/[^\s<>"'，。；、）)】]+/g

/** 分享的文字。浏览器分享网页时标题在 subject、链接在 text；标题已经在文字里时不重复 */
export function shareText(text: string, subject: string): string {
  const t = text.replace(/\r\n?/g, '\n').trim()
  const s = subject.replace(/\s+/g, ' ').trim()
  if (!s || t.includes(s)) return t
  if (!t) return s
  return `${s}\n${t}`
}

/**
 * 把分享来的一段接在编辑框文字后面。
 * 刚追加了时间标题（`### HH:mm` 后面紧跟换行）时直接接在标题下面（标题下面不空行），否则空一行再接。
 */
export function joinShare(before: string, block: string): string {
  if (!block) return before
  if (!before.trim()) return `${block}\n`
  if (/(^|\n)### \d{2}:\d{2}\n$/.test(before)) return `${before}${block}\n`
  return `${before.trimEnd()}\n\n${block}\n`
}

/** 提示条上的一句话：“放进了 2 张图和 1 个链接” */
export function shareSummary(images: number, text: string): string {
  const links = (text.match(URL_RE) ?? []).length
  const rest = text.replace(URL_RE, '').replace(/\s+/g, '')
  const parts: string[] = []
  if (images) parts.push(`${images} 张图`)
  if (links) parts.push(`${links} 个链接`)
  if (rest) parts.push(links ? '一些文字' : '一段文字')
  if (!parts.length) return '没有放进什么'
  const last = parts.pop()!
  return `放进了${/^\d/.test(parts[0] ?? last) ? ' ' : ''}${parts.length ? `${parts.join('、')}和${/^\d/.test(last) ? ' ' : ''}${last}` : last}`
}

export type ShareFileKind = 'image' | 'zip' | 'other'

export function shareFileKind(f: { name: string; mime: string }): ShareFileKind {
  const mime = f.mime.toLowerCase()
  const name = f.name.toLowerCase()
  if (mime.startsWith('image/') && !/svg/.test(mime)) return 'image'
  if (/zip/.test(mime) || name.endsWith('.zip')) return 'zip'
  if (!mime && /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/.test(name)) return 'image'
  return 'other'
}

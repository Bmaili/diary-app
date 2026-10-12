/**
 * 图片说明（2026-10-05 加入）：就是 Markdown 图片的替代文字 ![说明](路径)，
 * 不新增字段，别的 Markdown 编辑器里也能看到。AI 问答、总结读正文时也能读到这句说明。
 */

export interface ImageRef {
  /** 现在的说明，没有为空串 */
  alt: string
  /** 正文里写的路径，如 ../../attachments/2026/2026-10-05_1.jpg */
  src: string
  start: number
  end: number
}

const IMG = /!\[([^\]\n]*)\]\((\.\.\/\.\.\/attachments\/[^)\s]+)\)/g

/** 正文里引用的本地图片（按出现顺序） */
export function listImages(md: string): ImageRef[] {
  return [...md.matchAll(IMG)].map((m) => ({ alt: m[1], src: m[2], start: m.index!, end: m.index! + m[0].length }))
}

/** 说明里不能有换行和方括号（会破坏 Markdown），最长 80 字 */
export function cleanCaption(s: string): string {
  return [...s.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '').replace(/\s{2,}/g, ' ').trim()].slice(0, 80).join('')
}

/**
 * 改第 n 张（同一路径出现多次时按顺序数）引用 src 的图片的说明。
 * 返回新正文和改动位置、长度变化（编辑框据此保持光标）；找不到返回 null。
 */
export function setImageAlt(md: string, src: string, alt: string, nth = 0): { text: string; at: number; delta: number } | null {
  const hit = listImages(md).filter((i) => i.src === src)[nth]
  if (!hit) return null
  const next = cleanCaption(alt)
  if (next === hit.alt) return { text: md, at: hit.start, delta: 0 }
  const at = hit.start + 2
  return { text: md.slice(0, at) + next + md.slice(at + hit.alt.length), at, delta: next.length - hit.alt.length }
}

// ---------- 看图写说明时附上的日记内容（2026-10-12 起） ----------

/** 正文（去掉图片引用后）不超过这么多字时整篇发送 */
export const CAPTION_FULL_LIMIT = 1500
/** 太长时取照片前后各这么多字 */
export const CAPTION_SIDE = 750
/** 在发给 AI 的正文里标出照片的位置 */
export const IMAGE_MARK = '【这张照片】'

const SECTION = /^### \d{1,2}:\d{2}[ \t]*$/m

/** 照片前后各取 side 字，在换行处断开；截掉的地方用省略号 */
function around(text: string, at: number, side: number): string {
  let from = Math.max(0, at - side)
  let to = Math.min(text.length, at + IMAGE_MARK.length + side)
  if (from > 0) {
    const nl = text.indexOf('\n', from)
    if (nl >= 0 && nl < at) from = nl + 1
  }
  if (to < text.length) {
    const nl = text.lastIndexOf('\n', to)
    if (nl > at + IMAGE_MARK.length) to = nl
  }
  return `${from > 0 ? '……\n' : ''}${text.slice(from, to).trim()}${to < text.length ? '\n……' : ''}`
}

/**
 * 看图写说明时附上的日记内容：
 * - 正文不超过 1500 字：整篇发，用【这张照片】标出位置，其他图片换成“[图：说明]”；
 * - 更长：发照片所在的 `### HH:mm` 段落；这一段也超过 1500 字时，取照片前后各约 750 字；
 * - 附上这一天的地点（定位的地点名和 places）和人物（people）。
 * nth：同一张图在正文里出现几次时，是第几次。
 */
export function captionContext(
  md: string,
  src: string,
  nth: number,
  meta: { location?: string; places?: string[]; people?: string[] } = {},
): string {
  const target = listImages(md).filter((i) => i.src === src)[nth]
  const others = (s: string) => s.replace(IMG, (_, alt: string) => (alt ? `[图：${alt}]` : '[图]'))
  const text = (target ? `${others(md.slice(0, target.start))}${IMAGE_MARK}${others(md.slice(target.end))}` : others(md))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  let body = text
  const at = text.indexOf(IMAGE_MARK)
  if ([...text.replace(IMAGE_MARK, '')].length > CAPTION_FULL_LIMIT) {
    if (at < 0) {
      body = around(text, 0, CAPTION_FULL_LIMIT)
    } else {
      // 找照片所在的段落：从照片往前最近的 ### HH:mm 到下一个
      const before = text.slice(0, at)
      const heads = [...before.matchAll(new RegExp(SECTION.source, 'gm'))]
      const secStart = heads.length ? heads[heads.length - 1].index! : 0
      const next = text.slice(at).search(SECTION)
      const secEnd = next < 0 ? text.length : at + next
      const sec = text.slice(secStart, secEnd).trim()
      const pos = sec.indexOf(IMAGE_MARK)
      body = [...sec.replace(IMAGE_MARK, '')].length <= CAPTION_FULL_LIMIT ? sec : around(sec, pos, CAPTION_SIDE)
      if (secStart > 0 || secEnd < text.length) body = `（这是当天日记中照片所在的一段）\n${body}`
    }
  }
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.map((x) => x?.trim()).filter(Boolean))] as string[]
  const places = uniq([meta.location, ...(meta.places ?? [])])
  const people = uniq(meta.people ?? [])
  const lines: string[] = []
  if (places.length) lines.push(`这一天的地点：${places.join('、')}`)
  if (people.length) lines.push(`这一天提到的人：${people.join('、')}`)
  if (body) lines.push(`日记${body.includes(IMAGE_MARK) ? `（${IMAGE_MARK}标出了照片的位置）` : ''}：\n${body}`)
  return lines.join('\n')
}

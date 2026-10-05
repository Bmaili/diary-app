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

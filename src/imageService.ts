/**
 * 插图（规格 4.4 第 7 条）：长边压到 2048px、JPEG 质量 85，存到 attachments/YYYY/，正文用相对路径引用。
 * 选图用系统的文件选择器（WebView 的 <input type=file>），可以从相册选或拍照，不需要存储权限。
 */
import { store } from './app'
import { ROOT } from './core/repo'
import { toBase64 } from './core/bytes'

export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => resolve(input.files?.[0] ?? null)
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

export async function compress(file: Blob, maxEdge = 2048, quality = 0.85): Promise<Uint8Array> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
  const w = Math.round(bmp.width * scale)
  const h = Math.round(bmp.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('压缩失败'))), 'image/jpeg', quality))
  return new Uint8Array(await blob.arrayBuffer())
}

/** 保存图片，返回在正文里引用它的 Markdown */
export async function saveImage(date: string, bytes: Uint8Array): Promise<string> {
  const year = date.slice(0, 4)
  const dir = `${ROOT}/attachments/${year}`
  const used = new Set((await store.list(dir)).map((f) => f.name))
  let n = 1
  while (used.has(`${date}_${n}.jpg`)) n++
  const name = `${date}_${n}.jpg`
  await store.writeBase64(`${dir}/${name}`, toBase64(bytes))
  return `![](../../attachments/${year}/${name})`
}

const cache = new Map<string, string>()

/** 阅读视图里把相对路径的图片换成 data URL */
export async function resolveImages(html: string): Promise<string> {
  const srcs = new Set<string>()
  html.replace(/<img[^>]+src="(\.\.\/\.\.\/attachments\/[^"]+)"/g, (_, s: string) => {
    srcs.add(s)
    return ''
  })
  for (const s of srcs) {
    if (cache.has(s)) continue
    const path = `${ROOT}/${s.replace(/^\.\.\/\.\.\//, '')}`
    const b64 = await store.readBase64(decodeURI(path))
    if (b64) cache.set(s, `data:image/jpeg;base64,${b64}`)
  }
  return html.replace(/(<img[^>]+src=")(\.\.\/\.\.\/attachments\/[^"]+)(")/g, (m, a: string, s: string, b: string) =>
    cache.has(s) ? a + cache.get(s) + b : m,
  )
}

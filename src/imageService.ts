/**
 * 插图（规格 4.4 第 7 条）：长边压到 2560px、WebP（2026-10-12 起；之前是 2048px JPEG），
 * 存到 attachments/YYYY/，正文用相对路径引用。旧的 .jpg 原样保留。
 * 选图默认调起手机自带的相册（见 pickImages），拍照用 WebView 的 <input capture>，都不需要存储权限。
 */
import { store } from './app'
import { ROOT } from './core/repo'
import { fromBase64, toBase64 } from './core/bytes'
import type { ImagePart } from './core/llm/client'
import { expectExternal } from './lockService'
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { cleanIntake, GalleryUnavailable, pickFromGallery, readIntakeFile, type IntakeFile } from './platform/intake'

/**
 * 拍照时系统相机把原图写在 app 外部目录的 Pictures/JPEG_*.jpg（Capacitor 的做法），
 * 压缩存进日记后这些原图就没用了，每张好几 MB，在这里清掉。
 */
export async function cleanCameraTemp(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    const r = await Filesystem.readdir({ path: 'Pictures', directory: Directory.External })
    for (const f of r.files) {
      if (/^JPEG_.*\.jpg$/.test(f.name)) await Filesystem.deleteFile({ path: `Pictures/${f.name}`, directory: Directory.External }).catch(() => {})
    }
  } catch { /* 目录不存在 */ }
}

/** 用网页的选文件（<input type=file>）选图：拍照时只要一张，系统选择器可以多选 */
function pickByInput(source: 'camera' | 'files'): Promise<Blob[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (source === 'camera') input.setAttribute('capture', 'environment')
    else input.multiple = true
    const done = expectExternal()
    input.onchange = () => {
      done()
      const files = Array.from(input.files ?? [])
      resolve(files.length ? files : null)
    }
    input.addEventListener('cancel', () => {
      done()
      resolve(null)
    })
    input.click()
  })
}

export interface PickedImages {
  blobs: Blob[]
  /** 处理完后调用：删掉复制到缓存目录的原图 */
  done: () => void
  /** 退回系统选择器等需要告诉用户的事 */
  note?: string
}

/**
 * 选图（2026-10-13 起）：
 * - camera：直接打开相机拍一张（安卓 WebView 收到 capture 属性后调系统相机，第一次会请求相机权限）。
 *   拍的照片只进日记，不会存进系统相册。
 * - gallery：调起手机自带的相册（ACTION_PICK，能看到所有文件夹，可以多选）；
 *   相册用不了时退回系统的选择器。浏览器里直接用选文件。
 * - files：系统的选择器（新版安卓是照片选择器，只有按时间排的照片和几个固定相册），可以多选。
 * 返回 null 表示没选。
 */
export async function pickImages(source: 'camera' | 'gallery' | 'files'): Promise<PickedImages | null> {
  if (source === 'gallery' && Capacitor.isNativePlatform()) {
    const done = expectExternal()
    let files: IntakeFile[] | null
    try {
      files = await pickFromGallery(true)
    } catch (e) {
      if (!(e instanceof GalleryUnavailable)) throw e
      done()
      const blobs = await pickByInput('files')
      return blobs && { blobs, done: () => {}, note: '没能打开手机相册，换成了系统的选择器。' }
    } finally {
      done()
    }
    if (!files?.length) return null
    const got = files
    const blobs: Blob[] = []
    for (const f of got) blobs.push(await readIntakeFile(f))
    return { blobs, done: () => cleanIntake(got) }
  }
  const blobs = await pickByInput(source === 'camera' ? 'camera' : 'files')
  return blobs && { blobs, done: () => {} }
}

export type ImageMime = 'image/webp' | 'image/jpeg'
export interface Compressed {
  bytes: Uint8Array
  mime: ImageMime
}

/** 存进日记的图片：长边 2560、WebP 质量 0.82（同样大小比 JPEG 清楚，放大看也够用） */
export const STORE_IMAGE = { maxEdge: 2560, quality: 0.82, mime: 'image/webp' as ImageMime }

export const extOf = (mime: string): string => (mime === 'image/webp' ? 'webp' : 'jpg')
export const mimeOfPath = (path: string): ImageMime => (/\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg')

function newCanvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

/**
 * 缩放到 w×h。一步从四千多像素缩到两千多时，浏览器的平滑默认是“低”，采样太少，细节发虚、边缘发毛
 * （2026-10-12 之前照片“有点糊”的主要原因）。现在开高质量平滑，并且每次最多缩一半，逐级缩到目标尺寸。
 */
export function drawScaled(src: CanvasImageSource & { width: number; height: number }, w: number, h: number): HTMLCanvasElement {
  let cur: CanvasImageSource = src
  let cw = src.width
  let ch = src.height
  while (cw / 2 > w && ch / 2 > h) {
    const nw = Math.round(cw / 2)
    const nh = Math.round(ch / 2)
    const step = newCanvas(nw, nh)
    step.drawImage(cur, 0, 0, nw, nh)
    if (cur instanceof HTMLCanvasElement) cur.width = 0 // 尽早释放上一级
    cur = step.canvas
    cw = nw
    ch = nh
  }
  const out = newCanvas(w, h)
  // 透明图（截图、PNG）铺白底，和以前一致
  out.fillStyle = '#fff'
  out.fillRect(0, 0, w, h)
  out.drawImage(cur, 0, 0, w, h)
  if (cur instanceof HTMLCanvasElement && cur !== out.canvas) cur.width = 0
  return out.canvas
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob> {
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('压缩失败'))), mime, quality))
}

/**
 * 压缩图片。要 WebP 而浏览器编码不了时，canvas 不报错、悄悄给 PNG（体积是 JPEG 的好几倍），
 * 所以核对实际类型，不是 WebP 就改用 JPEG。
 */
export async function compress(file: Blob, opts: { maxEdge?: number; quality?: number; mime?: ImageMime } = {}): Promise<Compressed> {
  const { maxEdge, quality, mime } = { ...STORE_IMAGE, ...opts }
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
  const canvas = drawScaled(bmp, Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)))
  bmp.close()
  try {
    let blob = await toBlob(canvas, mime, quality)
    let got: ImageMime = mime
    if (blob.type !== mime) {
      blob = await toBlob(canvas, 'image/jpeg', Math.min(0.9, quality + 0.06))
      got = 'image/jpeg'
    }
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: got }
  } finally {
    canvas.width = 0
  }
}

/** 保存图片，返回在正文里引用它的 Markdown */
export async function saveImage(date: string, img: Compressed): Promise<string> {
  const year = date.slice(0, 4)
  const dir = `${ROOT}/attachments/${year}`
  // 编号不分扩展名：已有 _1.jpg 时新图是 _2.webp，不会出现同号不同格式的两张
  const used = new Set((await store.list(dir)).map((f) => f.name.replace(/\.[^.]+$/, '')))
  let n = 1
  while (used.has(`${date}_${n}`)) n++
  const name = `${date}_${n}.${extOf(img.mime)}`
  await store.writeBase64(`${dir}/${name}`, toBase64(img.bytes))
  return `![](../../attachments/${year}/${name})`
}

/** 正文里的相对路径 → 仓库里的路径 */
function repoPath(src: string): string {
  return decodeURI(`${ROOT}/${src.replace(/^\.\.\/\.\.\//, '')}`)
}

/** 读出日记里的一张图 */
async function readImage(src: string): Promise<Blob> {
  const path = repoPath(src)
  const b64 = await store.readBase64(path)
  if (!b64) throw new Error('找不到这张图片')
  return new Blob([fromBase64(b64) as BlobPart], { type: mimeOfPath(path) })
}

/** 发给 AI 看的图：长边缩到 1024 的 JPEG（各家模型对 JPEG 支持最稳），省流量也省 token */
export async function imageForAi(src: string): Promise<ImagePart> {
  const small = await compress(await readImage(src), { maxEdge: 1024, quality: 0.8, mime: 'image/jpeg' })
  return { mime: 'image/jpeg', data: toBase64(small.bytes) }
}

/** 分享给别的 app 的图：转成 JPEG（有的手机或 app 不认识 WebP），尺寸不变 */
export async function imageForShare(src: string): Promise<Uint8Array> {
  return (await compress(await readImage(src), { maxEdge: 100000, quality: 0.92, mime: 'image/jpeg' })).bytes
}

/**
 * 显示图片用的地址（2026-10-08 起）。
 * 真机：用 Capacitor.convertFileSrc 让 WebView 直接读文件，不经过插件通道传 base64，也不在 JS 里留副本
 * （以前每看过一张图就在内存里存一份 base64，翻看的图越多内存越高）。地址后面带上修改时间，
 * 删掉日记后同名的新图不会显示成旧图。
 * 浏览器调试：文件在 IndexedDB 里，只能用 data URL，最多缓存最近的 24 张。
 */
const WEB_CACHE_MAX = 24
const webCache = new Map<string, string>()
let rootUri: string | null = null

async function displayUrl(src: string): Promise<string> {
  const path = repoPath(src)
  if (Capacitor.isNativePlatform()) {
    const st = await store.stat(path)
    if (!st) return ''
    rootUri ??= (await Filesystem.getUri({ path: ROOT, directory: Directory.Data })).uri.replace(/\/+$/, '')
    return `${Capacitor.convertFileSrc(`${rootUri}/${path.slice(ROOT.length + 1)}`)}?v=${st.mtime}`
  }
  const hit = webCache.get(src)
  if (hit) {
    // 最近用过的挪到最后，淘汰时从最前面删
    webCache.delete(src)
    webCache.set(src, hit)
    return hit
  }
  const b64 = await store.readBase64(path)
  if (!b64) return ''
  const url = `data:${mimeOfPath(path)};base64,${b64}`
  webCache.set(src, url)
  while (webCache.size > WEB_CACHE_MAX) webCache.delete(webCache.keys().next().value!)
  return url
}

/** 一张图的显示地址（说明框里用） */
export function imageUrl(src: string): Promise<string> {
  return displayUrl(src)
}

/** 阅读视图里把相对路径的图片换成可显示的地址 */
export async function resolveImages(html: string): Promise<string> {
  const srcs = new Set<string>()
  html.replace(/<img[^>]+src="(\.\.\/\.\.\/attachments\/[^"]+)"/g, (_, s: string) => {
    srcs.add(s)
    return ''
  })
  const urls = new Map<string, string>()
  for (const s of srcs) {
    const u = await displayUrl(s).catch(() => '')
    if (u) urls.set(s, u)
  }
  // data-src 记下原来的路径，点图片改说明时用
  return html.replace(/(<img[^>]+src=")(\.\.\/\.\.\/attachments\/[^"]+)(")/g, (m, a: string, s: string, b: string) =>
    urls.has(s) ? `${a}${urls.get(s)}${b} data-src="${s}"` : m,
  )
}

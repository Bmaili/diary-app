/**
 * 插图（规格 4.4 第 7 条）：长边压到 2048px、JPEG 质量 85，存到 attachments/YYYY/，正文用相对路径引用。
 * 选图用系统的文件选择器（WebView 的 <input type=file>），可以从相册选或拍照，不需要存储权限。
 */
import { store } from './app'
import { ROOT } from './core/repo'
import { fromBase64, toBase64 } from './core/bytes'
import type { ImagePart } from './core/llm/client'
import { expectExternal } from './lockService'
import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

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

/**
 * camera：直接打开相机拍一张（安卓 WebView 收到 capture 属性后调系统相机，第一次会请求相机权限）。
 * 拍的照片只进日记，不会存进系统相册。
 */
export function pickImage(source: 'camera' | 'gallery' = 'gallery'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    if (source === 'camera') input.setAttribute('capture', 'environment')
    const done = expectExternal()
    input.onchange = () => {
      done()
      resolve(input.files?.[0] ?? null)
    }
    input.addEventListener('cancel', () => {
      done()
      resolve(null)
    })
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

/** 正文里的相对路径 → 仓库里的路径 */
function repoPath(src: string): string {
  return decodeURI(`${ROOT}/${src.replace(/^\.\.\/\.\.\//, '')}`)
}

/** 发给 AI 看的图：长边缩到 1024，省流量也省 token */
export async function imageForAi(src: string): Promise<ImagePart> {
  const b64 = await store.readBase64(repoPath(src))
  if (!b64) throw new Error('找不到这张图片')
  const small = await compress(new Blob([fromBase64(b64) as BlobPart], { type: 'image/jpeg' }), 1024, 0.8)
  return { mime: 'image/jpeg', data: toBase64(small) }
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
  const url = `data:image/jpeg;base64,${b64}`
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

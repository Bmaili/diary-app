/**
 * 原生插件 Intake（android/.../IntakePlugin.java，2026-10-13 加入）：
 * - pickImages：调起手机自带的相册选图（能看到所有文件夹，可以多选）；
 * - 'share' 事件：别的 app 分享进来的文字、链接、图片、zip。
 * 两者都把文件复制到 app 的缓存目录，这里用 Capacitor.convertFileSrc 读成 Blob，用完调 cleanIntake 删掉。
 * 浏览器里没有这个插件：选图退回 <input type=file>，分享进来只有测试会用（见 shareService）。
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface IntakeFile {
  /** 缓存目录里的绝对路径（测试里可以是 data: 地址） */
  path: string
  name: string
  mime: string
  size: number
}

export interface SharePayload {
  text: string
  subject: string
  files: IntakeFile[]
  /** 收不下或读不了的文件个数 */
  skipped: number
}

interface IntakePlugin {
  pickImages(o: { multiple: boolean }): Promise<{ files: IntakeFile[]; cancelled?: boolean; skipped?: number }>
  clean(o: { paths?: string[] }): Promise<void>
  addListener(event: 'share', cb: (p: SharePayload) => void): Promise<PluginListenerHandle>
}

const Intake = registerPlugin<IntakePlugin>('Intake')

/** 手机自带的相册用不了（没有相册 app，或者相册没给读取授权）：调用方退回系统的选择器 */
export class GalleryUnavailable extends Error {}

/** 调起相册选图。返回 null 表示用户取消 */
export async function pickFromGallery(multiple = true): Promise<IntakeFile[] | null> {
  if (!Capacitor.isNativePlatform()) throw new GalleryUnavailable('浏览器里没有相册')
  try {
    const r = await Intake.pickImages({ multiple })
    if (r.cancelled) return null
    return r.files ?? []
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'UNAVAILABLE' || code === 'DENIED' || code === 'UNIMPLEMENTED') throw new GalleryUnavailable((e as Error).message)
    throw e
  }
}

/** 读出复制好的文件 */
export async function readIntakeFile(f: IntakeFile): Promise<Blob> {
  const r = await fetch(Capacitor.convertFileSrc(f.path))
  if (!r.ok) throw new Error(`读不到 ${f.name || '文件'}`)
  const b = await r.blob()
  return f.mime && b.type !== f.mime ? new Blob([b], { type: f.mime }) : b
}

/** 删掉用完的缓存文件 */
export function cleanIntake(files: IntakeFile[]): void {
  if (!Capacitor.isNativePlatform() || !files.length) return
  void Intake.clean({ paths: files.map((f) => f.path) }).catch(() => {})
}

/** 监听分享进来的内容。冷启动时的那次分享会在开始监听后立刻送到 */
export function onShare(cb: (p: SharePayload) => void): void {
  if (!Capacitor.isNativePlatform()) return
  void Intake.addListener('share', cb).catch(() => {})
}

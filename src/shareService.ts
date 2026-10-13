/**
 * 从别的 app 分享进来（2026-10-13 加入，规格 5.15）。
 * - 文字、链接、图片：等日记读好、解了锁，打开今天的编辑页，接在后面（追加 `### HH:mm` 段落，见 useShareIn）。
 * - zip：当作要导入的日记，打开“导入日记”页，走正常的导入确认。
 * 原生端把文件复制到缓存目录后发 'share' 事件（platform/intake.ts）。
 */
import { shallowRef, watch } from 'vue'
import type { Router } from 'vue-router'
import { ready, today } from './app'
import { lock } from './lockService'
import { chooseFiles, importState } from './importService'
import { cleanIntake, onShare, readIntakeFile, type IntakeFile, type SharePayload } from './platform/intake'
import { shareFileKind } from './core/shareIn'
import { tell } from './ui/dialog'

export interface ShareInboxItem {
  id: number
  text: string
  subject: string
  images: IntakeFile[]
  /** 全部缓存文件，用完删掉 */
  files: IntakeFile[]
  /** 收不了的文件个数（不是图片也不是 zip，或者原生端没读到） */
  skipped: number
}

/** 等编辑页来取的那一次分享。编辑页按地址里的 share 编号认领，取走后清空 */
export const shareInbox = shallowRef<ShareInboxItem | null>(null)

let seq = 0
let router: Router | null = null

function whenOpen(): Promise<void> {
  if (ready.value && !lock.locked) return Promise.resolve()
  return new Promise((resolve) => {
    const stop = watch(() => ready.value && !lock.locked, (ok) => {
      if (!ok) return
      stop()
      resolve()
    })
  })
}

/** 处理一次分享（测试里直接调） */
export async function receiveShare(p: SharePayload): Promise<void> {
  await whenOpen()
  const files = p.files ?? []
  const zip = files.find((f) => shareFileKind(f) === 'zip')
  if (zip) {
    if (importState.phase === 'running') {
      cleanIntake(files)
      await tell({ title: '正在导入日记', message: '等这次导入完成后，再把这个 zip 分享过来。' })
      return
    }
    try {
      const blob = await readIntakeFile(zip)
      await router?.push('/settings/import')
      await chooseFiles([new File([blob], zip.name || 'diary.zip', { type: 'application/zip' })])
    } finally {
      cleanIntake(files)
    }
    return
  }
  const images = files.filter((f) => shareFileKind(f) === 'image')
  const skipped = (p.skipped ?? 0) + files.length - images.length
  if (!images.length && !p.text?.trim() && !p.subject?.trim()) {
    cleanIntake(files)
    await tell({
      title: '收不了这个',
      message: '浮生记能收下文字、链接、图片，以及浮生记导出的 zip。这次分享过来的内容不在这几种里。',
    })
    return
  }
  const item: ShareInboxItem = { id: ++seq, text: p.text ?? '', subject: p.subject ?? '', images, files, skipped }
  shareInbox.value = item
  await router?.push({ path: `/entry/${today()}`, query: { append: '1', share: String(item.id) } })
}

/** 编辑页认领这次分享（编号对得上才给） */
export function takeShare(id: unknown): ShareInboxItem | null {
  const item = shareInbox.value
  if (!item || String(item.id) !== String(id)) return null
  shareInbox.value = null
  return item
}

/** 在日记读取完成后调用 */
export function initShare(r: Router) {
  router = r
  onShare((p) => void receiveShare(p).catch((e) => void tell({ title: '没能收下分享的内容', message: (e as Error).message })))
  // 测试入口：模拟一次分享（文件的 path 可以是 data: 地址）
  const w = window as unknown as { __diary?: Record<string, unknown> }
  if (w.__diary) w.__diary.share = receiveShare
}

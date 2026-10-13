/**
 * 编辑页收下分享进来的内容（2026-10-13 加入，规格 5.15）：图片压缩存进日记，文字和链接接在后面，
 * 顶上显示“放进了 2 张图和 1 个链接 · 撤销”（12 秒，或者接着写字后消失）。撤销把编辑框改回分享前的样子、删掉刚存的图片。
 */
import { nextTick, reactive, watch, type Ref } from 'vue'
import { store } from '../../app'
import { ROOT } from '../../core/repo'
import { joinShare, shareSummary, shareText } from '../../core/shareIn'
import { compress, saveImage } from '../../imageService'
import { cleanIntake, readIntakeFile } from '../../platform/intake'
import type { ShareInboxItem } from '../../shareService'

const UNDO_MS = 12000

export function useShareIn(opts: {
  date: string
  text: Ref<string>
  autosize: () => void
  flush: () => Promise<void>
  dropIfEmpty: () => Promise<void>
}) {
  const shareBar = reactive({ show: false, label: '', busy: false })
  let before = ''
  let after = ''
  let saved: string[] = []
  let hideTimer: ReturnType<typeof setTimeout> | null = null

  function hideLater() {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => (shareBar.show = false), UNDO_MS)
  }

  // 接着写了字就不再提供撤销：免得把后写的也撤掉
  watch(opts.text, (v) => {
    if (shareBar.show && !shareBar.busy && v !== after) shareBar.show = false
  })

  async function applyShare(item: ShareInboxItem) {
    shareBar.busy = true
    Object.assign(shareBar, { show: true, label: item.images.length ? '正在放进图片…' : '' })
    const mds: string[] = []
    let failed = item.skipped
    try {
      for (const f of item.images) {
        try {
          const md = await saveImage(opts.date, await compress(await readIntakeFile(f)))
          mds.push(md)
          const m = /\(\.\.\/\.\.\/(attachments\/[^)]+)\)/.exec(md)
          if (m) saved.push(`${ROOT}/${m[1]}`)
        } catch {
          failed++
        }
      }
    } finally {
      cleanIntake(item.files)
    }
    const words = shareText(item.text, item.subject)
    const block = [mds.join('\n\n'), words].filter(Boolean).join('\n\n')
    before = opts.text.value
    opts.text.value = joinShare(before, block)
    after = opts.text.value
    await nextTick()
    opts.autosize()
    await opts.flush()
    const label = shareSummary(mds.length, words)
    Object.assign(shareBar, { busy: false, label: failed ? `${label}，有 ${failed} 个没收下` : label })
    hideLater()
  }

  async function undoShare() {
    if (shareBar.busy) return
    shareBar.show = false
    if (hideTimer) clearTimeout(hideTimer)
    opts.text.value = before
    for (const p of saved) await store.remove(p).catch(() => {})
    saved = []
    await nextTick()
    opts.autosize()
    await opts.dropIfEmpty()
  }

  return { shareBar, applyShare, undoShare }
}

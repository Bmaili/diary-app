/**
 * 阅读视图里的朱批（2026-10-13 加入，规格 5.16）：手动“请批”，不自动触发。
 * 配了 AI 服务、这篇有正文、没有设“不让 AI 读”时才显示“请批”；已有的批语照常显示。
 */
import { computed, reactive, type ComputedRef } from 'vue'
import { deleteAnnotation, ensureConsent, loadAnnotation, profileFor, requestAnnotation } from '../../aiService'
import type { Annotation } from '../../core/annotation'
import type { EntryMeta } from '../../core/types'
import { ask } from '../dialog'

export function useAnnotation(opts: {
  date: string
  meta: ComputedRef<EntryMeta | undefined>
  hasBody: ComputedRef<boolean>
  readOnly: ComputedRef<boolean>
  /** 请批前先把编辑框里的存下来：AI 读的是文件 */
  flush: () => Promise<void>
}) {
  const zhu = reactive({ item: null as Annotation | null, busy: false, error: '', loaded: false })

  const canAsk = computed(() => !opts.readOnly.value && opts.hasBody.value && !opts.meta.value?.ai_exclude && !!profileFor('annotate'))

  async function load() {
    zhu.item = await loadAnnotation(opts.date).catch(() => null)
    zhu.loaded = true
  }

  async function run(avoid?: string) {
    if (zhu.busy || !canAsk.value) return
    if (!(await ensureConsent('annotate'))) return
    zhu.busy = true
    zhu.error = ''
    try {
      await opts.flush()
      zhu.item = await requestAnnotation(opts.date, avoid)
    } catch (e) {
      zhu.error = (e as Error).message
    } finally {
      zhu.busy = false
    }
  }

  const askZhu = () => run()
  const another = () => run(zhu.item?.text)

  async function removeZhu() {
    if (!zhu.item || zhu.busy) return
    if (!(await ask({ title: '删去这条批语？', message: '删了可以再请一次，但不会是同一句了。', ok: '删去', cancel: '留着' }))) return
    await deleteAnnotation(opts.date)
    zhu.item = null
  }

  return { zhu, canAsk, loadZhu: load, askZhu, another, removeZhu }
}

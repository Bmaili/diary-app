/**
 * 编辑页的核心：打开这一天的编辑会话、自动保存、离开和删除。
 *
 * 有改动后最多 1 秒写盘一次（节流而不是防抖）：
 * 即使一直不停地打字，被强行杀掉时也最多丢失最后 1 秒的输入。
 * 切到后台、离开页面时立即写盘。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { App as CapApp } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { deleteEntryToTrash, enqueue, refreshDate, repo, sweepRemovedImages, today } from '../../app'
import { syncAfterEdit, syncOnHide } from '../../syncService'
import { bodyFor, openSession, revertedRaw, type EditSession } from '../../core/session'
import { entryPath } from '../../core/repo'
import { hasContent, hasRecord } from '../../core/entryFile'
import { ask, choose } from '../dialog'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'empty' | 'error'

export function useEntrySession(date: string) {
  const session = ref<EditSession | null>(null)
  const text = ref('')
  const status = ref<SaveStatus>('idle')
  const saveError = ref('')

  let savedBody = ''
  let metaDirty = false
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 已离开页面：卸载时不再重复保存 */
  let left = false
  /** 已经删除：之后不再写盘 */
  let deleted = false
  let pauseHandle: PluginListenerHandle | null = null
  /** 打开的时刻：之后新存的这一天的图片，算这次插的 */
  let openedAt = 0
  let swept = false

  const meta = computed(() => session.value?.doc.meta)
  const readOnly = computed(() => !!session.value?.error)
  const isToday = computed(() => date === today())
  const statusText = computed(() => {
    if (readOnly.value) return '只读'
    switch (status.value) {
      case 'saving': return '保存中'
      case 'saved': return session.value && !hasContent(bodyFor(session.value, text.value)) ? '已记下心情' : '已保存'
      case 'empty': return '写一句或选个心情，就会保存'
      case 'error': return '保存失败'
      default: return ''
    }
  })

  function schedule() {
    if (readOnly.value || timer) return
    timer = setTimeout(() => void flush(), 1000)
  }

  function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const s = session.value
    if (!s || s.error || deleted) return Promise.resolve()
    const body = bodyFor(s, text.value)
    return enqueue(async () => {
      if (body === savedBody && !metaDirty) return
      if (!hasRecord({ body, meta: s.doc.meta })) {
        status.value = 'empty'
        return
      }
      status.value = 'saving'
      try {
        s.doc.body = body
        const reverted = revertedRaw(s, body)
        if (reverted) {
          // 改回了打开时的样子：写回原文件（连 updated 也是原来的），同步时不会再上传
          const m = reverted.original.meta
          if (m.updated == null) delete s.doc.meta.updated
          else s.doc.meta.updated = m.updated
          if (m.created == null) delete s.doc.meta.created
          else s.doc.meta.created = m.created
          await repo.writeAtomic(entryPath(date), reverted.raw)
        } else await repo.saveEntry(s.doc)
        savedBody = body
        metaDirty = false
        s.existed = true
        status.value = 'saved'
        await refreshDate(date)
      } catch (e) {
        status.value = 'error'
        saveError.value = (e as Error).message
      }
    })
  }

  /** 改了元数据（心情、位置、标签……）：立即保存 */
  function metaChanged(now = true) {
    metaDirty = true
    if (now) void flush()
    else schedule()
  }

  watch(text, schedule)

  function onHidden() {
    if (document.visibilityState === 'hidden') void flush().then(syncOnHide)
  }

  async function open(append: boolean): Promise<EditSession> {
    openedAt = Date.now()
    const s = await openSession(repo, date, { append })
    session.value = s
    savedBody = s.originalBody
    text.value = s.initialText
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onHidden)
    if (Capacitor.isNativePlatform()) pauseHandle = await CapApp.addListener('pause', () => void flush())
    return s
  }

  /** 删除这一天：移到“最近删除”，云端副本在下次同步时删除。返回是否删了 */
  async function remove(confirm: { title: string; message: string }): Promise<boolean> {
    const s = session.value
    if (!s?.existed || !(await ask({ ...confirm, ok: '删除', danger: true }))) return false
    // 先把最后一秒的输入存下来，回收站里的才是完整版本
    if (hasRecord({ body: bodyFor(s, text.value), meta: s.doc.meta })) await flush()
    left = true
    deleted = true
    await deleteEntryToTrash(date)
    syncAfterEdit()
    return true
  }

  /**
   * 撤销分享进来的内容后调用：这一天本来没有日记、撤销后又什么都没记了，就把刚建的文件移到最近删除
   * （不用等离开页面）；否则照常保存（改回原样时写回原文）。
   */
  async function dropIfEmpty(): Promise<void> {
    const s = session.value
    if (!s || s.error || deleted) return
    if (hasRecord({ body: bodyFor(s, text.value), meta: s.doc.meta }) || !s.existed || s.originalRaw != null) return flush()
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await deleteEntryToTrash(date)
    s.existed = false
    savedBody = ''
    status.value = 'idle'
  }

  /** 这次去掉的图片移到最近删除（排在最后一次保存之后）；删掉整篇时图片已经随日记走了 */
  function sweep() {
    const s = session.value
    if (swept || !s || s.error || deleted) return
    swept = true
    sweepRemovedImages(date, s.originalBody, openedAt)
  }

  /** 页面已关闭（比如别的流程结束后），之后的回调不要再改东西 */
  const isLeft = () => left

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onHidden)
    window.removeEventListener('pagehide', onHidden)
    pauseHandle?.remove()
    if (!left) {
      void flush()
      sweep()
    }
  })

  onBeforeRouteLeave(async () => {
    left = true
    const s = session.value
    if (!s || s.error || deleted) return true
    if (timer) clearTimeout(timer)
    const body = bodyFor(s, text.value)
    if (!hasRecord({ body, meta: s.doc.meta }) && s.existed) {
      // 这次才记下、又全部撤掉了（比如拖了心情又点“不记”）：悄悄移到最近删除，不用再问
      if (s.originalRaw == null || (await ask({
        title: '这一天什么都没记了',
        message: '正文和心情都清空了。要删除这一天的日记吗？删除后可以在“设置 → 最近删除”里找回，保留 30 天。',
        ok: '删除', cancel: '留着', danger: true,
      }))) {
        await deleteEntryToTrash(date)
        syncAfterEdit()
      } else sweep()
      return true
    }
    if (!hasContent(body) && hasContent(s.originalBody) && s.originalRaw != null) {
      // 原来有正文、现在删光了只剩心情：自动保存已经写了盘，问一下要不要恢复原来的正文
      // 返回键关掉提示框时按“恢复”：不丢字
      const pick = await choose({
        title: '正文已经删光了',
        message: '这天还记着心情。要只留下心情，还是把原来的正文找回来？',
        options: [
          { label: '只保留心情', value: 'keep', kind: 'primary' },
          { label: '恢复原来的正文', value: 'restore', kind: 'ghost' },
        ],
        dismiss: 'restore',
      })
      if (pick === 'restore') {
        await enqueue(async () => {
          await repo.writeAtomic(entryPath(date), s.originalRaw!)
          await refreshDate(date)
        })
        syncAfterEdit()
        sweep()
        return true
      }
    }
    await flush()
    syncAfterEdit()
    sweep()
    return true
  })

  return { session, text, status, saveError, statusText, meta, readOnly, isToday, open, flush, schedule, metaChanged, remove, isLeft, dropIfEmpty }
}

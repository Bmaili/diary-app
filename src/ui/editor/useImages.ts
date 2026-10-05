/**
 * 编辑页的插图和图片说明。插图后打开说明框（可以不写，关掉就行）；
 * 阅读视图里点图片也能改说明。说明存成 Markdown 替代文字，见 core/imageCaption.ts。
 */
import { computed, nextTick, reactive, ref, type ComputedRef, type Ref } from 'vue'
import { cleanCameraTemp, compress, pickImage, saveImage } from '../../imageService'
import { listImages, setImageAlt } from '../../core/imageCaption'
import { profileFor } from '../../aiService'
import { prefs } from '../../prefs'
import type { EntryMeta } from '../../core/types'

export function useImages(opts: {
  text: Ref<string>
  date: string
  readOnly: ComputedRef<boolean>
  meta: ComputedRef<EntryMeta | undefined>
  /** 插入时的光标位置；阅读视图里返回 null，插到末尾 */
  cursor: () => number | null
  autosize: () => void
  replaceText: (next: string, at: number, delta: number) => void
  flush: () => Promise<void>
  note: (s: string) => void
}) {
  const { text } = opts
  const imgBusy = ref(false)
  const imgSheet = ref(false)
  /** 打开选图方式前记下光标位置（打开弹窗时编辑框会失焦） */
  let imgPos: number | null = null

  function chooseImage() {
    if (opts.readOnly.value || imgBusy.value) return
    imgPos = opts.cursor()
    imgSheet.value = true
  }

  async function insertImage(source: 'camera' | 'gallery') {
    imgSheet.value = false
    if (opts.readOnly.value || imgBusy.value) return
    const file = await pickImage(source)
    if (!file) return
    imgBusy.value = true
    try {
      const md = await saveImage(opts.date, await compress(file))
      if (source === 'camera') void cleanCameraTemp()
      const pos = Math.min(imgPos ?? text.value.length, text.value.length)
      const before = text.value.slice(0, pos)
      const after = text.value.slice(pos)
      const pre = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''
      text.value = `${before}${pre}${md}\n\n${after.replace(/^\n+/, '')}`
      await nextTick()
      opts.autosize()
      const src = listImages(md)[0]?.src
      if (src) openCaption(src, 0)
    } catch (e) {
      opts.note(`插图失败：${(e as Error).message}`)
    } finally {
      imgBusy.value = false
    }
  }

  // ---------- 图片说明 ----------

  /** 同一张图在正文里出现几次时，nth 是第几次 */
  const caption = reactive({ open: false, src: '', nth: 0, current: '' })
  const canCaption = computed(() => !!profileFor('caption') && !opts.meta.value?.ai_exclude)
  const autoCaption = computed(() => prefs.ai.caption.auto && canCaption.value)

  function openCaption(src: string, nth: number) {
    if (opts.readOnly.value) return
    const img = listImages(text.value).filter((i) => i.src === src)[nth]
    if (!img) return
    Object.assign(caption, { open: true, src, nth, current: img.alt })
  }

  function applyCaption(src: string, nth: number, alt: string) {
    const r = setImageAlt(text.value, src, alt, nth)
    if (!r || r.text === text.value) return
    opts.replaceText(r.text, r.at, r.delta)
    void opts.flush()
  }

  function saveCaption(alt: string) {
    applyCaption(caption.src, caption.nth, alt)
  }

  /** 说明框关掉后 AI 才写好：只在这张图还没有说明时填进去 */
  function lateCaption(src: string, alt: string) {
    const nth = listImages(text.value).filter((i) => i.src === src).findIndex((i) => !i.alt)
    if (nth >= 0) applyCaption(src, nth, alt)
  }

  /** 阅读视图里点了图片 */
  function onReadingImage(img: HTMLImageElement, root: HTMLElement) {
    const src = img.dataset.src ?? img.getAttribute('src') ?? ''
    const same = Array.from(root.querySelectorAll('img')).filter((i) => (i.dataset.src ?? i.getAttribute('src')) === src)
    openCaption(src, Math.max(0, same.indexOf(img)))
  }

  return { imgBusy, imgSheet, chooseImage, insertImage, caption, canCaption, autoCaption, saveCaption, lateCaption, onReadingImage }
}

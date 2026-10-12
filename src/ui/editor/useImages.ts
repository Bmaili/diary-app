/**
 * 编辑页的插图、图片说明和看大图。插图后打开说明框（可以不写，关掉就行）；
 * 阅读视图里点图片看大图（2026-10-12 起，之前是直接改说明），大图里可以改说明、分享。
 * 说明存成 Markdown 替代文字，见 core/imageCaption.ts。
 */
import { computed, nextTick, reactive, ref, type ComputedRef, type Ref } from 'vue'
import { cleanCameraTemp, compress, imageForShare, imageUrl, pickImage, saveImage } from '../../imageService'
import { shareImage } from '../../platform/exportShare'
import { expectExternal } from '../../lockService'
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

  // ---------- 看大图 ----------

  const viewer = reactive({ open: false, index: 0, sharing: false })
  /** 正文里全部本地图片（按出现顺序），说明改了会跟着变 */
  const viewerItems = computed(() => listImages(text.value).map((i) => ({ src: i.src, alt: i.alt })))

  /** 第 i 张是同一路径的第几次出现（同一张图贴了两次时用） */
  function nthOf(i: number): number {
    const src = viewerItems.value[i]?.src
    return viewerItems.value.slice(0, i).filter((x) => x.src === src).length
  }

  /** 阅读视图里点了图片：按路径和第几次出现找到它，打开大图 */
  function onReadingImage(img: HTMLImageElement, root: HTMLElement) {
    const srcOf = (i: HTMLImageElement) => i.dataset.src ?? i.getAttribute('src') ?? ''
    const src = srcOf(img)
    const nth = Array.from(root.querySelectorAll('img')).filter((i) => srcOf(i) === src).indexOf(img)
    const idx = viewerItems.value.map((x, i) => ({ x, i })).filter(({ x }) => x.src === src)[Math.max(0, nth)]?.i
    if (idx == null) return
    Object.assign(viewer, { open: true, index: idx })
  }

  function editFromViewer(i: number) {
    const it = viewerItems.value[i]
    if (it) openCaption(it.src, nthOf(i))
  }

  async function shareFromViewer(i: number) {
    const it = viewerItems.value[i]
    if (!it || viewer.sharing) return
    viewer.sharing = true
    const done = expectExternal()
    try {
      const name = `diary-${it.src.split('/').pop()!.replace(/\.[^.]+$/, '')}.jpg`
      await shareImage(name, await imageForShare(it.src))
    } catch (e) {
      // 在分享面板里点了取消不算出错
      if (!/cancel/i.test((e as Error).message)) opts.note(`分享失败：${(e as Error).message}`)
    } finally {
      done()
      viewer.sharing = false
    }
  }

  return {
    imgBusy, imgSheet, chooseImage, insertImage, caption, canCaption, autoCaption, saveCaption, lateCaption, onReadingImage,
    viewer, viewerItems, editFromViewer, shareFromViewer, imageUrl,
  }
}

/**
 * 编辑页的插图、图片说明和看大图。插图后打开说明框（可以不写，关掉就行）；
 * 阅读视图里点图片看大图（2026-10-12 起，之前是直接改说明），大图里可以改说明、分享。
 * 说明存成 Markdown 替代文字，见 core/imageCaption.ts。
 */
import { computed, nextTick, reactive, ref, type ComputedRef, type Ref } from 'vue'
import { cleanCameraTemp, compress, imageForShare, imageUrl, pickImages, saveImage } from '../../imageService'
import { shareImage } from '../../platform/exportShare'
import { expectExternal } from '../../lockService'
import { captionContext, listImages, setImageAlt } from '../../core/imageCaption'
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

  /** 正在处理第几张 / 一共几张（多选时按钮上显示进度） */
  const imgProgress = ref('')

  async function insertImage(source: 'camera' | 'gallery' | 'files') {
    imgSheet.value = false
    if (opts.readOnly.value || imgBusy.value) return
    let picked
    try {
      picked = await pickImages(source)
    } catch (e) {
      opts.note(`选图失败：${(e as Error).message}`)
      return
    }
    if (!picked) return
    if (picked.note) opts.note(picked.note)
    imgBusy.value = true
    const mds: string[] = []
    let failed = 0
    let lastError = ''
    try {
      const n = picked.blobs.length
      for (let i = 0; i < n; i++) {
        imgProgress.value = n > 1 ? `${i + 1}/${n}` : ''
        try {
          mds.push(await saveImage(opts.date, await compress(picked.blobs[i])))
        } catch (e) {
          failed++
          lastError = (e as Error).message
        }
      }
      if (source === 'camera') void cleanCameraTemp()
      if (failed) opts.note(mds.length ? `有 ${failed} 张没插进去（${lastError}）` : `插图失败：${lastError}`)
      if (!mds.length) return
      const block = mds.join('\n\n')
      const pos = Math.min(imgPos ?? text.value.length, text.value.length)
      const before = text.value.slice(0, pos)
      const after = text.value.slice(pos)
      const pre = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''
      text.value = `${before}${pre}${block}\n\n${after.replace(/^\n+/, '')}`
      await nextTick()
      opts.autosize()
      // 只插了一张时接着写说明；一次插好几张时不一张张弹框，之后点图片再写
      const src = mds.length === 1 ? listImages(mds[0])[0]?.src : undefined
      if (src) openCaption(src, 0)
    } finally {
      picked.done()
      imgBusy.value = false
      imgProgress.value = ''
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

  /** 看图写说明时附上的日记内容：照片所在的位置，加上这一天的地点和人物 */
  function captionContextNow(): string {
    const m = opts.meta.value
    return captionContext(text.value, caption.src, caption.nth, { location: m?.location?.name, places: m?.places, people: m?.people })
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
    imgBusy, imgProgress, imgSheet, chooseImage, insertImage, caption, canCaption, autoCaption, saveCaption, lateCaption, onReadingImage,
    viewer, viewerItems, editFromViewer, shareFromViewer, imageUrl, captionContextNow,
  }
}

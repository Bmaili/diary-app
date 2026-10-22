/**
 * 把设置里的心情配色写进页面（2026-10-22 加入）：一张覆盖 --m1…--m5 和字色 --onm1…--onm5 的样式表，
 * 浅色、深色各一份；默认配色时把这张表去掉，用 style.css 里的。
 */
import { watch } from 'vue'
import { prefs } from '../prefs'
import { paletteCss, resolvePalette } from '../core/moodPalette'
import { palette } from './mood'

const ID = 'mood-colors'

export function applyMoodColors(colors: string[] | undefined) {
  const p = resolvePalette(colors)
  palette.value = p
  if (typeof document === 'undefined') return
  let el = document.getElementById(ID) as HTMLStyleElement | null
  const css = paletteCss(p)
  if (!css) {
    el?.remove()
    return
  }
  if (!el) {
    el = document.createElement('style')
    el.id = ID
    document.head.appendChild(el)
  }
  el.textContent = css
}

export function initMoodTheme() {
  watch(() => [...prefs.ui.moodColors], (c) => applyMoodColors(c), { immediate: true })
}

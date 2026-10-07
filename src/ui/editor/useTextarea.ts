/**
 * 编辑框：自动增高、快捷按钮（加粗、列表、待办……）、回车续行，以及在不打乱光标的前提下从外部改正文。
 */
import { ref, type Ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { continueList, insertHeading, toggleLines, toggleWrap, type Edit } from '../../core/mdEdit'
import { hhmm } from '../../core/time'
import type { ToolAction } from '../components/EditorToolbar.vue'

export function useTextarea(text: Ref<string>, readOnly: Ref<boolean>, onImage: () => void) {
  const textarea = ref<HTMLTextAreaElement | null>(null)
  /** 编辑框有焦点时显示按钮条 */
  const focused = ref(false)

  function autosize() {
    const el = textarea.value
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, window.innerHeight * 0.5)}px`
  }

  function focusEnd() {
    const el = textarea.value
    if (!el) return
    el.focus()
    const n = el.value.length
    el.setSelectionRange(n, n)
    if (Capacitor.getPlatform() === 'android') Keyboard.show().catch(() => {})
    el.scrollIntoView({ block: 'end' })
  }

  function onFocus() {
    focused.value = true
  }
  function onBlur() {
    // 点按钮条时编辑框不会失焦；真正离开编辑框（收起键盘、点了别处）才隐藏按钮条
    setTimeout(() => (focused.value = document.activeElement === textarea.value), 150)
  }

  /** 用 execCommand 改文字：会触发 input 事件（v-model 同步），并进入系统的撤销记录 */
  function applyEdit(e: Edit) {
    const el = textarea.value
    if (!el || readOnly.value) return
    el.focus()
    el.setSelectionRange(e.from, e.to)
    let ok = false
    try {
      ok = e.insert ? document.execCommand('insertText', false, e.insert) : e.from === e.to || document.execCommand('delete')
    } catch {
      ok = false
    }
    if (!ok) {
      el.setRangeText(e.insert, e.from, e.to, 'end')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    el.setSelectionRange(e.selStart, e.selEnd)
    autosize()
  }

  function state() {
    const el = textarea.value!
    return { text: el.value, start: el.selectionStart, end: el.selectionEnd }
  }

  function onTool(a: ToolAction) {
    const el = textarea.value
    if (!el || readOnly.value) return
    switch (a) {
      case 'bold': return applyEdit(toggleWrap(state()))
      case 'bullet':
      case 'number':
      case 'todo':
      case 'quote': return applyEdit(toggleLines(state(), a))
      case 'time': return applyEdit(insertHeading(state(), hhmm(new Date())))
      case 'image': return onImage()
      case 'undo':
        el.focus()
        document.execCommand('undo')
        autosize()
    }
  }

  /**
   * 回车续行。用 beforeinput 而不是 keydown：安卓输入法的回车往往没有可靠的 keydown，
   * 输入法组字（拼音候选）过程中不处理。
   */
  function onBeforeInput(ev: InputEvent) {
    const isEnter = ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph' || (ev.inputType === 'insertText' && ev.data === '\n')
    if (!isEnter || ev.isComposing || readOnly.value) return
    const e = continueList(state())
    if (!e) return
    ev.preventDefault()
    applyEdit(e)
  }

  /**
   * 从外部改正文（例如 AI 写好了图片说明）：at 之后的光标跟着移动 delta，
   * 正在打字时光标不会跳到末尾。
   */
  function replaceText(next: string, at: number, delta: number) {
    const el = textarea.value
    const active = el && document.activeElement === el
    const sel = active ? [el.selectionStart, el.selectionEnd] : null
    text.value = next
    if (el && sel) {
      el.value = next
      const move = (p: number) => (p > at ? Math.max(at, p + delta) : p)
      el.setSelectionRange(move(sel[0]), move(sel[1]))
    }
    requestAnimationFrame(autosize)
  }

  return { textarea, focused, autosize, focusEnd, onFocus, onBlur, onTool, onBeforeInput, replaceText }
}

/**
 * 编辑框：自动增高、快捷按钮（加粗、列表、待办……）、回车续行，以及在不打乱光标的前提下从外部改正文。
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { continueList, insertHeading, toggleLines, toggleWrap, type Edit } from '../../core/mdEdit'
import { hhmm } from '../../core/time'
import type { ToolAction } from '../components/EditorToolbar.vue'

/** 光标离按钮条（或键盘、顶栏）至少留这么多像素 */
const CARET_GAP = 12

/** 键盘盖住网页底部的高度：有的系统缩小网页（为 0），有的只是盖住网页，用 visualViewport 统一算 */
export function keyboardOverlap(): number {
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
}

/**
 * 光标所在行在视口里的上下沿。textarea 拿不到光标坐标，用一个样式相同的隐藏元素
 * 排出光标前的文字，量最后一个字符的位置。
 */
function caretBox(el: HTMLTextAreaElement): { top: number; bottom: number } {
  const cs = getComputedStyle(el)
  const m = document.createElement('div')
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textIndent', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'boxSizing', 'wordBreak', 'overflowWrap'] as const) {
    m.style[p] = cs[p]
  }
  m.style.position = 'absolute'
  m.style.visibility = 'hidden'
  m.style.top = '0'
  m.style.left = '-9999px'
  m.style.whiteSpace = 'pre-wrap'
  m.style.width = `${el.getBoundingClientRect().width}px`
  m.textContent = el.value.slice(0, el.selectionEnd)
  const mark = document.createElement('span')
  mark.textContent = '​'
  m.appendChild(mark)
  document.body.appendChild(m)
  const top = el.getBoundingClientRect().top + mark.offsetTop
  const lh = parseFloat(cs.lineHeight) || mark.offsetHeight || 24
  m.remove()
  return { top, bottom: top + lh }
}

export function useTextarea(text: Ref<string>, readOnly: Ref<boolean>, onImage: () => void) {
  const textarea = ref<HTMLTextAreaElement | null>(null)
  /** 编辑框有焦点时显示按钮条 */
  const focused = ref(false)
  /** 键盘盖住网页的高度：正文底部要多留出这么多，最后几行才能滚到键盘上方 */
  const keyboard = ref(0)

  /**
   * 自动增高。先设 height: auto 再量 scrollHeight 的那一刻页面会变短，浏览器把滚动位置往回夹，
   * 撑开后不会自己滚回去：长日记每打一个字页面就往上跳，光标掉到键盘下面（2026-10-12 修复）。
   * 所以量之前记下滚动位置，量完放回去。
   */
  function autosize() {
    const el = textarea.value
    if (!el) return
    const y = window.scrollY
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, window.innerHeight * 0.5)}px`
    if (window.scrollY !== y) window.scrollTo(0, y)
  }

  /** 让光标所在行露在顶栏下面、按钮条（没有按钮条时是键盘）上面 */
  function keepCaretVisible() {
    const el = textarea.value
    if (!el || document.activeElement !== el) return
    const vv = window.visualViewport
    const viewTop = vv?.offsetTop ?? 0
    const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
    const bar = document.querySelector('.toolbar')?.getBoundingClientRect()
    const head = document.querySelector('.editor .topbar')?.getBoundingClientRect()
    const limitBottom = Math.min(viewBottom, bar && bar.height ? bar.top : viewBottom) - CARET_GAP
    const limitTop = Math.max(viewTop, head ? head.bottom : viewTop) + CARET_GAP
    const c = caretBox(el)
    if (c.bottom > limitBottom) window.scrollBy(0, c.bottom - limitBottom)
    else if (c.top < limitTop) window.scrollBy(0, c.top - limitTop)
  }

  /** 输入后：先增高，等浏览器自己处理完光标再检查一遍 */
  function onInput() {
    autosize()
    requestAnimationFrame(keepCaretVisible)
  }

  /** 键盘弹出、收起或高度变化（动画结束）时，重新算底部留白并检查光标 */
  function onViewport() {
    keyboard.value = keyboardOverlap()
    if (focused.value) requestAnimationFrame(keepCaretVisible)
  }
  onMounted(() => {
    window.visualViewport?.addEventListener('resize', onViewport)
    window.visualViewport?.addEventListener('scroll', onViewport)
  })
  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', onViewport)
    window.visualViewport?.removeEventListener('scroll', onViewport)
  })

  function focusEnd() {
    const el = textarea.value
    if (!el) return
    el.focus()
    const n = el.value.length
    el.setSelectionRange(n, n)
    if (Capacitor.getPlatform() === 'android') Keyboard.show().catch(() => {})
    el.scrollIntoView({ block: 'end' })
    requestAnimationFrame(keepCaretVisible)
  }

  function onFocus() {
    focused.value = true
    // 按钮条在下一帧才出现，等它出现后再检查
    requestAnimationFrame(() => requestAnimationFrame(keepCaretVisible))
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
    requestAnimationFrame(keepCaretVisible)
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
        requestAnimationFrame(keepCaretVisible)
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

  return { textarea, focused, keyboard, autosize, onInput, focusEnd, onFocus, onBlur, onTool, onBeforeInput, replaceText }
}

<script setup lang="ts">
/**
 * 全屏看图（2026-10-12 加入）：双指缩放、双击放大或还原、放大后拖动，左右滑切换这一天的其他图片，
 * 往下拖关闭；底部显示说明，可以改说明、分享（分享时转成 JPEG）。
 * 只渲染当前和左右相邻的图片，图多的日子也不会一次解码几十张大图。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { pushBack } from '../backStack'

export interface ViewerItem {
  /** 正文里的路径 */
  src: string
  /** 说明 */
  alt: string
}

const props = defineProps<{
  open: boolean
  items: ViewerItem[]
  index: number
  /** 能不能改说明（只读的日记不能） */
  canEdit: boolean
  /** 正在准备分享 */
  sharing?: boolean
  /** 正文路径 → 显示用的地址 */
  resolve: (src: string) => Promise<string>
}>()
const emit = defineEmits<{ close: []; 'update:index': [i: number]; edit: [i: number]; share: [i: number] }>()

const MAX_SCALE = 5
const DOUBLE_TAP_SCALE = 2.5

const urls = reactive(new Map<string, string>())
const natural = reactive(new Map<string, { w: number; h: number }>())
const stage = ref<HTMLElement | null>(null)
const size = reactive({ w: 0, h: 0 })
/** 当前图的缩放和位移（相对居中位置） */
const view = reactive({ scale: 1, x: 0, y: 0 })
/** 左右滑、往下拖时手指的位移 */
const drag = reactive({ x: 0, y: 0 })
const dragging = ref(false)
/** 单击切换上下栏 */
const chrome = ref(true)

const cur = computed(() => props.items[props.index])
const near = (i: number) => Math.abs(i - props.index) <= 1

async function load(i: number) {
  const it = props.items[i]
  if (!it || urls.has(it.src)) return
  const u = await props.resolve(it.src).catch(() => '')
  if (u) urls.set(it.src, u)
}
watch(() => [props.open, props.index, props.items.length] as const, ([open]) => {
  if (!open) return
  for (const i of [props.index, props.index - 1, props.index + 1]) void load(i)
}, { immediate: true })

function measure() {
  const r = stage.value?.getBoundingClientRect()
  if (r) Object.assign(size, { w: r.width, h: r.height })
}
function onLoad(src: string, e: Event) {
  const img = e.target as HTMLImageElement
  natural.set(src, { w: img.naturalWidth, h: img.naturalHeight })
}

/** 缩放为 1 时图片在屏幕上的大小（等比放进屏幕） */
function base(): { w: number; h: number } {
  const n = cur.value && natural.get(cur.value.src)
  if (!n || !size.w) return { w: size.w, h: size.h }
  const f = Math.min(size.w / n.w, size.h / n.h)
  return { w: n.w * f, h: n.h * f }
}
function clamp(scale: number, x: number, y: number) {
  const b = base()
  const mx = Math.max(0, (b.w * scale - size.w) / 2)
  const my = Math.max(0, (b.h * scale - size.h) / 2)
  return { scale, x: Math.min(mx, Math.max(-mx, x)), y: Math.min(my, Math.max(-my, y)) }
}
function reset() {
  Object.assign(view, { scale: 1, x: 0, y: 0 })
}

// ---------- 手势 ----------
const pts = new Map<number, { x: number; y: number }>()
let pinch: { dist: number; scale: number; mid: { x: number; y: number }; x: number; y: number } | null = null
let start: { x: number; y: number; t: number; vx: number; vy: number } | null = null
let axis: '' | 'x' | 'y' | 'pan' = ''
let moved = false
let lastTap = 0
let tapTimer: ReturnType<typeof setTimeout> | undefined

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
/** 屏幕坐标 → 相对舞台中心 */
function rel(p: { x: number; y: number }) {
  const r = stage.value!.getBoundingClientRect()
  return { x: p.x - r.left - r.width / 2, y: p.y - r.top - r.height / 2 }
}

function onDown(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
  dragging.value = true
  if (pts.size === 2) {
    const [a, b] = [...pts.values()]
    pinch = { dist: dist(a, b), scale: view.scale, mid: rel(mid(a, b)), x: view.x, y: view.y }
    axis = 'pan'
    moved = true
  } else if (pts.size === 1) {
    start = { x: e.clientX, y: e.clientY, t: Date.now(), vx: view.x, vy: view.y }
    axis = view.scale > 1.01 ? 'pan' : ''
    moved = false
  }
}

function onMove(e: PointerEvent) {
  if (!pts.has(e.pointerId)) return
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pinch && pts.size >= 2) {
    const [a, b] = [...pts.values()]
    const s = Math.min(MAX_SCALE, Math.max(0.8, (pinch.scale * dist(a, b)) / pinch.dist))
    const m = rel(mid(a, b))
    // 让两指中点下的那一点保持在手指下
    const k = s / pinch.scale
    Object.assign(view, clamp(s, m.x - (pinch.mid.x - pinch.x) * k, m.y - (pinch.mid.y - pinch.y) * k))
    if (s < 1) view.scale = s // 允许捏小一点，松手弹回
    return
  }
  if (!start) return
  const dx = e.clientX - start.x
  const dy = e.clientY - start.y
  if (!moved && Math.hypot(dx, dy) > 8) moved = true
  if (!moved) return
  if (axis === 'pan') {
    Object.assign(view, clamp(view.scale, start.vx + dx, start.vy + dy))
  } else {
    if (!axis) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    if (axis === 'x') {
      // 到头了再滑只走三分之一，提示没有更多了
      const edge = (dx > 0 && props.index === 0) || (dx < 0 && props.index === props.items.length - 1)
      drag.x = edge ? dx / 3 : dx
    } else {
      drag.y = Math.max(0, dy)
    }
  }
}

function onUp(e: PointerEvent) {
  if (!pts.has(e.pointerId)) return
  pts.delete(e.pointerId)
  if (pinch) {
    if (pts.size < 2) pinch = null
    if (pts.size === 0) {
      if (view.scale < 1.05) reset()
      dragging.value = false
    } else {
      // 剩一根手指：接着拖动
      const [p] = [...pts.values()]
      start = { x: p.x, y: p.y, t: Date.now(), vx: view.x, vy: view.y }
      axis = 'pan'
    }
    return
  }
  if (pts.size > 0) return
  dragging.value = false
  if (!moved && start && Date.now() - start.t < 300) tap(e)
  else if (axis === 'x') {
    const w = size.w || window.innerWidth
    if (drag.x < -w * 0.18 && props.index < props.items.length - 1) emit('update:index', props.index + 1)
    else if (drag.x > w * 0.18 && props.index > 0) emit('update:index', props.index - 1)
  } else if (axis === 'y' && drag.y > 110) {
    emit('close')
  }
  drag.x = 0
  drag.y = 0
  start = null
  axis = ''
}

function tap(e: PointerEvent) {
  const now = Date.now()
  if (now - lastTap < 300) {
    clearTimeout(tapTimer)
    lastTap = 0
    if (view.scale > 1.01) reset()
    else {
      const p = rel({ x: e.clientX, y: e.clientY })
      // 双击的那一点放大后留在手指下
      Object.assign(view, clamp(DOUBLE_TAP_SCALE, p.x * (1 - DOUBLE_TAP_SCALE), p.y * (1 - DOUBLE_TAP_SCALE)))
    }
    return
  }
  lastTap = now
  tapTimer = setTimeout(() => (chrome.value = !chrome.value), 300)
}

function onWheel(e: WheelEvent) {
  // 电脑上调试用：滚轮缩放
  e.preventDefault()
  const s = Math.min(MAX_SCALE, Math.max(1, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
  Object.assign(view, clamp(s, view.x, view.y))
}

function go(d: number) {
  const i = props.index + d
  if (i >= 0 && i < props.items.length) emit('update:index', i)
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  else if (e.key === 'ArrowLeft') go(-1)
  else if (e.key === 'ArrowRight') go(1)
}

watch(() => props.index, reset)

let unBack: (() => void) | null = null
watch(() => props.open, async (open) => {
  if (open) {
    reset()
    chrome.value = true
    unBack = pushBack(() => emit('close'))
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', measure)
    await nextTick()
    measure()
  } else {
    unBack?.()
    unBack = null
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', measure)
    pts.clear()
    pinch = null
  }
}, { immediate: true })
onBeforeUnmount(() => {
  unBack?.()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', measure)
  clearTimeout(tapTimer)
})

const trackStyle = computed(() => ({
  transform: `translate3d(calc(${-props.index * 100}% + ${drag.x}px), ${drag.y}px, 0)`,
}))
const backdropStyle = computed(() => ({ opacity: String(1 - Math.min(0.6, drag.y / 400)) }))
function imgStyle(i: number) {
  if (i !== props.index) return undefined
  return { transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="viewer">
      <div v-if="open && cur" class="viewer" role="dialog" aria-label="看大图" :class="{ dragging, bare: !chrome }">
        <div class="backdrop" :style="backdropStyle" />
        <div ref="stage" class="stage" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel">
          <div class="track" :style="trackStyle">
            <div v-for="(it, i) in items" :key="i" class="slide">
              <img v-if="near(i) && urls.get(it.src)" :src="urls.get(it.src)" :alt="it.alt" draggable="false"
                :style="imgStyle(i)" @load="onLoad(it.src, $event)" />
              <span v-else-if="near(i)" class="loading">正在打开……</span>
            </div>
          </div>
        </div>
        <header class="bar top">
          <button class="icon-btn" aria-label="关闭" @click="emit('close')"><Icon name="close" /></button>
          <span v-if="items.length > 1" class="count num">{{ index + 1 }} / {{ items.length }}</span>
        </header>
        <footer class="bar bottom">
          <p v-if="cur.alt" class="cap">{{ cur.alt }}</p>
          <p v-else-if="canEdit" class="cap empty">还没有说明</p>
          <div class="acts">
            <button v-if="canEdit" class="act" @click="emit('edit', index)"><Icon name="pen" />改说明</button>
            <button class="act" :disabled="sharing" @click="emit('share', index)"><Icon name="share" />{{ sharing ? '正在准备' : '分享' }}</button>
          </div>
        </footer>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 看图总是在暗处：夜墨底、月白字，深浅主题一样 */
.viewer {
  --v-ink: #0e1013;
  --v-moon: #ece6da;
  --v-dim: rgba(236, 230, 218, 0.6);
  position: fixed;
  inset: 0;
  z-index: 90;
  overflow: hidden;
  color: var(--v-moon);
  touch-action: none;
  user-select: none;
}
.backdrop { position: absolute; inset: 0; background: var(--v-ink); }
.stage { position: absolute; inset: 0; overflow: hidden; }
.track { display: flex; height: 100%; transition: transform 0.28s var(--ease-out, ease-out); will-change: transform; }
.dragging .track { transition: none; }
.slide { flex: 0 0 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.slide img {
  max-width: 100%;
  max-height: 100%;
  transform-origin: center;
  transition: transform 0.22s ease-out;
  -webkit-user-drag: none;
}
.dragging .slide img { transition: none; }
.loading { color: var(--v-dim); font-size: 14px; }
.bar { position: absolute; left: 0; right: 0; display: flex; transition: opacity 0.2s ease; }
.bare .bar { opacity: 0; pointer-events: none; }
.top {
  top: 0;
  align-items: center;
  justify-content: space-between;
  padding: calc(6px + env(safe-area-inset-top, 0px)) 8px 16px;
  background: linear-gradient(rgba(14, 16, 19, 0.7), transparent);
}
.top .icon-btn { color: var(--v-moon); }
.count { padding-right: 12px; font-size: 15px; color: var(--v-dim); letter-spacing: 0.05em; }
.bottom {
  bottom: 0;
  flex-direction: column;
  gap: 10px;
  padding: 28px 20px calc(14px + var(--safe-bottom, 0px));
  background: linear-gradient(transparent, rgba(14, 16, 19, 0.82) 40%);
}
.cap { margin: 0; font-family: var(--serif); font-size: 16px; line-height: 1.7; }
.cap.empty { color: var(--v-dim); font-size: 14px; }
.acts { display: flex; gap: 8px; }
.act {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid rgba(236, 230, 218, 0.28);
  border-radius: 20px;
  background: transparent;
  color: var(--v-moon);
  font-size: 14px;
}
.act :deep(svg) { width: 18px; height: 18px; }
.act:active { background: rgba(236, 230, 218, 0.12); }
.act:disabled { opacity: 0.6; }
.viewer-enter-active, .viewer-leave-active { transition: opacity 0.2s ease; }
.viewer-enter-from, .viewer-leave-to { opacity: 0; }
</style>

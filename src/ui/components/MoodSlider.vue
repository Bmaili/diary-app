<script setup lang="ts">
/**
 * 心情拖动条：拖动时脸的表情连续变化，松手吸附到最近的一档。
 * 也可以直接点下面的文字；不记也可以。
 */
import { computed, ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { Haptics } from '@capacitor/haptics'
import MoodFace from './MoodFace.vue'
import { MOOD_LABELS, moodColor } from '../mood'

const props = withDefaults(defineProps<{ modelValue?: number; title?: string }>(), { title: '今天的心情' })
const emit = defineEmits<{ 'update:modelValue': [number | undefined] }>()

const rail = ref<HTMLElement | null>(null)
const live = ref<number | null>(null) // 拖动中的连续值
const dragging = ref(false)

const shown = computed(() => live.value ?? props.modelValue ?? null)
const pos = computed(() => ((shown.value ?? 3) - 1) / 4)
const snapped = computed(() => (shown.value == null ? null : Math.round(shown.value)))
const glow = computed(() => (shown.value == null ? 'transparent' : moodColor(shown.value)))

function valueAt(clientX: number): number {
  const r = rail.value!.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  return 1 + ratio * 4
}

let lastTick: number | null = null
function tick(v: number) {
  const n = Math.round(v)
  if (n !== lastTick) {
    lastTick = n
    if (Capacitor.isNativePlatform()) Haptics.selectionChanged().catch(() => {})
  }
}

function down(e: PointerEvent) {
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  dragging.value = true
  lastTick = props.modelValue ?? null
  if (Capacitor.isNativePlatform()) Haptics.selectionStart().catch(() => {})
  live.value = valueAt(e.clientX)
  tick(live.value)
}
function move(e: PointerEvent) {
  if (!dragging.value) return
  live.value = valueAt(e.clientX)
  tick(live.value)
}
function up() {
  if (!dragging.value) return
  dragging.value = false
  const v = live.value == null ? undefined : Math.round(live.value)
  live.value = null
  if (Capacitor.isNativePlatform()) Haptics.selectionEnd().catch(() => {})
  if (v !== props.modelValue) emit('update:modelValue', v)
}

function pick(v: number) {
  emit('update:modelValue', v)
  if (Capacitor.isNativePlatform()) Haptics.selectionChanged().catch(() => {})
}

function key(e: KeyboardEvent) {
  const cur = props.modelValue ?? 3
  let next: number | undefined
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(5, props.modelValue ? cur + 1 : 3)
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(1, props.modelValue ? cur - 1 : 3)
  else if (e.key === 'Home') next = 1
  else if (e.key === 'End') next = 5
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    emit('update:modelValue', undefined)
    e.preventDefault()
    return
  }
  if (next != null) {
    e.preventDefault()
    emit('update:modelValue', next)
  }
}
</script>

<template>
  <div class="mood" :class="{ unset: shown == null, dragging }" :style="{ '--tint': glow }">
    <div class="head">
      <span class="title">{{ title }}</span>
      <span class="label" aria-hidden="true">{{ snapped ? MOOD_LABELS[snapped - 1] : '拖一下，或点下面的字' }}</span>
      <button v-if="modelValue && !dragging" class="clear" @click="emit('update:modelValue', undefined)">不记</button>
    </div>

    <div class="track" role="slider" tabindex="0" aria-label="心情" aria-valuemin="1" aria-valuemax="5"
      :aria-valuenow="modelValue" :aria-valuetext="modelValue ? MOOD_LABELS[modelValue - 1] : '没记'"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @keydown="key">
      <div ref="rail" class="rail">
        <div class="bar"></div>
        <span v-for="n in 5" :key="n" class="notch" :style="{ left: `${(n - 1) * 25}%` }"></span>
        <div class="thumb" :style="{ left: `${pos * 100}%` }">
          <MoodFace :value="shown" :size="52" />
        </div>
      </div>
    </div>

    <div class="ticks">
      <button v-for="(l, i) in MOOD_LABELS" :key="l" :class="{ on: snapped === i + 1 }" :aria-pressed="modelValue === i + 1"
        :style="{ left: `${i * 25}%` }" @click="pick(i + 1)">{{ l }}</button>
    </div>
  </div>
</template>

<style scoped>
.mood {
  position: relative;
  margin: 4px 16px 12px;
  padding: 14px 16px 6px;
  border-radius: 24px;
  border: 1px solid var(--line);
  background: var(--surface);
  overflow: hidden;
}
/* 心情颜色从卡片顶部晕开，拖动时实时变化 */
.mood::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 90% at 50% 0%, var(--tint), transparent 70%);
  opacity: 0.28;
  pointer-events: none;
  transition: opacity 0.2s;
}
.mood.unset::before { opacity: 0; }
.head { position: relative; display: flex; align-items: baseline; gap: 10px; min-height: 28px; }
.title { font-size: 13px; color: var(--muted); font-weight: 600; }
.label { flex: 1; font-size: 18px; font-weight: 800; }
.unset .label { font-size: 14px; font-weight: 500; color: var(--faint); }
.clear {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  padding: 4px 2px;
}
.track {
  position: relative;
  height: 72px;
  padding: 0 26px;
  touch-action: none;
  cursor: grab;
  user-select: none;
}
.track:focus-visible { outline-offset: -2px; border-radius: 16px; }
.dragging .track { cursor: grabbing; }
.rail { position: relative; height: 100%; }
.bar {
  position: absolute;
  left: -10px;
  right: -10px;
  top: 50%;
  height: 12px;
  margin-top: -6px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--m1), var(--m2), var(--m3), var(--m4), var(--m5));
}
.unset .bar { opacity: 0.35; }
.notch {
  position: absolute;
  top: 50%;
  width: 4px;
  height: 4px;
  margin: -2px 0 0 -2px;
  border-radius: 50%;
  background: var(--surface);
  opacity: 0.9;
}
.thumb {
  position: absolute;
  top: 50%;
  transform: translate(-50%, -50%);
  padding: 3px;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 4px 14px -4px rgba(18, 24, 52, 0.4), 0 0 18px -4px var(--tint);
  transition: left 0.22s cubic-bezier(0.3, 1.4, 0.5, 1), transform 0.15s;
}
.dragging .thumb { transition: transform 0.15s; transform: translate(-50%, -50%) scale(1.12); }
.unset .thumb { box-shadow: none; outline: 1.5px dashed var(--faint); outline-offset: -1px; }
.ticks {
  position: relative;
  height: 40px;
  margin: -6px 26px 0;
}
.ticks button {
  position: absolute;
  top: 0;
  width: 56px;
  transform: translateX(-50%);
  min-height: 40px;
  border: 0;
  background: transparent;
  color: var(--faint);
  font-size: 13px;
}
.ticks button.on { color: var(--ink); font-weight: 800; }
</style>

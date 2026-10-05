<script setup lang="ts">
/**
 * 会变表情的脸。value 是 1–5 之间的连续值（拖动时会是小数），null 表示没记心情。
 * 嘴角弧度、眉毛、眼睛形状都随 value 连续变化。
 */
import { computed } from 'vue'
import { inkOn, moodColor } from '../mood'

const props = withDefaults(defineProps<{ value: number | null; size?: number }>(), { size: 48 })

const k = computed(() => (props.value == null ? 0 : (props.value - 3) / 2)) // -1 难过 … 1 开心
const fill = computed(() => (props.value == null ? 'var(--m0)' : moodColor(props.value)))
/** 深色的脸（玄青、黛）上用浅色画五官 */
const ink = computed(() => (props.value == null ? 'var(--ink)' : inkOn(props.value)))
// 嘴：两端随心情上扬或下垂，中间控制点决定弧度
const mouth = computed(() => {
  const s = k.value
  const endY = 7 - s * 2
  const ctrlY = 7 + s * 9
  const w = 8 + Math.max(0, s) * 2
  return `M ${-w} ${endY.toFixed(2)} Q 0 ${ctrlY.toFixed(2)} ${w} ${endY.toFixed(2)}`
})
const happyEyes = computed(() => props.value != null && props.value >= 4.4)
const brow = computed(() => (props.value != null && props.value <= 1.9 ? (1.9 - props.value) / 0.9 : 0))
const blush = computed(() => (props.value == null ? 0 : Math.max(0, (props.value - 4) / 1)))
</script>

<template>
  <svg :width="size" :height="size" viewBox="-24 -24 48 48" aria-hidden="true" class="face">
    <circle r="22" :fill="fill" />
    <g fill="none" :stroke="ink" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
      <template v-if="happyEyes">
        <path d="M -10.5 -3 Q -7 -8 -3.5 -3" />
        <path d="M 3.5 -3 Q 7 -8 10.5 -3" />
      </template>
      <template v-else>
        <circle cx="-7" cy="-4" r="1.9" :fill="ink" stroke="none" />
        <circle cx="7" cy="-4" r="1.9" :fill="ink" stroke="none" />
      </template>
      <g v-if="brow > 0" :opacity="Math.min(1, brow + 0.3)">
        <path :d="`M -11 ${-9 - brow * 2} L -4 ${-11 + brow * 1.5}`" />
        <path :d="`M 11 ${-9 - brow * 2} L 4 ${-11 + brow * 1.5}`" />
      </g>
      <path :d="mouth" />
    </g>
    <g v-if="blush > 0" fill="#ffffff" :opacity="blush * 0.35">
      <ellipse cx="-13" cy="4" rx="3.5" ry="2.2" />
      <ellipse cx="13" cy="4" rx="3.5" ry="2.2" />
    </g>
  </svg>
</template>

<style scoped>
.face { display: block; flex: none; }
.face circle, .face path { transition: fill 0.12s linear; }
</style>

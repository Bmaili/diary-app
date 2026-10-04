<script setup lang="ts">
/** 按相位画月亮：亮面从右边长出（盈），从右边消失（亏）。北半球视角。 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ phase: number; size?: number }>(), { size: 16 })

const path = computed(() => {
  const r = 10
  const p = props.phase
  const waxing = p < 0.5
  // 明暗分界线是一个半椭圆，横向半径随相位变化
  const k = Math.cos(2 * Math.PI * p)
  const rx = Math.abs(k) * r
  // 亮面一侧的外缘半圆
  const outerSweep = waxing ? 1 : 0
  // 分界线弯向哪边：盈月前半（蛾眉）凹向亮面，后半（盈凸）凸向暗面
  const innerSweep = waxing ? (k > 0 ? 0 : 1) : k > 0 ? 1 : 0
  return `M 0 ${-r} A ${r} ${r} 0 0 ${outerSweep} 0 ${r} A ${rx.toFixed(2)} ${r} 0 0 ${innerSweep} 0 ${-r} Z`
})
</script>

<template>
  <svg :width="size" :height="size" viewBox="-12 -12 24 24" aria-hidden="true" class="moon">
    <circle r="10" class="dark" />
    <path :d="path" class="lit" />
  </svg>
</template>

<style scoped>
.moon { display: block; flex: none; }
.dark { fill: var(--line); }
.lit { fill: var(--muted); }
@media (prefers-color-scheme: dark) {
  .lit { fill: #e9ecf6; }
}
</style>

<script setup lang="ts">
/**
 * 最近 N 天画成一枝梅花（2026-10-05 起替换原来的星座）：
 * 写了日记的日子开一朵花，花色是心情，心情越好花越大；没写的日子只是枝上的一个小花苞。
 * 花在枝上的位置由日期决定，所以每天的样子是固定的。今天用朱砂圈出来。
 */
import { computed } from 'vue'

interface Day { date: string; has: boolean; mood: number }
const props = defineProps<{ days: Day[]; today: string }>()

const W = 350
const H = 76

function jitter(date: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < date.length; i++) h = Math.imul(h ^ date.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

/** 主枝：从左下往右上斜出，带一点起伏 */
const baseY = (x: number) => 58 - 26 * (x / W) + 5 * Math.sin((x / W) * Math.PI * 2.4)

const branch = computed(() => {
  const pts: string[] = []
  for (let x = 0; x <= W; x += 10) pts.push(`${x},${baseY(x).toFixed(1)}`)
  return `M ${pts.join(' L ')}`
})

const flowers = computed(() => {
  const n = props.days.length
  return props.days.map((d, i) => {
    const x = 10 + (i / Math.max(1, n - 1)) * (W - 20)
    const by = baseY(x)
    // 花朵上下错开，开在小枝上
    const off = d.has ? (jitter(d.date) - 0.6) * 26 : 0
    const r = d.has ? 3.2 + (d.mood || 2) * 0.45 : 1.6
    const rot = jitter(d.date, 7) * 72
    return { ...d, x, by, y: by + off, r, rot, twig: Math.abs(off) > 4 }
  })
})
const petals = [0, 1, 2, 3, 4].map((k) => (k * 72 * Math.PI) / 180)
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="plum" aria-hidden="true">
    <path :d="branch" pathLength="1" class="branch" />
    <template v-for="(f, i) in flowers" :key="f.date">
      <line v-if="f.twig" :x1="f.x - 3" :y1="f.by" :x2="f.x" :y2="f.y" pathLength="1" class="twig"
        :style="{ animationDelay: `${0.4 + i * 0.02}s` }" />
      <g v-if="f.has" :class="`mood-${f.mood}`" class="bloom"
        :style="{ animationDelay: `${0.5 + i * 0.03}s`, transformOrigin: `${f.x}px ${f.y}px` }">
        <g :transform="`translate(${f.x} ${f.y}) rotate(${f.rot})`">
          <circle v-for="(a, k) in petals" :key="k" :cx="Math.cos(a) * f.r * 0.85" :cy="Math.sin(a) * f.r * 0.85" :r="f.r * 0.62" class="petal" />
          <circle r="0.9" class="heart" />
        </g>
      </g>
      <circle v-else :cx="f.x" :cy="f.by - 1.5" :r="f.r" class="bud" />
      <circle v-if="f.date === today" :cx="f.x" :cy="f.has ? f.y : f.by - 1.5" :r="f.r + 4.5" class="today" />
    </template>
  </svg>
</template>

<style scoped>
.plum { display: block; width: 100%; height: auto; overflow: visible; }
.branch {
  fill: none; stroke: var(--ink); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; opacity: 0.82;
  stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 1.1s cubic-bezier(0.4, 0, 0.2, 1) forwards;
}
.twig { stroke: var(--ink); stroke-width: 1.2; stroke-linecap: round; opacity: 0.7; stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 0.4s ease-out forwards; }
@keyframes draw { to { stroke-dashoffset: 0; } }
.petal { fill: var(--mc); opacity: 0.92; }
.heart { fill: var(--ink); opacity: 0.45; }
.bud { fill: var(--ink); opacity: 0.35; }
.today { fill: none; stroke: var(--accent); stroke-width: 1.2; stroke-dasharray: 2.5 2; }
/* 花一朵朵开出来 */
.bloom { animation: bloom 0.6s var(--spring, ease-out) backwards; }
@keyframes bloom { from { opacity: 0; transform: scale(0) rotate(-60deg); } }
.no-motion .branch, .no-motion .twig { stroke-dashoffset: 0; }
</style>

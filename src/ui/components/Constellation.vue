<script setup lang="ts">
/**
 * 最近 N 天画成一片星空：写了日记的日子是一颗星（颜色是心情、大小随心情变亮），
 * 连续写的日子用线连成星座，中断一天线就断开。每颗星的高度由日期决定，所以图案每天固定。
 */
import { computed } from 'vue'

interface Day { date: string; has: boolean; mood: number }
const props = defineProps<{ days: Day[]; today: string }>()

const W = 350
const H = 64

function jitter(date: string): number {
  let h = 2166136261
  for (let i = 0; i < date.length; i++) h = Math.imul(h ^ date.charCodeAt(i), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

const stars = computed(() => {
  const n = props.days.length
  return props.days.map((d, i) => ({
    ...d,
    x: ((i + 0.5) / n) * W,
    y: 12 + jitter(d.date) * (H - 24),
    r: d.has ? 2.2 + (d.mood || 2) * 0.55 : 1.1,
  }))
})

const lines = computed(() => {
  const s = stars.value
  const out: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (let i = 1; i < s.length; i++) {
    if (s[i].has && s[i - 1].has) out.push({ x1: s[i - 1].x, y1: s[i - 1].y, x2: s[i].x, y2: s[i].y })
  }
  return out
})
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="sky" aria-hidden="true">
    <line v-for="(l, i) in lines" :key="i" :x1="l.x1" :y1="l.y1" :x2="l.x2" :y2="l.y2" pathLength="1" class="link"
      :style="{ animationDelay: `${0.35 + i * 0.035}s` }" />
    <g v-for="(s, i) in stars" :key="s.date" :class="`mood-${s.has ? s.mood : 0}`" class="pt"
      :style="{ animationDelay: `${i * 0.025}s`, transformOrigin: `${s.x}px ${s.y}px` }">
      <circle v-if="s.has" :cx="s.x" :cy="s.y" :r="s.r * 2.6" class="halo" :style="{ animationDelay: `${(i * 0.37) % 4}s` }" />
      <circle :cx="s.x" :cy="s.y" :r="s.r" :class="s.has ? 'star' : 'dust'" />
      <circle v-if="s.date === today" :cx="s.x" :cy="s.y" :r="s.r + 3.5" class="today" :style="{ transformOrigin: `${s.x}px ${s.y}px` }" />
    </g>
  </svg>
</template>

<style scoped>
.sky { display: block; width: 100%; height: auto; overflow: visible; }
.link {
  stroke: var(--faint); stroke-width: 0.8; opacity: 0.7; vector-effect: non-scaling-stroke;
  /* 星座连线一段一段画出来 */
  stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw 0.5s ease-out forwards;
}
@keyframes draw { to { stroke-dashoffset: 0; } }
/* 星星从左到右依次亮起，光晕缓慢呼吸，今天的虚线圈慢慢转 */
.pt { animation: star-on 0.5s var(--spring, ease-out) backwards; }
@keyframes star-on { from { opacity: 0; transform: scale(0); } }
.halo { animation: breathe 4s ease-in-out infinite; }
@keyframes breathe { 50% { opacity: 0.3; } }
.today { animation: spin-slow 12s linear infinite; }
@keyframes spin-slow { to { transform: rotate(360deg); } }
.star { fill: var(--mc); }
.dust { fill: var(--faint); opacity: 0.6; }
.halo { fill: var(--mc); opacity: 0.12; }
.today { fill: none; stroke: var(--ink); stroke-width: 1; stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
.no-motion .link { stroke-dashoffset: 0; }
</style>

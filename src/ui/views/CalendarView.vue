<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion, today } from '../../app'
import { ymd } from '../../core/time'
import Icon from '../components/Icon.vue'

defineOptions({ name: 'CalendarView' })

const router = useRouter()
const t = today()
const year = ref(Number(t.slice(0, 4)))
const month = ref(Number(t.slice(5, 7)))

const rows = computed(() => {
  void indexVersion.value
  return new Map(index.month(year.value, month.value).map((r) => [r.date, r]))
})

/** 周一为一周的第一天 */
const cells = computed(() => {
  const first = new Date(year.value, month.value - 1, 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(year.value, month.value, 0).getDate()
  const out: ({ date: string; day: number } | null)[] = Array(lead).fill(null)
  for (let d = 1; d <= days; d++) out.push({ date: ymd(new Date(year.value, month.value - 1, d)), day: d })
  while (out.length % 7) out.push(null)
  return out
})

function shift(n: number) {
  let m = month.value + n
  let y = year.value
  if (m < 1) { m = 12; y-- }
  if (m > 12) { m = 1; y++ }
  month.value = m
  year.value = y
}
function goToday() {
  year.value = Number(t.slice(0, 4))
  month.value = Number(t.slice(5, 7))
}

function open(date: string) {
  if (date > today()) return
  router.push(`/entry/${date}`)
}

// 左右滑动切换月份
let x0 = 0
let y0 = 0
function onStart(e: TouchEvent) {
  x0 = e.touches[0].clientX
  y0 = e.touches[0].clientY
}
function onEnd(e: TouchEvent) {
  const dx = e.changedTouches[0].clientX - x0
  const dy = e.changedTouches[0].clientY - y0
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) shift(dx < 0 ? 1 : -1)
}

const isCurrent = computed(() => year.value === Number(t.slice(0, 4)) && month.value === Number(t.slice(5, 7)))
const MOOD_WORDS = ['很差', '不好', '一般', '不错', '很好']
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1>{{ year }} 年 {{ month }} 月</h1>
      <button v-if="!isCurrent" class="text-btn" @click="goToday">本月</button>
      <button class="icon-btn" aria-label="上个月" @click="shift(-1)"><Icon name="left" /></button>
      <button class="icon-btn" aria-label="下个月" @click="shift(1)"><Icon name="right" /></button>
    </header>

    <p class="count">
      这个月写了 <strong>{{ rows.size }}</strong> 天
    </p>

    <div class="grid" @touchstart.passive="onStart" @touchend="onEnd">
      <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w" class="wh">{{ w }}</span>
      <template v-for="(c, i) in cells" :key="i">
        <span v-if="!c" class="cell blank"></span>
        <button v-else class="cell" :class="{ has: rows.has(c.date), today: c.date === t, future: c.date > t }"
          :disabled="c.date > t"
          :aria-label="`${c.day} 日${rows.has(c.date) ? '，有日记' : '，没写'}`" @click="open(c.date)">
          <span class="num">{{ c.day }}</span>
          <span v-if="rows.has(c.date)" class="dot" :class="rows.get(c.date)?.mood ? `m${rows.get(c.date)?.mood}` : ''"></span>
        </button>
      </template>
    </div>

    <div class="legend" aria-label="心情颜色">
      <span v-for="(w, i) in MOOD_WORDS" :key="w"><i class="dot" :class="`m${i + 1}`"></i>{{ w }}</span>
      <span><i class="dot"></i>没记心情</span>
    </div>
    <p class="hint muted">点没写的日子可以补写。</p>
  </div>
</template>

<style scoped>
.count { margin: 0 16px 12px; color: var(--muted); }
.count strong { font-family: var(--serif); font-size: 22px; color: var(--blue); font-weight: 600; margin: 0 2px; }
.grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
  padding: 0 10px;
}
.wh { text-align: center; font-size: 12px; color: var(--faint); padding-bottom: 6px; }
.cell {
  aspect-ratio: 1 / 1.1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
}
.cell.blank { pointer-events: none; }
.cell .num { font-family: var(--serif); font-size: 17px; font-variant-numeric: lining-nums; }
.cell.has { background: var(--surface); color: var(--ink); }
.cell.has .num { font-weight: 600; }
.cell.today { outline: 1.5px solid var(--blue); outline-offset: -1.5px; }
.cell.today .num { color: var(--blue); }
.cell.future { opacity: 0.35; }
.cell:active:not(:disabled) { background: var(--blue-soft); }
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 20px 16px 0;
  font-size: 12px;
  color: var(--muted);
}
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.hint { margin: 10px 16px; font-size: 13px; }
</style>

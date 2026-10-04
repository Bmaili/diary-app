<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion, today } from '../../app'
import { ymd } from '../../core/time'
import Icon from '../components/Icon.vue'
import MoodFace from '../components/MoodFace.vue'
import MoonIcon from '../components/MoonIcon.vue'
import { MOOD_LABELS, SPECTRAL } from '../mood'
import { moonOnDate } from '../../core/astro'

defineOptions({ name: 'CalendarView' })

const router = useRouter()
const t = today()
const year = ref(Number(t.slice(0, 4)))
const month = ref(Number(t.slice(5, 7)))

const rows = computed(() => {
  void indexVersion.value
  return new Map(index.month(year.value, month.value).map((r) => [r.date, r]))
})

const summary = computed(() => {
  const moods = Array.from(rows.value.values()).map((r) => r.mood).filter((m): m is number => m != null)
  const avg = moods.length ? moods.reduce((a, b) => a + b, 0) / moods.length : null
  return { days: rows.value.size, avg }
})

/** 周一为一周的第一天 */
const cells = computed(() => {
  const first = new Date(year.value, month.value - 1, 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(year.value, month.value, 0).getDate()
  const out: ({ date: string; day: number; phase: number; moon: string } | null)[] = Array(lead).fill(null)
  for (let d = 1; d <= days; d++) {
    const date = ymd(new Date(year.value, month.value - 1, d))
    const m = moonOnDate(date)
    out.push({ date, day: d, phase: m.phase, moon: m.name })
  }
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
const moodOf = (date: string) => rows.value.get(date)?.mood ?? 0
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1><span class="num">{{ month }}</span>月<small class="num">{{ year }}</small></h1>
      <button v-if="!isCurrent" class="text-btn" @click="goToday">回到本月</button>
      <button class="icon-btn" aria-label="上个月" @click="shift(-1)"><Icon name="left" /></button>
      <button class="icon-btn" aria-label="下个月" @click="shift(1)"><Icon name="right" /></button>
    </header>

    <div class="summary">
      <MoodFace :value="summary.avg" :size="44" />
      <p v-if="summary.days">
        这个月写了 <strong>{{ summary.days }}</strong> 天<template v-if="summary.avg != null">，心情大多
          <strong>{{ MOOD_LABELS[Math.round(summary.avg) - 1] }}</strong></template>。
      </p>
      <p v-else class="muted">这个月还没有日记。</p>
    </div>

    <div class="grid" @touchstart.passive="onStart" @touchend="onEnd">
      <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w" class="wh">{{ w }}</span>
      <template v-for="(c, i) in cells" :key="i">
        <span v-if="!c" class="cell blank"></span>
        <button v-else class="cell" :class="[`mood-${moodOf(c.date)}`, { has: rows.has(c.date), today: c.date === t, future: c.date > t }]"
          :disabled="c.date > t"
          :aria-label="`${c.day} 日，${rows.has(c.date) ? (moodOf(c.date) ? '心情' + MOOD_LABELS[moodOf(c.date) - 1] : '有日记') : '没写'}`"
          @click="open(c.date)">
          <span class="d num">{{ c.day }}</span>
          <MoonIcon :phase="c.phase" :size="11" class="m" :title="c.moon" />
        </button>
      </template>
    </div>

    <div class="legend" aria-label="心情颜色">
      <span v-for="(w, i) in MOOD_LABELS" :key="w" :class="`mood-${i + 1}`"><i class="dot"></i>{{ w }}<b class="num">{{ SPECTRAL[i] }}</b></span>
      <span class="mood-0"><i class="dot"></i>没记心情</span>
    </div>
    <p class="hint muted">心情颜色取自恒星光谱：越热越蓝，“一般”和太阳一样是 G 型。每天下面是当晚的月相。点没写的日子可以补写，左右滑动换月份。</p>
  </div>
</template>

<style scoped>
.topbar h1 { display: flex; align-items: baseline; gap: 4px; margin-left: 12px; font-size: 17px; color: var(--muted); }
.topbar h1 .num { font-size: 34px; font-weight: 600; color: var(--ink); line-height: 1; }
.topbar h1 small { margin-left: 6px; font-size: 18px; font-weight: 500; color: var(--faint); }
.summary { display: flex; align-items: center; gap: 12px; margin: 0 20px 16px; }
.summary p { margin: 0; font-size: 15px; }
.summary strong { font-weight: 800; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px 6px; padding: 0 14px; }
.wh { text-align: center; font-size: 12px; color: var(--faint); padding-bottom: 4px; }
.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 0 6px;
  border: 0;
  background: transparent;
  color: var(--faint);
}
.cell.blank { pointer-events: none; }
.d {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  font-size: 19px;
  font-weight: 500;
}
.cell.has .d { background: var(--mc); color: var(--on-mood); font-weight: 600; box-shadow: var(--glow); }
.cell.has.mood-0 .d { background: var(--surface); color: var(--ink); box-shadow: inset 0 0 0 2px var(--m0); }
.cell.today .d { outline: 2px solid var(--ink); outline-offset: 2px; }
.cell.today { color: var(--ink); }
.cell .m { opacity: 0.85; }
.cell.future { opacity: 0.4; }
.cell:active:not(:disabled) .d { transform: scale(0.9); }
.legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 22px 20px 0; font-size: 12px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend b { font-size: 13px; font-weight: 600; color: var(--faint); }
.hint { margin: 10px 20px; font-size: 13px; line-height: 1.6; }
</style>

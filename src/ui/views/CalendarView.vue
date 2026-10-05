<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion, today } from '../../app'
import { ymd } from '../../core/time'
import Icon from '../components/Icon.vue'
import MoodFace from '../components/MoodFace.vue'
import { MOOD_LABELS } from '../mood'
import { lunarDay } from '../../core/lunar'

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
  const out: ({ date: string; day: number; lunar: string; special: boolean; full: string; rest: '' | '休' | '班' } | null)[] = Array(lead).fill(null)
  for (let d = 1; d <= days; d++) {
    const date = ymd(new Date(year.value, month.value - 1, d))
    const l = lunarDay(date)
    const rest = l.holiday ? (l.holiday.off ? '休' : '班') : ''
    const hol = l.holiday ? `${l.holiday.name}${l.holiday.off ? '放假' : '调休上班'}` : ''
    out.push({
      date, day: d, lunar: l.cell, special: !!(l.festival || l.jieqi || l.holiday?.first), rest,
      full: [l.full, l.festival, l.jieqi, hol].filter(Boolean).join('，'),
    })
  }
  while (out.length % 7) out.push(null)
  return out
})

/** 换月动画方向：1 往后（新月份从右边进来），-1 往前 */
const dir = ref(1)
function setMonth(y: number, m: number) {
  month.value = m
  year.value = y
}
function next(n: number) {
  let m = month.value + n
  let y = year.value
  if (m < 1) { m = 12; y-- }
  if (m > 12) { m = 1; y++ }
  return { y, m }
}

// ---------- 换月：跟手拖动，松手后滑走，新月份从另一边滑进来 ----------
const pane = ref<HTMLElement | null>(null)
const dx = ref(0)
const animating = ref(false)
const noMotion = () => document.documentElement.classList.contains('no-motion')

async function slideTo(n: number, target?: { y: number; m: number }) {
  const to = target ?? next(n)
  dir.value = n
  if (noMotion() || !pane.value) {
    setMonth(to.y, to.m)
    dx.value = 0
    return
  }
  const w = pane.value.offsetWidth
  animating.value = true
  dx.value = -n * w
  await new Promise((r) => setTimeout(r, 200))
  animating.value = false
  setMonth(to.y, to.m)
  dx.value = n * w * 0.6
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  animating.value = true
  dx.value = 0
  await new Promise((r) => setTimeout(r, 320))
  animating.value = false
}
function shift(n: number) {
  void slideTo(n)
}
function goToday() {
  const y = Number(t.slice(0, 4))
  const m = Number(t.slice(5, 7))
  const back = y * 12 + m < year.value * 12 + month.value
  void slideTo(back ? -1 : 1, { y, m })
}

function open(date: string) {
  if (date > today()) return
  router.push(`/entry/${date}`)
}

// 左右滑动切换月份
let x0 = 0
let y0 = 0
let axis: '' | 'x' | 'y' = ''
function onStart(e: TouchEvent) {
  if (animating.value) return
  x0 = e.touches[0].clientX
  y0 = e.touches[0].clientY
  axis = ''
}
function onMove(e: TouchEvent) {
  const mx = e.touches[0].clientX - x0
  const my = e.touches[0].clientY - y0
  if (!axis && (Math.abs(mx) > 8 || Math.abs(my) > 8)) axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'
  if (axis !== 'x' || animating.value || noMotion()) return
  // 越拖越沉，像拉橡皮筋
  dx.value = mx * (1 - Math.min(0.5, Math.abs(mx) / 900))
}
function onEnd(e: TouchEvent) {
  const mx = e.changedTouches[0].clientX - x0
  const my = e.changedTouches[0].clientY - y0
  const was = axis
  axis = ''
  if (was === 'x' && Math.abs(mx) > 60 && Math.abs(mx) > Math.abs(my) * 1.2) shift(mx < 0 ? 1 : -1)
  else if (dx.value) {
    animating.value = true
    dx.value = 0
    setTimeout(() => (animating.value = false), 300)
  }
}

const isCurrent = computed(() => year.value === Number(t.slice(0, 4)) && month.value === Number(t.slice(5, 7)))
const moodOf = (date: string) => rows.value.get(date)?.mood ?? 0
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1>
        <Transition :name="dir > 0 ? 'roll-up' : 'roll-down'" mode="out-in">
          <span :key="month" class="num">{{ month }}</span>
        </Transition>月<small class="num">{{ year }}</small>
      </h1>
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

    <div class="grid wk">
      <span v-for="w in ['一', '二', '三', '四', '五', '六', '日']" :key="w" class="wh">{{ w }}</span>
    </div>
    <!-- 换月滑动时把超出的部分裁掉：否则页面会临时变宽，安卓 WebView 会把整个页面（连同底部导航）挪位 -->
    <div class="pane-clip">
    <div ref="pane" class="grid days" :class="{ animating }" :style="{ transform: dx ? `translateX(${dx}px)` : undefined, opacity: dx ? Math.max(0.3, 1 - Math.abs(dx) / 500) : undefined }"
      @touchstart.passive="onStart" @touchmove.passive="onMove" @touchend="onEnd" @touchcancel="onEnd">
      <template v-for="(c, i) in cells" :key="`${year}-${month}-${i}`">
        <span v-if="!c" class="cell blank"></span>
        <button v-else class="cell" :style="{ '--i': i }" :class="[`mood-${moodOf(c.date)}`, { has: rows.has(c.date), today: c.date === t, future: c.date > t }]"
          :disabled="c.date > t"
          :aria-label="`${c.day} 日，${rows.has(c.date) ? (moodOf(c.date) ? '心情' + MOOD_LABELS[moodOf(c.date) - 1] : '有日记') : '没写'}`"
          @click="open(c.date)">
          <span class="d num">{{ c.day }}</span>
          <span class="m" :class="{ special: c.special }" :title="c.full">{{ c.lunar }}</span>
          <span v-if="c.rest" class="rest" :class="{ work: c.rest === '班' }" :aria-label="c.rest === '休' ? '放假' : '调休上班'">{{ c.rest }}</span>
        </button>
      </template>
    </div>
    </div>

    <div class="legend" aria-label="心情颜色">
      <span v-for="(w, i) in MOOD_LABELS" :key="w" :class="`mood-${i + 1}`"><i class="dot"></i>{{ w }}</span>
      <span class="mood-0"><i class="dot"></i>没记心情</span>
    </div>
    <p class="hint muted">每天下面是农历，节气和节日用朱红标出；右上角“休”是法定放假，“班”是调休上班。点没写的日子可以补写，左右滑动换月份。</p>
  </div>
</template>

<style scoped>
.topbar h1 { display: flex; align-items: baseline; gap: 4px; margin-left: 12px; font-size: 17px; color: var(--muted); }
.topbar h1 > .num { display: inline-block; }
.topbar h1 .num { font-size: 34px; font-weight: 600; color: var(--ink); line-height: 1; }
.topbar h1 small { margin-left: 6px; font-size: 18px; font-weight: 500; color: var(--faint); }
.summary { display: flex; align-items: center; gap: 12px; margin: 0 20px 16px; }
.summary p { margin: 0; font-size: 15px; }
.summary strong { font-weight: 800; }
.grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px 6px; padding: 0 14px; }
.pane-clip { overflow: hidden; }
.grid.days { touch-action: pan-y; will-change: transform; }
.grid.days.animating { transition: transform 0.3s var(--ease-out), opacity 0.3s; }
/* 换月后每天依次亮起，有日记的日子弹一下 */
.cell { animation: cell-in 0.4s var(--ease-out) backwards; animation-delay: calc(var(--i) * 9ms); }
.cell.has .d { animation: pop-in 0.45s var(--spring) backwards; animation-delay: calc(var(--i) * 9ms + 80ms); }
@keyframes cell-in { from { opacity: 0; transform: translateY(6px) scale(0.9); } }
.cell.today .d { animation: today-ring 2.8s ease-in-out infinite; }
@keyframes today-ring { 50% { outline-offset: 4px; } }
.roll-up-enter-active, .roll-up-leave-active, .roll-down-enter-active, .roll-down-leave-active { display: inline-block; transition: transform 0.18s var(--ease-out), opacity 0.18s; }
.roll-up-enter-from, .roll-down-leave-to { transform: translateY(60%); opacity: 0; }
.roll-up-leave-to, .roll-down-enter-from { transform: translateY(-60%); opacity: 0; }
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
.cell.has .d { background: var(--mc); color: var(--onm, var(--on-mood)); font-weight: 600; box-shadow: var(--glow); }
.cell.has.mood-0 .d { background: var(--surface); color: var(--ink); box-shadow: inset 0 0 0 2px var(--m0); }
.cell.today .d { outline: 1.5px solid var(--accent); outline-offset: 2px; color: var(--accent); }
.cell.today.has .d { color: var(--onm, var(--on-mood)); }
.cell.today { color: var(--ink); }
.cell .m { font-size: 10px; line-height: 1.1; letter-spacing: 0.02em; color: var(--faint); white-space: nowrap; }
.cell .m.special { color: var(--accent); font-weight: 600; }
.cell { position: relative; }
.rest {
  position: absolute; top: 0; right: 0; z-index: 1;
  padding: 2px; border-radius: 50%; background: var(--bg);
  font-size: 10px; font-weight: 700; line-height: 1; color: var(--accent);
}
.rest.work { color: var(--muted); }
.cell.future { opacity: 0.4; }
.cell:active:not(:disabled) .d { transform: scale(0.9); }
.legend { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 22px 20px 0; font-size: 12px; color: var(--muted); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.hint { margin: 10px 20px; font-size: 13px; line-height: 1.6; }
</style>

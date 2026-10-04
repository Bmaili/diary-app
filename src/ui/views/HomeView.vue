<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion, today } from '../../app'
import type { IndexRow } from '../../core/types'
import EntryRow from '../components/EntryRow.vue'
import Icon from '../components/Icon.vue'
import MoodFace from '../components/MoodFace.vue'
import MoonIcon from '../components/MoonIcon.vue'
import Constellation from '../components/Constellation.vue'
import { daysBetween, moonPhase } from '../../core/astro'
import { addDays, parseYmd } from '../../core/time'

defineOptions({ name: 'HomeView' })

const router = useRouter()
const PAGE = 60
const limit = ref(PAGE)
const todayStr = ref(today())
const hour = ref(new Date().getHours())

const rows = computed(() => {
  void indexVersion.value
  return index.all()
})
const memories = computed(() => {
  void indexVersion.value
  return index.onThisDay(todayStr.value)
})

const titleDate = computed(() => {
  const d = parseYmd(todayStr.value)
  return { m: d.getMonth() + 1, d: d.getDate(), wd: '日一二三四五六'[d.getDay()] }
})
const moon = computed(() => {
  void hour.value
  return moonPhase(new Date())
})
/** 从第一篇日记算起，今天是第几天 */
const dayNo = computed(() => {
  const all = rows.value
  if (!all.length) return 0
  return daysBetween(all[all.length - 1].date, todayStr.value) + 1
})

const stats = computed(() => {
  void indexVersion.value
  const t = todayStr.value
  const wroteToday = !!index.get(t)
  let d = wroteToday ? t : addDays(t, -1)
  let streak = 0
  while (index.get(d)) {
    streak++
    d = addDays(d, -1)
  }
  const monthCount = index.month(Number(t.slice(0, 4)), Number(t.slice(5, 7))).length
  return { wroteToday, streak, monthCount }
})
const subline = computed(() => {
  const s = stats.value
  if (!rows.value.length) return '写下第一篇，第一颗星就亮了。'
  const parts: string[] = []
  if (s.streak >= 2) parts.push(`已经连续写了 ${s.streak} 天`)
  parts.push(`这个月写了 ${s.monthCount} 篇`)
  if (!s.wroteToday) parts.push('今天还没写')
  return parts.join('，') + '。'
})

/** 最近 30 天的心情条，最左边是 29 天前，最右边是今天 */
const ribbon = computed(() => {
  void indexVersion.value
  return Array.from({ length: 30 }, (_, i) => {
    const date = addDays(todayStr.value, i - 29)
    const r = index.get(date)
    return { date, has: !!r, mood: r?.mood ?? 0 }
  })
})

interface Group { key: string; month: string; year: string; rows: IndexRow[] }
const groups = computed<Group[]>(() => {
  const out: Group[] = []
  for (const r of rows.value.slice(0, limit.value)) {
    const key = r.date.slice(0, 7)
    let g = out[out.length - 1]
    if (!g || g.key !== key) {
      g = { key, month: `${Number(key.slice(5))} 月`, year: key.slice(0, 4), rows: [] }
      out.push(g)
    }
    g.rows.push(r)
  }
  return out
})
const thisYear = computed(() => todayStr.value.slice(0, 4))

function yearsAgo(date: string): string {
  const n = Number(todayStr.value.slice(0, 4)) - Number(date.slice(0, 4))
  return n === 1 ? '一年前的今天' : `${n} 年前的今天`
}

function writeToday() {
  todayStr.value = today()
  router.push({ path: `/entry/${todayStr.value}`, query: { append: '1' } })
}

// 滚到底部时加载更多
const sentinel = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null
onMounted(() => {
  io = new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting) && limit.value < rows.value.length) limit.value += PAGE
  }, { rootMargin: '600px' })
  if (sentinel.value) io.observe(sentinel.value)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  io?.disconnect()
  document.removeEventListener('visibilitychange', onVisible)
})
watch(sentinel, (el) => el && io?.observe(el))

// 跨过凌晨切换时刻、或从后台回来时，刷新“今天”
function onVisible() {
  if (!document.hidden) refreshNow()
}
function refreshNow() {
  todayStr.value = today()
  hour.value = new Date().getHours()
}
onActivated(refreshNow)

const memoryDateLabel = (d: string) => {
  const x = parseYmd(d)
  return `${x.getFullYear()} 年 ${x.getMonth() + 1} 月 ${x.getDate()} 日`
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1 class="date">
        <span class="num big">{{ titleDate.m }}.{{ String(titleDate.d).padStart(2, '0') }}</span>
        <span class="wk">星期{{ titleDate.wd }}</span>
      </h1>
      <router-link to="/settings" class="icon-btn" aria-label="设置"><Icon name="settings" /></router-link>
    </header>

    <section class="hello">
      <p class="sky-line">
        <MoonIcon :phase="moon.phase" :size="18" />
        <span>今晚{{ moon.name }}，照亮 <span class="num">{{ Math.round(moon.illumination * 100) }}%</span></span>
        <span v-if="dayNo" class="day-no">记录的第 <span class="num">{{ dayNo }}</span> 天</span>
      </p>
      <Constellation v-if="rows.length" :days="ribbon" :today="todayStr" class="stars" />
      <p class="muted sub">{{ subline }}</p>
    </section>

    <section v-if="memories.length" class="memories" aria-label="那年今日">
      <p class="mem-note">你此刻看到的，是从过去发出的光。</p>
      <div class="mem-track">
        <router-link v-for="m in memories" :key="m.date" :to="`/entry/${m.date}`" class="mem" :class="`mood-${m.mood ?? 0}`">
          <div class="mem-head">
            <MoodFace :value="m.mood ?? null" :size="34" />
            <div>
              <strong>{{ yearsAgo(m.date) }}</strong>
              <span class="muted">{{ memoryDateLabel(m.date) }}</span>
            </div>
          </div>
          <p class="mem-text">{{ m.text.replace(/\s*\n+\s*/g, ' ') }}</p>
        </router-link>
      </div>
    </section>

    <div v-if="!rows.length" class="empty">
      <MoonIcon :phase="moon.phase" :size="72" />
      <p>还没有日记。</p>
      <p class="muted">点右下角的“写今天”，写一句话就行。</p>
    </div>

    <section v-for="g in groups" :key="g.key" class="group">
      <h2 class="month"><span class="num">{{ g.month.replace(' 月', '') }}</span>月<small v-if="g.year !== thisYear" class="num">{{ g.year }}</small></h2>
      <EntryRow v-for="r in g.rows" :key="r.date" :row="r" />
    </section>
    <div ref="sentinel" class="sentinel"></div>

    <button class="fab solid-btn" @click="writeToday">
      <Icon name="pen" />
      写今天
    </button>
  </div>
</template>

<style scoped>
.date { display: flex; align-items: baseline; gap: 10px; margin-left: 12px !important; }
.date .big { font-size: 34px; font-weight: 600; letter-spacing: 0.02em; line-height: 1; }
.date .wk { font-size: 15px; font-weight: 600; color: var(--muted); }
.hello { padding: 0 20px 14px; }
.sky-line { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; color: var(--muted); }
.sky-line .num { font-size: 16px; color: var(--ink); }
.day-no { margin-left: auto; }
.stars { margin: 2px 0 4px; }
.sub { margin: 0; font-size: 14px; }
.memories { padding: 4px 0 14px; }
.mem-note { margin: 0 20px 8px; font-size: 12px; color: var(--faint); }
.mem-track {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  padding: 0 16px;
  scrollbar-width: none;
}
.mem-track::-webkit-scrollbar { display: none; }
.mem {
  position: relative;
  flex: 0 0 calc(100% - 36px);
  scroll-snap-align: center;
  padding: 14px 16px 16px;
  border-radius: 22px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: inherit;
  text-decoration: none;
  overflow: hidden;
}
.mem::before {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--mc);
  opacity: 0.16;
  pointer-events: none;
}
.memories .mem:only-child { flex-basis: 100%; }
.mem-head { position: relative; display: flex; align-items: center; gap: 10px; font-size: 13px; }
.mem-head div { display: flex; flex-direction: column; line-height: 1.35; }
.mem-head strong { font-size: 15px; font-weight: 800; }
.mem-text {
  position: relative;
  margin: 10px 0 0;
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.month {
  position: sticky;
  top: calc(56px + var(--safe-top));
  z-index: 10;
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 10px 20px 6px;
  background-color: var(--bg);
  background-image: var(--stars, none);
  background-attachment: fixed;
  font-size: 15px;
  font-weight: 700;
  color: var(--muted);
}
.month .num { font-size: 26px; font-weight: 600; color: var(--ink); }
.month small { font-size: 16px; font-weight: 500; color: var(--faint); margin-left: 4px; }
.empty { display: flex; flex-direction: column; align-items: center; padding: 40px 32px; text-align: center; }
.empty p { margin: 4px 0; }
.empty p:first-of-type { margin-top: 16px; font-weight: 700; }
.sentinel { height: 1px; }
.fab {
  position: fixed;
  right: 18px;
  bottom: calc(var(--nav-h) + var(--safe-bottom) + 18px);
  z-index: 25;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 56px;
  padding: 0 24px 0 20px;
  border-radius: 28px;
  font-size: 16px;
  box-shadow: 0 10px 24px -10px rgba(18, 24, 52, 0.6);
}
.fab svg { width: 20px; height: 20px; }
</style>

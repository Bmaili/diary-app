<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion, today } from '../../app'
import type { IndexRow } from '../../core/types'
import EntryRow from '../components/EntryRow.vue'
import Icon from '../components/Icon.vue'
import MoodFace from '../components/MoodFace.vue'
import PlumBranch from '../components/PlumBranch.vue'
import Seal from '../components/Seal.vue'
import { lunar as lunarDay } from '../../holidayService'
import { almanac, daily, loadDaily, nextPoem } from '../../dailyService'
import { prefs } from '../../prefs'
import { overall } from '../../syncService'
import { profileFor } from '../../aiService'
import { readSummary } from '../../core/summaries'
import { store } from '../../app'
import { addDays, daysBetween, parseYmd } from '../../core/time'

defineOptions({ name: 'HomeView' })

const router = useRouter()
/**
 * 进场动画只在第一次打开首页时播放。首页是 keep-alive 的：从别的页面回来时，DOM 被重新插回页面，
 * CSS 动画会全部重播（梅枝重画、几十朵花重开、各块重新浮现），中低端手机上返回时会卡一下。
 */
const intro = ref(true)
onMounted(() => setTimeout(() => (intro.value = false), 2200))
const PAGE = 60
const limit = ref(PAGE)
const todayStr = ref(today())

const rows = computed(() => {
  void indexVersion.value
  return index.all()
})
const memories = computed(() => {
  void indexVersion.value
  return index.onThisDay(todayStr.value)
})

const sync = computed(() => overall())
const syncIcon = computed(() => ({ off: 'cloud-off', syncing: 'cloud-up', error: 'cloud-err', pending: 'cloud-up', ok: 'cloud-ok' })[sync.value.kind])
const syncLabel = computed(() => {
  const s = sync.value
  return { off: '未开启同步', syncing: '同步中', error: '同步失败', pending: `待同步 ${s.pending} 个文件`, ok: '已同步' }[s.kind]
})

const titleDate = computed(() => {
  const d = parseYmd(todayStr.value)
  return { m: d.getMonth() + 1, d: d.getDate(), wd: '日一二三四五六'[d.getDay()] }
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
  if (!rows.value.length) return '写下第一篇，枝头就开第一朵花。'
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

// 往下滚时“写今天”缩成一个圆按钮，往上滚或回到顶部时展开
const fabMini = ref(false)
let lastY = 0
let ticking = false
function onScroll() {
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => {
    const y = window.scrollY
    if (Math.abs(y - lastY) > 8) {
      fabMini.value = y > 160 && y > lastY
      lastY = y
    }
    ticking = false
  })
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
  window.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
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
}
const lunar = computed(() => lunarDay(todayStr.value))
watch([todayStr, () => prefs.daily.mode], () => void loadDaily(todayStr.value), { immediate: true })
onActivated(refreshNow)

// 上个月有日记但还没有总结时提示生成；1 月还提示上一年的年度总结（规格 7.5）
const prompts = ref<{ period: string; label: string }[]>([])
async function checkPrompts() {
  if (!profileFor('summary')) {
    prompts.value = []
    return
  }
  const t = todayStr.value
  const y = Number(t.slice(0, 4))
  const m = Number(t.slice(5, 7))
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
  const out: { period: string; label: string }[] = []
  if (index.month(Number(prev.slice(0, 4)), Number(prev.slice(5))).length && !(await readSummary(store, prev))) {
    out.push({ period: prev, label: `生成 ${Number(prev.slice(5))} 月的总结` })
  }
  if (m === 1 && index.all().some((r) => r.date.startsWith(String(y - 1))) && !(await readSummary(store, String(y - 1)))) {
    out.push({ period: String(y - 1), label: `生成 ${y - 1} 年的年度总结` })
  }
  // 没变化就不赋值：每次回到首页都会检查一遍，换成新数组会让整个首页重新渲染
  if (JSON.stringify(out) !== JSON.stringify(prompts.value)) prompts.value = out
}
watch([indexVersion, todayStr], () => void checkPrompts(), { immediate: true })
onActivated(() => void checkPrompts())

const memoryDateLabel = (d: string) => {
  const x = parseYmd(d)
  return `${x.getFullYear()} 年 ${x.getMonth() + 1} 月 ${x.getDate()} 日`
}
</script>

<template>
  <div class="page" :class="{ intro }">
    <header class="topbar">
      <h1 class="date">
        <span class="num big">{{ titleDate.m }}.{{ String(titleDate.d).padStart(2, '0') }}</span>
        <span class="wk">星期{{ titleDate.wd }}</span>
        <Seal :text="lunar.day" :size="30" class="today-seal" />
      </h1>
      <router-link to="/settings/sync" class="icon-btn sync" :class="sync.kind" :aria-label="syncLabel">
        <Icon :name="syncIcon" />
        <span v-if="sync.kind === 'pending' || (sync.kind === 'error' && sync.pending)" class="badge num">{{ sync.pending > 99 ? '99+' : sync.pending }}</span>
      </router-link>
      <router-link to="/settings" class="icon-btn" aria-label="设置"><Icon name="settings" /></router-link>
    </header>

    <section class="hello">
      <p class="sky-line">
        <span>{{ almanac(todayStr) }}</span>
        <span v-if="dayNo" class="day-no">记录的第 <span class="num">{{ dayNo }}</span> 天</span>
      </p>
      <PlumBranch v-if="rows.length" :days="ribbon" :today="todayStr" :intro="intro" class="stars" />
      <p class="muted sub">{{ subline }}</p>
    </section>

    <section v-if="prefs.daily.mode !== 'off' && daily.text" class="poem" aria-label="每日诗词">
      <Transition name="poem" mode="out-in">
        <div :key="daily.text" class="poem-body">
          <p class="verse">{{ daily.text }}</p>
          <p class="cite">—— {{ daily.author }}<template v-if="daily.title">《{{ daily.title }}》</template></p>
        </div>
      </Transition>
      <div class="poem-foot">
        <span class="reason">{{ daily.reason }}</span>
        <button class="text-btn swap" :disabled="daily.busy" @click="nextPoem">{{ daily.busy ? '取诗中' : '换一首' }}</button>
      </div>
    </section>

    <section v-if="prompts.length" class="prompts">
      <router-link v-for="p in prompts" :key="p.period" :to="{ path: `/ai/summary/${p.period}`, query: { generate: '1' } }" class="prompt">
        <Icon name="sparkle" />
        <span>{{ p.label }}</span>
        <Icon name="right" class="chev" />
      </router-link>
    </section>

    <section v-if="memories.length" class="memories" aria-label="那年今日">
      <p class="mem-note">往事如书，翻到了今天这一页。</p>
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
      <Seal text="浮生" :size="64" />
      <p>还没有日记。</p>
      <p class="muted">点右下角的“写今天”，写一句话就行。</p>
    </div>

    <section v-for="g in groups" :key="g.key" class="group">
      <h2 class="month"><span class="num">{{ g.month.replace(' 月', '') }}</span>月<small v-if="g.year !== thisYear" class="num">{{ g.year }}</small></h2>
      <EntryRow v-for="r in g.rows" :key="r.date" :row="r" />
    </section>
    <div ref="sentinel" class="sentinel"></div>

    <button class="fab solid-btn" :class="{ mini: fabMini }" aria-label="写今天" @click="writeToday">
      <Icon name="pen" />
      <span class="fab-label">写今天</span>
    </button>
  </div>
</template>

<style scoped>
.sync { position: relative; color: var(--muted); }
.sync.error { color: var(--danger); }
.sync.off { color: var(--accent); }
.sync.syncing svg { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
.sync .badge {
  position: absolute;
  top: 4px;
  right: 2px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--ink);
  color: var(--bg);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}
.date { display: flex; align-items: baseline; gap: 10px; margin-left: 12px !important; }
.date .big { font-size: 34px; font-weight: 600; letter-spacing: 0.02em; line-height: 1; }
.date .wk { font-size: 15px; font-weight: 600; color: var(--muted); }
.hello { padding: 0 20px 14px; }
.sky-line { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; color: var(--muted); }
.sky-line .num { font-size: 16px; color: var(--ink); }
.day-no { margin-left: auto; }
.today-seal { align-self: center; margin-left: 2px; }
/* 每日诗词：竖线引出，楷体 */
.poem { margin: 0 16px 14px; padding: 12px 16px 6px 18px; border-left: 2px solid var(--accent); }
.intro .poem { animation: rise-in 0.5s var(--ease-out) 0.1s backwards; }
.verse { margin: 0; font-family: var(--kai); font-size: 18px; line-height: 1.75; letter-spacing: 0.06em; color: var(--ink); }
.cite { margin: 4px 0 0; text-align: right; font-size: 13px; color: var(--muted); }
.poem-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 2px; }
.reason { font-size: 12px; color: var(--accent); letter-spacing: 0.1em; }
.swap { min-height: 32px; padding: 0 8px; font-size: 13px; color: var(--muted); font-weight: 600; }
.poem-enter-active, .poem-leave-active { transition: opacity 0.35s, filter 0.35s, transform 0.35s; }
.poem-enter-from, .poem-leave-to { opacity: 0; filter: blur(3px); transform: translateY(4px); }
.stars { margin: 2px 0 4px; }
.sub { margin: 0; font-size: 14px; }
.prompts { padding: 0 16px 12px; display: flex; flex-direction: column; gap: 8px; }
.prompt {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 14px;
  border-radius: 16px;
  border: 1px dashed var(--accent);
  color: inherit;
  text-decoration: none;
  font-weight: 700;
}
.prompt svg { width: 20px; height: 20px; color: var(--accent); flex: none; }
.prompt span { flex: 1; }
.prompt .chev { color: var(--faint); width: 16px; height: 16px; }
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
  background-image: var(--paper, none);
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
.fab svg { width: 20px; height: 20px; flex: none; transition: transform 0.4s var(--spring); }
.fab { gap: 0; transition: padding 0.35s var(--spring), transform 0.18s var(--spring); }
.intro .fab { animation: pop-in 0.5s var(--spring) 0.2s backwards; }
.fab-label { display: inline-block; max-width: 4em; margin-left: 8px; overflow: hidden; white-space: nowrap; transition: max-width 0.35s var(--spring), opacity 0.2s, margin 0.35s; }
.fab.mini { padding: 0 18px; }
.fab.mini .fab-label { max-width: 0; margin-left: 0; opacity: 0; }
.fab.mini svg { transform: rotate(-12deg) scale(1.1); }
/* 首页顶部依次浮现（只在第一次打开时） */
.intro .hello, .intro .prompts, .intro .memories { animation: rise-in 0.5s var(--ease-out) backwards; }
.intro .prompts { animation-delay: 0.08s; }
.intro .memories { animation-delay: 0.14s; }
/*
 * 那年今日不再用跟随滑动的缩放动画（animation-timeline: view()）：
 * 每张卡片都随滑动重算缩放和透明度，安卓 WebView 上横滑会卡。现在只是普通的吸附滑动。
 */
</style>

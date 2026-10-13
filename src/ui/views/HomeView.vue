<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion, settings, today } from '../../app'
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
import { addDays, daysBetween, parseYmd, weekday } from '../../core/time'
import { pickHint, slotOf } from '../../core/hints'
import { diaryFacts } from '../../core/diaryFacts'
import { hintSeed, refreshHintSeed } from '../../hintService'
import { pickWander } from '../../core/wander'
import { letters } from '../../lettersService'
import { motionOn } from '../motion'
import { letterState } from '../../core/letters'
import { pushBack } from '../backStack'
import { backupDue } from '../../core/backupReminder'
import { enabled as syncBackends } from '../../syncService'
import { exportZip, exporting } from '../../backupService'
import { ask } from '../dialog'

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
/** 现在（选提示句用）：回到首页、从后台回来时刷新 */
const nowTs = ref(Date.now())

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
  return parts.join('，') + '。'
})

/**
 * 统计行下面的一句小提示（句库见 core/hints.ts，换句节奏见 hintService.ts）。
 * 还没有日记时不显示（统计行已经在邀请写第一篇）。
 */
const facts = computed(() => {
  void indexVersion.value
  return prefs.ui.diaryHints ? diaryFacts(index.all(), todayStr.value) : { personal: [], afterWrite: [] }
})
const hint = computed(() => {
  const all = rows.value
  if (!all.length || !hintSeed.value) return ''
  const t = todayStr.value
  const s = stats.value
  const prev = all.find((r) => r.date < t)
  return pickHint({
    date: t, now: new Date(nowTs.value), cutoffHour: settings.cutoffHour, seed: hintSeed.value,
    wrote: s.wroteToday, streak: s.streak, gapDays: prev ? daysBetween(prev.date, t) : 0,
    personal: facts.value.personal, afterWrite: facts.value.afterWrite,
  }).text
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
  if (!document.hidden) refreshNow(true)
}
/** @param resumed 从后台回来（小提示隔 30 分钟可以换句）；切页面回来时不算 */
function refreshNow(resumed = false) {
  todayStr.value = today()
  nowTs.value = Date.now()
  refreshHintSeed(todayStr.value, slotOf(new Date().getHours(), settings.cutoffHour), resumed)
}
// 打开 app 时算一次“回来”
refreshNow(true)
const lunar = computed(() => lunarDay(todayStr.value))
watch([todayStr, () => prefs.daily.mode], () => void loadDaily(todayStr.value), { immediate: true })
onActivated(() => refreshNow(false))

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

// ---------- 旧页：首页随机摆一篇旧日记（2026-10-13 起代替“随手翻”按钮） ----------

/** 这次打开 app 摆出来的那一篇；点“换一页”换，跨了一天重新挑 */
const oldDate = ref<string | null>(null)
let oldDay = ''
function pickOld() {
  oldDate.value = pickWander(rows.value, todayStr.value, oldDate.value ?? undefined)
  oldDay = todayStr.value
}
const oldPage = computed(() => {
  void indexVersion.value
  // 设置里关掉了；那年今日出现的那天，旧页让位，首页不要两张回忆卡
  if (!prefs.ui.oldPage || memories.value.length) return null
  const r = oldDate.value ? index.get(oldDate.value) : undefined
  return r && r.date < todayStr.value ? r : null
})
watch([rows, todayStr], () => {
  if (oldDay !== todayStr.value || !oldDate.value || !index.get(oldDate.value)) pickOld()
}, { immediate: true })
function oldLabel(d: string): string {
  const x = parseYmd(d)
  const y = x.getFullYear() === Number(todayStr.value.slice(0, 4)) ? '' : `${x.getFullYear()} 年 `
  return `${y}${x.getMonth() + 1} 月 ${x.getDate()} 日 · ${weekday(d)}`
}

/** 正在落下的那一页（复制了旧内容，固定在原来的位置上开始飘） */
const oldEl = ref<HTMLElement | null>(null)
const leaf = ref<null | { label: string; text: string; mood?: number; style: Record<string, string> }>(null)
const turned = ref(false)
/** 撕口：顶边一排小锯齿 */
const TEAR = (() => {
  const n = 18
  const pts = ['0 100%', '0 5px']
  for (let i = 1; i <= n; i++) pts.push(`${((i - 0.5) / n) * 100}% ${i % 2 ? 0 : 3}px`, `${(i / n) * 100}% 5px`)
  pts.push('100% 100%')
  return `polygon(${pts.join(', ')})`
})()
function turnPage() {
  const cur = oldPage.value
  const el = oldEl.value
  if (cur && el && motionOn()) {
    const r = el.getBoundingClientRect()
    // 往左还是往右飘，每次随机；只飘一小段就淡淡消失
    const dir = Math.random() < 0.5 ? -1 : 1
    leaf.value = {
      label: oldLabel(cur.date),
      text: cur.text.replace(/\s*\n+\s*/g, ' '),
      mood: cur.mood,
      style: {
        left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height - 44}px`,
        '--dir': String(dir), clipPath: TEAR,
      },
    }
  }
  pickOld()
  turned.value = false
  requestAnimationFrame(() => (turned.value = true))
}

// ---------- 信到了：首页弹出信封（规格 5.13） ----------

const homeActive = ref(true)
onActivated(() => (homeActive.value = true))
onDeactivated(() => (homeActive.value = false))
const arrivedList = computed(() => letters.list.filter((l) => letterState(l, todayStr.value) === 'arrived'))
const showArrival = computed(() => homeActive.value && !letters.snoozed && arrivedList.value.length > 0)
let removeBack: (() => void) | null = null
watch(showArrival, (on) => {
  removeBack?.()
  removeBack = on ? pushBack(snooze) : null
}, { immediate: true })
function snooze() {
  removeBack = null
  letters.snoozed = true
}
function openArrived() {
  const l = arrivedList.value[0]
  if (!l) return
  removeBack?.()
  removeBack = null
  letters.snoozed = true
  router.push(`/letters/${l.id}`)
}
/** “一年前的你”“三个月前的你”…… */
function fromWhen(writtenDate: string): string {
  const n = daysBetween(writtenDate, todayStr.value)
  if (n >= 365) {
    const y = Math.floor(n / 365)
    return y === 1 ? '一年前的你' : `${y} 年前的你`
  }
  if (n >= 30) return `${Math.floor(n / 30)} 个月前的你`
  return n <= 1 ? '昨天的你' : `${n} 天前的你`
}
const arrivalTitle = computed(() => {
  const list = arrivedList.value
  if (list.length > 1) return `有 ${list.length} 封信到了`
  return list[0] ? `${fromWhen(list[0].id.slice(0, 10))}，寄来一封信` : ''
})
const arrivalSub = computed(() => {
  const l = arrivedList.value[0]
  if (!l) return ''
  const d = parseYmd(l.id.slice(0, 10))
  return `写于 ${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`
})

// ---------- 备份提醒 ----------

const showBackup = computed(() =>
  backupDue({
    entries: rows.value.length,
    syncOn: syncBackends().length,
    lastExport: prefs.backup.lastExport,
    dismissed: prefs.backup.dismissed,
    now: new Date(nowTs.value),
  }),
)
const backupMsg = ref('')
async function backupExport() {
  backupMsg.value = ''
  try {
    await exportZip()
  } catch (e) {
    backupMsg.value = `导出失败：${(e as Error).message}`
  }
}
async function dismissBackup() {
  if (await ask({
    title: '不再提醒备份？',
    message: '以后可以在“设置 → 同步与备份”开启云端同步，或在“设置 → 导出全部日记”手动备份。',
    ok: '不再提醒', cancel: '再想想',
  })) {
    prefs.backup.dismissed = true
  }
}

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
      <p v-if="hint" class="hint-line">{{ hint }}</p>
    </section>

    <section v-if="prefs.daily.mode !== 'off' && daily.text" class="poem" aria-label="每日诗词">
      <Transition name="poem" mode="out-in">
        <div :key="daily.text" class="poem-body">
          <p class="verse">{{ daily.text }}</p>
        </div>
      </Transition>
      <div class="poem-foot">
        <span class="cite"><span v-if="daily.reason" class="reason">{{ daily.reason }}</span>{{ daily.author }}<template v-if="daily.title">《{{ daily.title }}》</template></span>
        <button class="text-btn swap" :disabled="daily.busy" @click="nextPoem">{{ daily.busy ? '取诗中' : '换一首' }}</button>
      </div>
    </section>

    <section v-if="oldPage" ref="oldEl" class="oldpage" :class="`mood-${oldPage.mood ?? 0}`" aria-label="旧页">
      <router-link :key="oldPage.date" :to="`/entry/${oldPage.date}`" class="op-main" :class="{ turned }">
        <div class="op-head">
          <span class="op-seal">旧页</span>
          <span class="op-date">{{ oldLabel(oldPage.date) }}</span>
          <MoodFace :value="oldPage.mood ?? null" :size="26" class="op-face" />
        </div>
        <p class="op-text">{{ oldPage.text.replace(/\s*\n+\s*/g, ' ') }}</p>
      </router-link>
      <div class="op-foot">
        <button class="text-btn swap" @click="turnPage">换一页</button>
      </div>
    </section>

    <!-- 换一页：旧的那页像从日历上撕下来，飘飘摇摇落下去（ui.motion 关掉时不飘） -->
    <Teleport to="body">
      <div v-if="leaf" class="leaf-layer" aria-hidden="true">
        <div class="leaf" :class="`mood-${leaf.mood ?? 0}`" :style="leaf.style" @animationend="leaf = null">
          <div class="op-head">
            <span class="op-seal">旧页</span>
            <span class="op-date">{{ leaf.label }}</span>
            <MoodFace :value="leaf.mood ?? null" :size="26" class="op-face" />
          </div>
          <p class="op-text">{{ leaf.text }}</p>
        </div>
      </div>
    </Teleport>

    <section v-if="showBackup" class="backup" aria-label="备份提醒">
      <button class="icon-btn close" aria-label="不再提醒" @click="dismissBackup"><Icon name="close" /></button>
      <p class="b-title">这些日记还没有备份</p>
      <p class="b-text">写了 <span class="num">{{ rows.length }}</span> 篇，都只在这台手机上。手机丢了、坏了或卸载重装，就找不回来了。</p>
      <div class="b-acts">
        <router-link to="/settings/sync" class="solid-btn b-btn">开启云端同步</router-link>
        <button class="b-btn ghost" :disabled="exporting.busy" @click="backupExport">
          {{ exporting.busy ? (exporting.total ? `${exporting.done}/${exporting.total}` : '打包中') : '导出 zip' }}
        </button>
      </div>
      <p v-if="backupMsg" class="b-err">{{ backupMsg }}</p>
    </section>

    <section v-else-if="prompts.length" class="prompts">
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
          <p class="mem-text">{{ m.text.replace(/\s*\n+\s*/g, ' ') || '这天只记了心情。' }}</p>
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

    <Teleport to="body">
      <Transition name="arrive">
        <div v-if="showArrival" class="arrive-backdrop" @click.self="snooze">
          <section class="arrive" role="dialog" aria-modal="true" :aria-label="arrivalTitle">
            <svg class="arrive-env" viewBox="0 0 140 96" aria-hidden="true">
              <rect x="2" y="2" width="136" height="92" rx="4" />
              <path d="M2 4 L70 52 L138 4" />
              <rect class="arrive-seal" x="54" y="36" width="32" height="32" rx="3" />
              <text x="70" y="58" text-anchor="middle">封</text>
            </svg>
            <p class="arrive-title">{{ arrivalTitle }}</p>
            <p class="arrive-sub">{{ arrivalSub }}</p>
            <button class="arrive-open" @click="openArrived">拆开</button>
            <button class="arrive-later" @click="snooze">晚点再看</button>
          </section>
        </div>
      </Transition>
    </Teleport>

    <router-link to="/search" class="fab fab-search" :class="{ mini: fabMini }" aria-label="搜索">
      <Icon name="search" />
      <span class="fab-label">搜索</span>
    </router-link>
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
.hello { padding: 0 20px 10px; }
.sky-line { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 14px; color: var(--muted); }
.sky-line .num { font-size: 16px; color: var(--ink); }
.day-no { margin-left: auto; }
.today-seal { align-self: center; margin-left: 2px; }
/* 每日诗词：竖线引出，楷体 */
.poem { margin: 0 16px 12px; padding: 4px 12px 0 14px; border-left: 2px solid var(--accent); }
.intro .poem { animation: rise-in 0.5s var(--ease-out) 0.1s backwards; }
.verse { margin: 0; font-family: var(--kai); font-size: 16px; line-height: 1.65; letter-spacing: 0.05em; color: var(--ink); }
/* 出处、节令标签和“换一首”放在同一行，诗词这一块只占两三行高 */
.poem-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cite { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); }
.reason { margin-right: 8px; color: var(--accent); letter-spacing: 0.1em; }
.swap { flex: none; min-height: 30px; padding: 0 4px; font-size: 12px; color: var(--muted); font-weight: 600; }
.poem-enter-active, .poem-leave-active { transition: opacity 0.35s, filter 0.35s, transform 0.35s; }
.poem-enter-from, .poem-leave-to { opacity: 0; filter: blur(3px); transform: translateY(4px); }
.stars { margin: 2px 0 4px; }
.sub { margin: 0; font-size: 14px; }
.hint-line { margin: 3px 0 0; font-family: var(--kai); font-size: 15px; line-height: 1.6; letter-spacing: 0.04em; color: var(--ink); opacity: 0.8; }
/* 旧页：和“那年今日”同一种卡片，心情色从顶上淡淡晕开 */
.oldpage {
  position: relative;
  margin: 0 16px 14px;
  padding: 14px 16px 4px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: var(--surface);
  overflow: hidden;
}
.oldpage::before { content: ''; position: absolute; inset: 0; background: var(--mc); opacity: 0.14; pointer-events: none; }
.op-main { position: relative; display: block; color: inherit; text-decoration: none; }
.op-main:active { opacity: 0.6; }
.op-head { display: flex; align-items: center; gap: 10px; }
.op-seal { flex: none; padding: 1px 5px; border: 1.2px solid var(--accent); border-radius: 3px; color: var(--accent); font-family: var(--kai); font-size: 13px; letter-spacing: 0.15em; }
.op-date { flex: 1; min-width: 0; font-size: 14px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.op-face { flex: none; }
.op-text { margin: 10px 0 0; font-size: 16px; line-height: 1.7; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.op-foot { position: relative; display: flex; justify-content: flex-end; }
.op-foot .swap { min-height: 40px; padding: 0 4px; font-size: 12px; color: var(--muted); font-weight: 600; }
/* 换上来的新一页：从下面那张纸上浮现 */
.op-main.turned { animation: page-in 0.5s var(--ease-out) 0.12s backwards; }
@keyframes page-in { from { opacity: 0; transform: translateY(4px); } }
/* 信到了：底部弹出的信封 */
.arrive-backdrop { position: fixed; inset: 0; z-index: 120; display: flex; align-items: flex-end; background: rgba(26, 24, 22, 0.42); }
.arrive {
  width: 100%;
  padding: 18px 24px calc(28px + var(--safe-bottom));
  border-radius: 24px 24px 0 0;
  background-color: var(--surface);
  background-image: var(--paper, none);
  text-align: center;
}
.arrive::before { content: ''; display: block; width: 36px; height: 4px; margin: 0 auto 16px; border-radius: 2px; background: var(--line); }
.arrive-env { display: block; width: 140px; height: 96px; margin: 0 auto; }
.arrive-env rect:first-child { fill: var(--bg); stroke: var(--faint); }
.arrive-env path { fill: none; stroke: var(--faint); stroke-width: 1.2; }
.arrive-env .arrive-seal { fill: var(--accent); }
.arrive-env text { fill: var(--on-accent); font-family: var(--kai); font-size: 17px; }
.arrive-title { margin: 18px 0 0; font-family: var(--kai); font-size: 20px; }
.arrive-sub { margin: 8px 0 0; font-size: 14px; color: var(--muted); }
.arrive-open { width: 100%; min-height: 50px; margin-top: 22px; border: 0; border-radius: 25px; background: var(--accent); color: var(--on-accent); font: inherit; font-size: 17px; font-weight: 700; }
.arrive-later { width: 100%; min-height: 44px; margin-top: 8px; border: 0; background: none; color: var(--muted); font: inherit; font-size: 15px; }
.arrive-enter-active, .arrive-leave-active { transition: opacity 0.25s ease; }
.arrive-enter-active .arrive { transition: transform 0.45s var(--spring); }
.arrive-leave-active .arrive { transition: transform 0.22s ease-in; }
.arrive-enter-from, .arrive-leave-to { opacity: 0; }
.arrive-enter-from .arrive, .arrive-leave-to .arrive { transform: translateY(100%); }
.leaf-layer { position: fixed; inset: 0; z-index: 30; overflow: hidden; pointer-events: none; }
.leaf {
  position: absolute;
  box-sizing: border-box;
  padding: 18px 16px 8px;
  border: 1px solid var(--line);
  border-radius: 4px 4px 22px 22px;
  background-color: var(--surface);
  background-image: linear-gradient(color-mix(in srgb, var(--mc) 14%, transparent), color-mix(in srgb, var(--mc) 14%, transparent));
  box-shadow: 0 10px 24px -14px rgba(0, 0, 0, 0.45);
  transform-origin: 50% 0;
  --fall: 150px;
  animation: leaf-fall 1s cubic-bezier(0.4, 0.1, 0.6, 0.9) forwards;
}
/* 先从顶边掀起（撕下来），再左右飘摆着落一小段，边落边淡 */
@keyframes leaf-fall {
  0% { transform: none; opacity: 1; }
  16% { transform: translateY(-6px) rotate(calc(var(--dir) * -3deg)); opacity: 1; }
  42% { transform: translate(calc(var(--dir) * -14px), calc(var(--fall) * 0.3)) rotate(calc(var(--dir) * 5deg)); opacity: 0.85; }
  70% { transform: translate(calc(var(--dir) * 12px), calc(var(--fall) * 0.65)) rotate(calc(var(--dir) * -4deg)); opacity: 0.45; }
  100% { transform: translate(calc(var(--dir) * -6px), var(--fall)) rotate(calc(var(--dir) * 8deg)); opacity: 0; }
}
.backup {
  position: relative;
  margin: 0 16px 14px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
}
.backup .close { position: absolute; top: 2px; right: 2px; color: var(--muted); }
.backup .close svg { width: 18px; height: 18px; }
.b-title { margin: 0; padding-right: 32px; font-weight: 700; }
.b-text { margin: 6px 28px 0 0; font-size: 14px; line-height: 1.65; color: var(--muted); }
.b-acts { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.b-btn { min-height: 40px; padding: 0 16px; border-radius: 20px; font-size: 14px; display: inline-flex; align-items: center; text-decoration: none; }
.b-btn.ghost { border: 1px solid var(--faint); background: none; color: var(--ink); font: inherit; font-size: 14px; }
.b-btn.ghost:disabled { color: var(--faint); }
.b-err { margin: 8px 0 0; font-size: 13px; color: var(--danger); }
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
  bottom: calc(var(--nav-h) + var(--safe-bottom) + 34px);
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
/* 搜索：在“写今天”上面，浅色，不和主按钮抢 */
.fab-search {
  bottom: calc(var(--nav-h) + var(--safe-bottom) + 34px + 56px + 12px);
  min-height: 48px;
  padding: 0 18px 0 16px;
  border: 1px solid var(--line);
  border-radius: 24px;
  background: var(--surface);
  color: var(--ink);
  font-weight: 700;
  text-decoration: none;
  box-shadow: 0 8px 20px -12px rgba(18, 24, 52, 0.5);
}
.fab-search svg { width: 18px; height: 18px; }
.fab-search.mini { padding: 0 14px; }
.fab-search.mini svg { transform: none; }
/* 首页顶部依次浮现（只在第一次打开时） */
.intro .oldpage, .intro .backup { animation: rise-in 0.5s var(--ease-out) 0.06s backwards; }
.intro .hello, .intro .prompts, .intro .memories { animation: rise-in 0.5s var(--ease-out) backwards; }
.intro .prompts { animation-delay: 0.08s; }
.intro .memories { animation-delay: 0.14s; }
/*
 * 那年今日不再用跟随滑动的缩放动画（animation-timeline: view()）：
 * 每张卡片都随滑动重算缩放和透明度，安卓 WebView 上横滑会卡。现在只是普通的吸附滑动。
 */
</style>

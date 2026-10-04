<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion, today } from '../../app'
import type { IndexRow } from '../../core/types'
import EntryRow from '../components/EntryRow.vue'
import Icon from '../components/Icon.vue'
import { parseYmd } from '../../core/time'

defineOptions({ name: 'HomeView' })

const router = useRouter()
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

interface Group { key: string; label: string; rows: IndexRow[] }
const groups = computed<Group[]>(() => {
  const out: Group[] = []
  for (const r of rows.value.slice(0, limit.value)) {
    const key = r.date.slice(0, 7)
    let g = out[out.length - 1]
    if (!g || g.key !== key) {
      g = { key, label: `${key.slice(0, 4)} 年 ${Number(key.slice(5))} 月`, rows: [] }
      out.push(g)
    }
    g.rows.push(r)
  }
  return out
})

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
})
onBeforeUnmount(() => io?.disconnect())
watch(sentinel, (el) => el && io?.observe(el))

// 跨过凌晨切换时刻后回到首页，“那年今日”应更新
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) todayStr.value = today()
})

const memoryDateLabel = (d: string) => {
  const x = parseYmd(d)
  return `${x.getFullYear()} 年 ${x.getMonth() + 1} 月 ${x.getDate()} 日`
}
</script>

<template>
  <div class="page">
    <header class="topbar">
      <h1>日记</h1>
      <router-link to="/settings" class="icon-btn" aria-label="设置"><Icon name="settings" /></router-link>
    </header>

    <section v-if="memories.length" class="memories" aria-label="那年今日">
      <div class="mem-track">
        <router-link v-for="m in memories" :key="m.date" :to="`/entry/${m.date}`" class="mem">
          <div class="mem-head">
            <strong>{{ yearsAgo(m.date) }}</strong>
            <span class="muted">{{ memoryDateLabel(m.date) }}</span>
          </div>
          <p class="mem-text">{{ m.text.replace(/\s*\n+\s*/g, ' ') }}</p>
        </router-link>
      </div>
    </section>

    <div v-if="!rows.length" class="empty">
      <p>还没有日记。</p>
      <p class="muted">点右下角的“写今天”开始第一篇。</p>
    </div>

    <section v-for="g in groups" :key="g.key" class="group">
      <h2 class="month">{{ g.label }}</h2>
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
.memories { padding: 4px 0 12px; }
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
  flex: 0 0 calc(100% - 28px);
  scroll-snap-align: center;
  padding: 14px 16px;
  border-left: 3px solid var(--blue);
  border-radius: 4px 12px 12px 4px;
  background: var(--surface);
  color: inherit;
  text-decoration: none;
}
.memories .mem:only-child { flex-basis: 100%; }
.mem-head { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; }
.mem-head strong { color: var(--blue); font-weight: 600; }
.mem-text {
  margin: 6px 0 0;
  font-family: var(--serif);
  line-height: 1.75;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.month {
  position: sticky;
  top: calc(52px + var(--safe-top));
  z-index: 10;
  margin: 0;
  padding: 10px 16px 6px;
  background: var(--paper);
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--line);
}
.empty { padding: 48px 32px; text-align: center; }
.empty p { margin: 4px 0; }
.sentinel { height: 1px; }
.fab {
  position: fixed;
  right: 16px;
  bottom: calc(var(--nav-h) + var(--safe-bottom) + 16px);
  z-index: 25;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 0 22px 0 18px;
  border-radius: 26px;
  font-size: 16px;
  box-shadow: 0 6px 18px -6px rgba(39, 69, 140, 0.55);
}
.fab svg { width: 20px; height: 20px; }
</style>

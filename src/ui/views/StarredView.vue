<script setup lang="ts">
/** 珍藏集（2026-10-13 加入）：点了星的日子，按年份分组，新的在前 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { index, indexVersion } from '../../app'
import type { IndexRow } from '../../core/types'
import EntryRow from '../components/EntryRow.vue'
import Icon from '../components/Icon.vue'

const router = useRouter()

const rows = computed(() => {
  void indexVersion.value
  return index.starred()
})
const years = computed(() => {
  const out: { year: string; rows: IndexRow[] }[] = []
  for (const r of rows.value) {
    const y = r.date.slice(0, 4)
    if (out[out.length - 1]?.year !== y) out.push({ year: y, rows: [] })
    out[out.length - 1].rows.push(r)
  }
  return out
})

function goBack() {
  if (window.history.state?.back) router.back()
  else router.replace('/')
}
</script>

<template>
  <div class="starred-page">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="goBack"><Icon name="back" /></button>
      <h1>珍藏</h1>
      <span v-if="rows.length" class="count"><span class="num">{{ rows.length }}</span> 篇</span>
    </header>

    <div v-if="!rows.length" class="empty">
      <Icon name="star" class="big-star" />
      <p>还没有珍藏的日子。</p>
      <p class="muted">打开一篇日记，点顶上的星，就会收在这里。</p>
    </div>

    <section v-for="g in years" :key="g.year">
      <h2 class="year num">{{ g.year }}</h2>
      <EntryRow v-for="r in g.rows" :key="r.date" :row="r" />
    </section>
  </div>
</template>

<style scoped>
.starred-page { padding-bottom: calc(var(--safe-bottom) + 28px); }
.count { margin-left: auto; margin-right: 16px; font-size: 14px; color: var(--muted); }
.year {
  position: sticky;
  top: calc(56px + var(--safe-top));
  z-index: 10;
  margin: 0;
  padding: 10px 20px 6px;
  background-color: var(--bg);
  background-image: var(--paper, none);
  font-size: 22px;
  font-weight: 600;
}
.empty { display: flex; flex-direction: column; align-items: center; padding: 56px 32px; text-align: center; }
.empty p { margin: 4px 0; }
.empty p:first-of-type { margin-top: 14px; font-weight: 700; }
.big-star { width: 44px; height: 44px; color: var(--accent); }
</style>

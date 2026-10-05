<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { index, indexVersion } from '../../app'
import type { ListField } from '../../core/types'
import { weekday } from '../../core/time'
import Icon from '../components/Icon.vue'

defineOptions({ name: 'SearchView' })

const q = ref('')
const debounced = ref('')
let t: ReturnType<typeof setTimeout> | undefined
watch(q, (v) => {
  clearTimeout(t)
  t = setTimeout(() => (debounced.value = v), 150)
})

const showFilters = ref(false)
const f = reactive({
  from: '',
  to: '',
  moods: [] as number[],
  tags: [] as string[],
  people: [] as string[],
  places: [] as string[],
})
const filterCount = computed(
  () => (f.from ? 1 : 0) + (f.to ? 1 : 0) + f.moods.length + f.tags.length + f.people.length + f.places.length,
)
function toggle<T>(arr: T[], v: T) {
  const i = arr.indexOf(v)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(v)
}
function clearFilters() {
  f.from = f.to = ''
  f.moods.splice(0)
  f.tags.splice(0)
  f.people.splice(0)
  f.places.splice(0)
}

const options = computed(() => {
  void indexVersion.value
  const pick = (k: ListField) => index.values(k).slice(0, 30).map((x) => x.value)
  return { tags: pick('tags'), people: pick('people'), places: pick('places') }
})

const active = computed(() => debounced.value.trim() !== '' || filterCount.value > 0)
const hits = computed(() => {
  void indexVersion.value
  if (!active.value) return []
  return index.search({
    q: debounced.value,
    from: f.from || undefined,
    to: f.to || undefined,
    moods: f.moods,
    tags: f.tags,
    people: f.people,
    places: f.places,
  })
})
const limit = ref(50)
watch(hits, () => (limit.value = 50))

const groups: { key: ListField; label: string }[] = [
  { key: 'tags', label: '标签' },
  { key: 'people', label: '人物' },
  { key: 'places', label: '地点' },
]
</script>

<template>
  <div class="page">
    <header class="topbar search-bar">
      <label class="box">
        <Icon name="search" class="lead" />
        <input v-model="q" type="search" placeholder="在所有日记里搜索" enterkeyhint="search"
          aria-label="搜索关键词" />
      </label>
      <button class="icon-btn filter-btn" :class="{ on: showFilters || filterCount }" aria-label="筛选"
        :aria-expanded="showFilters" @click="showFilters = !showFilters">
        <Icon name="filter" />
        <span v-if="filterCount" class="badge">{{ filterCount }}</span>
      </button>
    </header>

    <section v-if="showFilters" class="filters">
      <div class="frow">
        <span class="flabel">日期</span>
        <div class="dates">
          <input v-model="f.from" type="date" class="field" aria-label="开始日期" />
          <span class="muted">至</span>
          <input v-model="f.to" type="date" class="field" aria-label="结束日期" />
        </div>
      </div>
      <div class="frow">
        <span class="flabel">心情</span>
        <div class="opts">
          <button v-for="m in 5" :key="m" class="chip" :class="{ on: f.moods.includes(m) }" @click="toggle(f.moods, m)">
            <span class="dot" :class="`mood-${m}`"></span>{{ ['很差', '不好', '一般', '不错', '很好'][m - 1] }}
          </button>
        </div>
      </div>
      <div v-for="g in groups" :key="g.key" class="frow">
        <span class="flabel">{{ g.label }}</span>
        <div class="opts">
          <span v-if="!options[g.key].length" class="muted small">还没有记录过</span>
          <button v-for="v in options[g.key]" :key="v" class="chip" :class="{ on: f[g.key].includes(v) }"
            @click="toggle(f[g.key], v)">{{ v }}</button>
        </div>
      </div>
      <button v-if="filterCount" class="text-btn" @click="clearFilters">清除筛选</button>
    </section>

    <p v-if="active" class="total">共 <strong>{{ hits.length }}</strong> 篇</p>
    <div v-else class="idle"><Icon name="search" class="scope" /><p class="hint muted">输入关键词，或打开筛选按日期、心情、标签查找。多个词用空格隔开，会找同时包含它们的日记。</p></div>

    <ul class="results">
      <li v-for="h in hits.slice(0, limit)" :key="h.row.date">
        <router-link :to="`/entry/${h.row.date}`" class="hit">
          <div class="hit-head">
            <span class="hd">{{ h.row.date.replace(/-/g, '.') }}</span>
            <span class="muted">{{ weekday(h.row.date) }}</span>
            <span v-if="h.row.mood" class="dot" :class="`mood-${h.row.mood}`"></span>
            <span v-for="tag in h.row.tags" :key="tag" class="muted small">#{{ tag }}</span>
          </div>
          <p class="snip">
            <template v-for="(s, i) in h.snippet" :key="i">
              <mark v-if="s.hit" class="hl">{{ s.text }}</mark>
              <template v-else>{{ s.text }}</template>
            </template>
          </p>
        </router-link>
      </li>
    </ul>
    <button v-if="hits.length > limit" class="text-btn more" @click="limit += 50">再显示 50 篇</button>
  </div>
</template>

<style scoped>
.search-bar { gap: 6px; padding-left: 12px; }
.box {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 12px;
  border-radius: 21px;
  background: var(--surface);
  border: 1px solid var(--line);
}
.box:focus-within { box-shadow: inset 0 0 0 1.5px var(--ink); }
.box .lead { width: 18px; height: 18px; color: var(--faint); flex: none; }
.box input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font-size: 16px; }
.filter-btn { position: relative; }
.filter-btn.on { background: var(--surface); }
.badge {
  position: absolute;
  top: 6px;
  right: 4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--ink);
  color: var(--bg);
  font-size: 11px;
  line-height: 16px;
}
.filters { padding: 4px 16px 12px; border-bottom: 1px solid var(--line); }
.frow { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px; align-items: start; margin-bottom: 12px; }
.flabel { font-size: 13px; color: var(--muted); padding-top: 6px; }
.dates { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 6px; min-width: 0; }
.dates .field { min-width: 0; width: 100%; min-height: 38px; padding: 0 6px; font-size: 14px; }
.opts { display: flex; flex-wrap: wrap; gap: 6px; }
.small { font-size: 13px; }
.total { margin: 8px 16px; color: var(--muted); }
.total strong { color: var(--ink); font-size: 18px; font-weight: 800; }
.idle { display: flex; flex-direction: column; align-items: center; padding: 40px 32px 0; }
.scope { width: 56px; height: 56px; color: var(--faint); stroke-width: 1.2; }
.hint { margin: 16px 0; line-height: 1.7; font-size: 14px; text-align: center; }
.results { list-style: none; margin: 0; padding: 0; }
.hit {
  display: block;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
  color: inherit;
  text-decoration: none;
}
.hit:active { background: var(--surface); }
.hit-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.hd { font-family: var(--num); font-size: 17px; font-weight: 600; letter-spacing: 0.02em; }
.snip { margin: 4px 0 0; line-height: 1.7; }
.more { display: block; margin: 12px auto; }
/* 结果依次浮现；望远镜轻轻摆动 */
.results > li { animation: rise-in 0.35s var(--ease-out) backwards; }
.results > li:nth-child(2) { animation-delay: 0.03s; }
.results > li:nth-child(3) { animation-delay: 0.06s; }
.results > li:nth-child(4) { animation-delay: 0.09s; }
.results > li:nth-child(5) { animation-delay: 0.12s; }
.results > li:nth-child(n + 6) { animation-delay: 0.15s; }
.scope { animation: sway 5s ease-in-out infinite; transform-origin: 50% 80%; }
@keyframes sway { 50% { transform: rotate(-8deg); } }
.filters { animation: rise-in 0.3s var(--ease-out); }
</style>

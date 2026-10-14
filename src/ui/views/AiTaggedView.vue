<script setup lang="ts">
/** AI 标注一览（规格 7.4）：哪些标了、标了什么，哪些还没标、为什么跳过 */
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { index, indexVersion } from '../../app'
import { byMonth, extractOverview, PENDING_LABEL, SKIP_LABEL, type TaggedRow } from '../../core/extractOverview'
import { weekday } from '../../core/time'
import type { ListField } from '../../core/types'

type Tab = 'tagged' | 'pending' | 'skipped'
const route = useRoute()
const router = useRouter()

const overview = computed(() => {
  void indexVersion.value
  return extractOverview(index.all())
})
const counts = computed(() => ({
  tagged: overview.value.tagged.length,
  pending: overview.value.pending.length,
  skipped: overview.value.skipped.length,
}))
const tab = computed<Tab>(() => {
  const q = route.query.tab as Tab
  if (q === 'tagged' || q === 'pending' || q === 'skipped') return q
  return counts.value.tagged || !counts.value.pending ? 'tagged' : 'pending'
})
const setTab = (t: Tab) => router.replace({ query: { tab: t } })
const TABS: { id: Tab; label: string }[] = [
  { id: 'tagged', label: '已标注' },
  { id: 'pending', label: '待标注' },
  { id: 'skipped', label: '跳过' },
]

/** 一次显示的篇数：几千篇一下子全排出来会卡 */
const PAGE = 150
const limit = ref(PAGE)
watch(tab, () => (limit.value = PAGE))

interface ViewRow { date: string; preview: string; why?: string; warn?: boolean; t?: TaggedRow }
const list = computed<ViewRow[]>(() => {
  const o = overview.value
  if (tab.value === 'tagged') return o.tagged.map((t) => ({ date: t.date, preview: t.preview, t }))
  if (tab.value === 'pending') return o.pending.map((r) => ({ date: r.date, preview: r.preview, why: PENDING_LABEL[r.reason] }))
  return o.skipped.map((r) => ({ date: r.date, preview: r.preview, why: SKIP_LABEL[r.reason], warn: r.reason === 'broken' }))
})
const months = computed(() => byMonth(list.value.slice(0, limit.value)))

const FIELDS: { f: ListField; icon: string; label: string }[] = [
  { f: 'places', icon: 'pin', label: '地点' },
  { f: 'people', icon: 'person', label: '人物' },
  { f: 'tags', icon: 'hash', label: '标签' },
]

const monthLabel = (m: string) => `${m.slice(0, 4)} 年 ${Number(m.slice(5, 7))} 月`
const dayLabel = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`

const EMPTY: Record<Tab, string> = {
  tagged: '还没有标注过的日记。',
  pending: '都标注过了。',
  skipped: '没有跳过的日记。',
}
</script>

<template>
  <div class="settings tagged-page">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>标注一览</h1>
    </header>

    <div class="seg" role="tablist">
      <button v-for="t in TABS" :key="t.id" role="tab" :aria-selected="tab === t.id" :class="{ on: tab === t.id }" @click="setTab(t.id)">
        {{ t.label }} <span class="num">{{ counts[t.id] }}</span>
      </button>
    </div>

    <p v-if="tab === 'tagged' && counts.tagged" class="hint pad">虚线框的是你手动改过的，AI 不会再动它。点一篇可以打开看。</p>
    <p v-else-if="tab === 'pending' && counts.pending" class="hint pad">回到上一页点“开始标注”，会从这些里接着做。</p>
    <p v-else-if="tab === 'skipped' && counts.skipped" class="hint pad">这些日记批量标注不会处理。</p>

    <p v-if="!list.length" class="desc pad empty">{{ EMPTY[tab] }}</p>

    <section v-for="g in months" :key="g.month">
      <h2>{{ monthLabel(g.month) }}<span class="num cnt">{{ g.rows.length }} 篇</span></h2>
      <router-link v-for="r in g.rows" :key="r.date" :to="`/entry/${r.date}`" class="item link row">
        <div>
          <div class="top">
            <span class="d num">{{ dayLabel(r.date) }}</span><span class="wd">{{ weekday(r.date) }}</span>
            <span v-if="r.why" class="why" :class="{ warn: r.warn }">{{ r.why }}</span>
          </div>
          <div v-if="r.preview" class="desc preview">{{ r.preview }}</div>
          <template v-if="r.t">
            <div v-if="r.t.places.length || r.t.people.length || r.t.tags.length" class="vals">
              <template v-for="x in FIELDS" :key="x.f">
                <span v-for="v in r.t[x.f]" :key="x.f + v" class="tag" :class="{ manual: r.t.locked.includes(x.f) }" :aria-label="`${x.label} ${v}${r.t.locked.includes(x.f) ? '（手动）' : ''}`">
                  <Icon :name="x.icon" class="ti" />{{ v }}
                </span>
              </template>
            </div>
            <div v-else class="desc none">没标出地点、人物或标签</div>
          </template>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
    </section>

    <button v-if="list.length > limit" class="text-btn more" @click="limit += PAGE">再显示 {{ Math.min(PAGE, list.length - limit) }} 篇</button>
  </div>
</template>

<style scoped>
.seg { display: flex; gap: 6px; margin: 4px 16px 10px; }
.seg button { min-height: 34px; padding: 0 14px; border: 1px solid var(--line); border-radius: 17px; background: transparent; color: var(--muted); font-size: 14px; }
.seg button.on { background: var(--ink); border-color: var(--ink); color: var(--bg); font-weight: 700; }
.hint { margin-top: 0; margin-bottom: 4px; font-size: 13px; color: var(--muted); line-height: 1.55; }
.empty { margin-top: 24px; text-align: center; }
.tagged-page section > h2 { display: flex; justify-content: space-between; }
.cnt { font-weight: 400; }
.row { align-items: flex-start; content-visibility: auto; contain-intrinsic-size: auto 92px; }
.top { display: flex; align-items: baseline; gap: 8px; }
.d { font-weight: 600; }
.wd { font-size: 13px; color: var(--muted); }
.why { margin-left: auto; font-size: 12px; color: var(--muted); white-space: nowrap; }
.why.warn { color: var(--danger); }
.preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vals { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.tag { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); font-size: 13px; line-height: 1.5; }
.tag.manual { border-style: dashed; border-color: var(--faint); background: transparent; }
.ti { width: 13px; height: 13px; color: var(--muted); }
.none { font-size: 12px; color: var(--faint); }
.chev { margin-top: 3px; }
.more { display: block; margin: 14px auto 0; }
</style>

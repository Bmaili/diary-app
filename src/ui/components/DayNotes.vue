<script setup lang="ts">
/** 回答、小传里“提到的日子”：汉字日期、心情点、正文开头，点开那天（规格 7.3） */
import { computed, ref } from 'vue'
import { index, indexVersion, today } from '../../app'
import { cnDay } from '../../core/answer'
import { previewText } from '../../core/bio'
import { weekday } from '../../core/time'
import Icon from './Icon.vue'

const props = withDefaults(defineProps<{ dates: string[]; fold?: number; title?: string }>(), { fold: 3, title: '提到的日子' })
const open = ref(false)
const rows = computed(() => {
  void indexVersion.value
  const y = today().slice(0, 4)
  return props.dates
    .map((d) => index.get(d))
    .filter((r): r is NonNullable<typeof r> => !!r && !r.error)
    .map((r) => ({ date: r.date, day: cnDay(r.date, y), wd: weekday(r.date), mood: r.mood, preview: r.aiExclude ? '' : previewText(r.text, 50) }))
})
const shown = computed(() => (open.value ? rows.value : rows.value.slice(0, props.fold)))
</script>

<template>
  <section v-if="rows.length" class="notes" :aria-label="title">
    <h3 class="nt">{{ title }}<span v-if="rows.length > fold" class="num">{{ rows.length }} 天</span></h3>
    <router-link v-for="r in shown" :key="r.date" :to="`/entry/${r.date}`" class="note-row">
      <span class="d"><b>{{ r.day }}</b><small>{{ r.wd }}</small></span>
      <i class="dot" :class="r.mood ? `mood-${r.mood}` : 'none'" :aria-label="r.mood ? '' : '没记心情'"></i>
      <span class="p">{{ r.preview || '这篇设了不让 AI 读' }}</span>
      <Icon name="right" class="go" />
    </router-link>
    <button v-if="rows.length > fold" class="more" :aria-expanded="open" @click="open = !open">
      {{ open ? '收起' : `还有 ${rows.length - fold} 天` }}<Icon :name="open ? 'up' : 'down'" />
    </button>
  </section>
</template>

<style scoped>
.notes { margin: 14px 0 4px; }
.nt { display: flex; justify-content: space-between; margin: 0 0 6px; font-size: 13px; font-weight: 400; color: var(--muted); }
.nt .num { color: var(--faint); }
.note-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); color: inherit; text-decoration: none; }
.note-row:last-of-type { border-bottom: 1px solid var(--line); }
.note-row:active { background: var(--surface); }
.d { flex: none; width: 92px; display: flex; flex-direction: column; line-height: 1.35; }
.d b { font-family: var(--kai); font-weight: 400; font-size: 15px; }
.d small { font-size: 11.5px; color: var(--faint); }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--m0); }
.dot.mood-1 { background: var(--m1); } .dot.mood-2 { background: var(--m2); } .dot.mood-3 { background: var(--m3); }
.dot.mood-4 { background: var(--m4); } .dot.mood-5 { background: var(--m5); }
.p { flex: 1; min-width: 0; font-size: 13.5px; line-height: 1.6; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.go { flex: none; width: 16px; height: 16px; color: var(--faint); }
.more { display: flex; align-items: center; justify-content: center; gap: 3px; width: 100%; min-height: 40px; border: 0; background: none; color: var(--muted); font-size: 13px; }
.more svg { width: 15px; height: 15px; }
</style>

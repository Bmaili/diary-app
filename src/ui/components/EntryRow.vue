<script setup lang="ts">
import { computed } from 'vue'
import type { IndexRow } from '../../core/types'
import { weekday } from '../../core/time'
import { moodLabel } from '../mood'
import Icon from './Icon.vue'

const props = defineProps<{ row: IndexRow }>()
const day = computed(() => String(Number(props.row.date.slice(8))))
/** 列表摘要把段落连成一行，避免空行占掉三行里的位置 */
const excerpt = computed(() => props.row.text.replace(/\s*\n+\s*/g, ' '))
/** 列表下方：天气、地点（选过的位置和“去过的地方”，去重）、提到的人 */
const places = computed(() => [...new Set([props.row.locationName, ...props.row.places].filter(Boolean) as string[])])
</script>

<template>
  <router-link :to="`/entry/${row.date}`" class="row" :class="`mood-${row.mood ?? 0}`" :data-date="row.date">
    <div class="side">
      <span class="blob num" :title="moodLabel(row.mood)">{{ day }}</span>
      <span class="wd">{{ weekday(row.date) }}</span>
    </div>
    <div class="content">
      <p v-if="row.error" class="broken">这个文件格式有误，app 不会改动它。打开可查看原文。</p>
      <p class="excerpt">{{ excerpt }}</p>
      <div v-if="row.tags.length || row.weather || places.length || row.people.length" class="meta">
        <span v-for="t in row.tags" :key="t" class="tag">#{{ t }}</span>
        <span v-if="row.weather">{{ row.weather }}</span>
        <span v-for="p in places" :key="'p' + p" class="place"><Icon name="pin" />{{ p }}</span>
        <span v-for="p in row.people" :key="'u' + p" class="person"><Icon name="person" />{{ p }}</span>
      </div>
    </div>
  </router-link>
</template>

<style scoped>
.row {
  position: relative;
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 14px;
  padding: 10px 16px 14px;
  color: inherit;
  text-decoration: none;
}
/* 竖线把同一个月的日子串起来，像一串珠子 */
.row::before {
  content: '';
  position: absolute;
  left: 41px;
  opacity: 0.7;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--line);
}
.row:active .content { opacity: 0.6; }
/* 滚动时每一条从下方浮上来，日期圆点像星星一样亮起（浏览器原生的滚动驱动动画，不占主线程） */
@supports (animation-timeline: view()) {
  .row { animation: row-rise linear both; animation-timeline: view(); animation-range: entry 0% entry 55%; }
  .blob { animation: blob-pop linear both; animation-timeline: view(); animation-range: entry 5% entry 60%; }
}
@keyframes row-rise { from { opacity: 0; transform: translateY(32px); } }
@keyframes blob-pop { from { transform: scale(0.3) rotate(-30deg); opacity: 0; } 70% { transform: scale(1.12); } }
.side { position: relative; display: flex; flex-direction: column; align-items: center; }
.blob {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--mc);
  color: var(--onm, var(--on-mood));
  font-size: 23px;
  font-weight: 600;
  box-shadow: var(--glow);
}
.mood-0 .blob { background: var(--surface); color: var(--ink); box-shadow: inset 0 0 0 2px var(--line); }
.wd { position: relative; margin-top: 6px; padding: 1px 2px; font-size: 12px; line-height: 1.2; color: var(--muted); background: var(--bg); }
.content { min-width: 0; padding-top: 4px; }
.excerpt {
  margin: 0;
  font-size: 16px;
  line-height: 1.7;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 6px; font-size: 13px; color: var(--muted); }
.tag { color: var(--ink); font-weight: 600; }
.place, .person { display: inline-flex; align-items: center; gap: 2px; }
.place svg, .person svg { width: 13px; height: 13px; flex: none; opacity: 0.8; }
.broken { margin: 0 0 4px; font-size: 13px; color: var(--danger); }
</style>

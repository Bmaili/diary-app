<script setup lang="ts">
import { computed } from 'vue'
import type { IndexRow } from '../../core/types'
import { weekday } from '../../core/time'

const props = defineProps<{ row: IndexRow; showYear?: boolean }>()
const day = computed(() => props.row.date.slice(8))
/** 列表摘要把段落连成一行，避免空行占掉三行里的位置 */
const excerpt = computed(() => props.row.text.replace(/\s*\n+\s*/g, ' '))
const meta = computed(() =>
  [props.row.weather, props.row.locationName, ...props.row.tags.map((t) => `#${t}`)].filter(Boolean) as string[],
)
</script>

<template>
  <router-link :to="`/entry/${row.date}`" class="row">
    <div class="gutter">
      <span v-if="showYear" class="year">{{ row.date.slice(0, 4) }}.{{ row.date.slice(5, 7) }}</span>
      <span class="day">{{ day }}</span>
      <span class="wd">{{ weekday(row.date) }}</span>
    </div>
    <div class="content">
      <div v-if="row.mood || meta.length" class="meta">
        <span v-if="row.mood" class="dot" :class="`m${row.mood}`" :title="`心情 ${row.mood}`"></span>
        <span v-for="m in meta" :key="m">{{ m }}</span>
      </div>
      <p v-if="row.error" class="broken">这个文件格式有误，app 不会改动它。打开可查看原文。</p>
      <p class="excerpt">{{ excerpt }}</p>
    </div>
  </router-link>
</template>

<style scoped>
.row {
  display: grid;
  grid-template-columns: 56px 1fr;
  gap: 12px;
  padding: 16px 16px 16px 12px;
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid var(--line);
}
.row:active { background: var(--surface); }
.gutter {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding-top: 2px;
}
.year { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.day {
  font-family: var(--serif);
  font-size: 34px;
  line-height: 1;
  font-weight: 400;
  color: var(--blue);
  font-variant-numeric: lining-nums tabular-nums;
}
.wd { margin-top: 6px; font-size: 12px; color: var(--muted); }
.content { min-width: 0; }
.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin-bottom: 4px;
  font-size: 13px;
  color: var(--muted);
}
.excerpt {
  margin: 0;
  font-family: var(--serif);
  font-size: 16px;
  line-height: 1.75;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.broken { margin: 0 0 4px; font-size: 13px; color: var(--danger); }
</style>

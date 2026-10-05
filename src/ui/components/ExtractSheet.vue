<script setup lang="ts">
/** AI 标注的结果：深色是新增的，确认后写入 */
import Sheet from './Sheet.vue'
import type { Extraction } from '../../core/llm/extract'
import type { EntryMeta } from '../../core/types'

defineProps<{ open: boolean; busy: boolean; error: string; x: Extraction | null; meta?: EntryMeta }>()
const emit = defineEmits<{ close: []; accept: [] }>()
const FIELD_NAMES = { places: '去过的地方', people: '提到的人', tags: '标签' } as const
</script>

<template>
  <Sheet :open="open" title="AI 标注" @close="emit('close')">
    <p v-if="busy" class="muted">正在读这篇日记……</p>
    <p v-if="error" class="ai-err">{{ error }}</p>
    <template v-if="x && meta">
      <div v-for="f in (['places', 'people', 'tags'] as const)" :key="f" class="ai-row">
        <div class="ai-h">{{ FIELD_NAMES[f] }}<span v-if="meta.locked?.includes(f)" class="ai-lock">你改过，不会覆盖</span></div>
        <div class="ai-vals" :class="{ dim: meta.locked?.includes(f) }">
          <span v-for="v in x[f]" :key="v" class="chip" :class="{ on: !(meta[f] ?? []).includes(v) }">{{ v }}</span>
          <span v-if="!x[f].length" class="muted">（无）</span>
        </div>
      </div>
      <p class="muted small-note">深色的是新增的。确认后写入这篇日记的元数据。</p>
      <button class="solid-btn" @click="emit('accept')">写入</button>
    </template>
  </Sheet>
</template>

<style scoped>
.ai-row { margin-bottom: 14px; }
.ai-h { margin-bottom: 6px; font-size: 13px; font-weight: 700; color: var(--muted); }
.ai-lock { margin-left: 8px; font-weight: 400; color: var(--faint); }
.ai-vals { display: flex; flex-wrap: wrap; gap: 6px; }
.ai-vals.dim { opacity: 0.45; }
.ai-err { color: var(--danger); font-size: 14px; }
.small-note { font-size: 12px; margin: 4px 0 12px; }
</style>

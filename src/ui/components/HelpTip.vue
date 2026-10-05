<script setup lang="ts">
/** 配置项旁边的“？”：点开展开说明和配置教程，再点收起 */
import { ref } from 'vue'
import Icon from './Icon.vue'

defineProps<{ title: string; label?: string }>()
const open = ref(false)
</script>

<template>
  <div class="help">
    <div class="help-head">
      <h2>{{ title }}</h2>
      <button class="help-btn" :class="{ on: open }" :aria-expanded="open" :aria-label="label ?? `${title}的配置教程`" @click="open = !open">
        <Icon name="help" /><span>{{ open ? '收起' : '教程' }}</span>
      </button>
    </div>
    <Transition name="help">
      <div v-if="open" class="help-box"><slot /></div>
    </Transition>
  </div>
</template>

<style scoped>
.help-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.help-head h2 { margin: 0; font-size: 15px; font-weight: 700; color: var(--ink); }
.help-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 0 10px 0 6px;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
}
.help-btn svg { width: 18px; height: 18px; }
.help-btn.on { border-color: var(--accent); color: var(--accent); }
.help-box {
  margin-top: 10px;
  padding: 12px 14px;
  border-left: 3px solid var(--accent);
  border-radius: 4px 12px 12px 4px;
  background: var(--surface);
  font-size: 14px;
  line-height: 1.75;
}
.help-box :deep(ol) { margin: 0; padding-left: 1.3em; }
.help-box :deep(li) { margin-bottom: 6px; }
.help-box :deep(p) { margin: 6px 0; }
.help-box :deep(code), .help-box :deep(pre) { font-family: ui-monospace, monospace; font-size: 12px; background: var(--bg); border-radius: 4px; }
.help-box :deep(code) { padding: 0 3px; }
.help-box :deep(pre) { margin: 6px 0; padding: 8px; overflow-x: auto; white-space: pre; }
.help-box :deep(.tip) { color: var(--muted); font-size: 13px; }
.help-enter-active, .help-leave-active { transition: opacity 0.2s, transform 0.25s var(--ease-out, ease-out); }
.help-enter-from, .help-leave-to { opacity: 0; transform: translateY(-6px); }
</style>

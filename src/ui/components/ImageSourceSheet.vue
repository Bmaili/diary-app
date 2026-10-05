<script setup lang="ts">
/** 插图：拍照或从相册选 */
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: ['camera' | 'gallery'] }>()
</script>

<template>
  <Sheet :open="open" title="插图" @close="emit('close')">
    <div class="img-src">
      <button class="src" @click="emit('pick', 'camera')"><Icon name="camera" /><span>拍照</span></button>
      <button class="src" @click="emit('pick', 'gallery')"><Icon name="image" /><span>从相册选</span></button>
    </div>
    <p class="muted small-note">拍的照片只存进日记，不会出现在系统相册里。</p>
  </Sheet>
</template>

<style scoped>
.img-src { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.src {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 0;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  font-weight: 700;
}
.src svg { width: 30px; height: 30px; }
.src:active { transform: scale(0.96); }
.small-note { font-size: 12px; margin: 4px 0 12px; }
</style>

<script setup lang="ts">
/** 插图：拍照、从手机相册选（可多选），或者用系统的选择器 */
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'

defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; pick: ['camera' | 'gallery' | 'files'] }>()
</script>

<template>
  <Sheet :open="open" title="插图" @close="emit('close')">
    <div class="img-src">
      <button class="src" @click="emit('pick', 'camera')"><Icon name="camera" /><span>拍照</span></button>
      <button class="src" @click="emit('pick', 'gallery')"><Icon name="image" /><span>从相册选</span><small>可以多选</small></button>
    </div>
    <p class="muted small-note">
      拍的照片只存进日记，不会出现在系统相册里。相册里找不到想要的图？
      <button class="text-btn inline" @click="emit('pick', 'files')">用系统的选择器</button>
    </p>
  </Sheet>
</template>

<style scoped>
.img-src { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.src {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 0 16px;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  font-weight: 700;
}
.src small { margin-top: -6px; font-size: 12px; font-weight: 400; color: var(--faint); }
.src svg { width: 30px; height: 30px; }
.src:active { transform: scale(0.96); }
.small-note { font-size: 12px; margin: 4px 0 12px; line-height: 1.7; }
.inline { display: inline; min-height: 0; padding: 0; font-size: 12px; color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
</style>

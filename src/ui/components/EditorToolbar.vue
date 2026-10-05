<script setup lang="ts">
/**
 * 编辑时贴在键盘上方的快捷按钮条。按钮只插入 Markdown 符号。
 * 按下时阻止默认行为，编辑框不失焦、键盘不收起、选区不丢。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'

export type ToolAction = 'bold' | 'bullet' | 'number' | 'todo' | 'quote' | 'time' | 'image' | 'undo'
defineProps<{ imgBusy?: boolean }>()
const emit = defineEmits<{ action: [ToolAction] }>()

const tools: { a: ToolAction; icon: string; label: string }[] = [
  { a: 'bold', icon: 'bold', label: '加粗' },
  { a: 'bullet', icon: 'list', label: '列表' },
  { a: 'number', icon: 'ol', label: '编号' },
  { a: 'todo', icon: 'todo', label: '待办' },
  { a: 'quote', icon: 'quote', label: '引用' },
  { a: 'time', icon: 'clock', label: '插入时间' },
  { a: 'image', icon: 'image', label: '插入图片' },
  { a: 'undo', icon: 'undo', label: '撤销' },
]

// 键盘弹出时，有的系统缩小网页（bottom: 0 正好在键盘上方），有的只是盖住网页；用 visualViewport 统一算出键盘高度
const offset = ref(0)
function update() {
  const vv = window.visualViewport
  if (!vv) return
  offset.value = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
}
onMounted(() => {
  window.visualViewport?.addEventListener('resize', update)
  window.visualViewport?.addEventListener('scroll', update)
  update()
})
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener('resize', update)
  window.visualViewport?.removeEventListener('scroll', update)
})
</script>

<template>
  <div class="toolbar" role="toolbar" aria-label="格式"
    :style="{ bottom: `${offset}px`, paddingBottom: offset ? '4px' : 'calc(4px + var(--safe-bottom))' }">
    <button v-for="t in tools" :key="t.a" class="tool" :aria-label="t.label" :title="t.label"
      :disabled="t.a === 'image' && imgBusy" @pointerdown.prevent @mousedown.prevent @click="emit('action', t.a)">
      <Icon :name="t.icon" />
    </button>
  </div>
</template>

<style scoped>
.toolbar {
  position: fixed;
  left: 0;
  right: 0;
  z-index: 40;
  display: flex;
  gap: 2px;
  overflow-x: auto;
  padding: 4px 8px;
  background-color: var(--bg);
  background-image: var(--paper, none);
  background-attachment: fixed;
  border-top: 1px solid var(--line);
  scrollbar-width: none;
}
.toolbar::-webkit-scrollbar { display: none; }
.tool {
  flex: none;
  display: grid;
  place-items: center;
  width: 44px;
  height: 40px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
}
.tool:active:not(:disabled) { background: var(--surface); color: var(--ink); }
.tool:disabled { opacity: 0.35; }
.tool svg { width: 22px; height: 22px; }
</style>

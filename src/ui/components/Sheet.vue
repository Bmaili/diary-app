<script setup lang="ts">
defineProps<{ open: boolean; title: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="backdrop" @click.self="emit('close')">
        <div class="sheet" role="dialog" :aria-label="title">
          <div class="head">
            <h2>{{ title }}</h2>
            <button class="text-btn" @click="emit('close')">完成</button>
          </div>
          <div class="body"><slot /></div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: flex-end;
  background: rgba(15, 20, 25, 0.35);
}
.sheet {
  width: 100%;
  max-height: 80vh;
  overflow-y: auto;
  /* 往下多伸出一截，回弹时底部不会露缝 */
  margin-bottom: -40px;
  padding: 8px 16px calc(60px + var(--safe-bottom));
  border-radius: 24px 24px 0 0;
  background: var(--bg);
  box-shadow: 0 -10px 40px -12px rgba(0, 0, 0, 0.3);
}
/* 顶部的小横条 */
.sheet::before { content: ''; display: block; width: 36px; height: 4px; margin: 0 auto 2px; border-radius: 2px; background: var(--line); }
.head { display: flex; align-items: center; justify-content: space-between; min-height: 48px; }
.head h2 { margin: 0; font-size: 18px; font-weight: 800; }
/* 弹出时带一点回弹，收起时干脆利落 */
.sheet-enter-active { transition: opacity 0.25s ease; }
.sheet-leave-active { transition: opacity 0.2s ease 0.05s; }
.sheet-enter-active .sheet { transition: transform 0.42s var(--spring); }
.sheet-leave-active .sheet { transition: transform 0.22s ease-in; }
.sheet-enter-from, .sheet-leave-to { opacity: 0; }
.sheet-enter-from .sheet, .sheet-leave-to .sheet { transform: translateY(100%); }
.sheet-enter-active :deep(.body > *) { animation: rise-in 0.4s var(--ease-out) 0.08s backwards; }
</style>

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
  padding: 8px 16px calc(20px + var(--safe-bottom));
  border-radius: 16px 16px 0 0;
  background: var(--paper);
}
.head { display: flex; align-items: center; justify-content: space-between; min-height: 48px; }
.head h2 { margin: 0; font-size: 17px; font-weight: 600; }
.sheet-enter-active, .sheet-leave-active { transition: opacity 0.18s ease; }
.sheet-enter-active .sheet, .sheet-leave-active .sheet { transition: transform 0.22s ease; }
.sheet-enter-from, .sheet-leave-to { opacity: 0; }
.sheet-enter-from .sheet, .sheet-leave-to .sheet { transform: translateY(40px); }
</style>

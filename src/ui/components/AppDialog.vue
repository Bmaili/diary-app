<script setup lang="ts">
/** app 自己的提示框（见 ui/dialog.ts）：宣纸底、圆角，按钮写清楚要做什么 */
import { nextTick, ref, watch } from 'vue'
import { answer, dialog } from '../dialog'
import { pushBack } from '../backStack'

const box = ref<HTMLElement | null>(null)
const field = ref<HTMLInputElement | null>(null)
let removeBack: (() => void) | null = null

watch(
  () => dialog.current,
  async (req) => {
    removeBack?.()
    removeBack = null
    if (!req) return
    // 安卓返回键：按 dismiss 关掉
    removeBack = pushBack(() => {
      removeBack = null
      answer(null)
    })
    await nextTick()
    if (req.input) field.value?.focus()
    else box.value?.querySelector<HTMLElement>('.dlg-btn:not(.ghost)')?.focus()
  },
)

function pick(value: string | null) {
  removeBack?.()
  removeBack = null
  answer(value)
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') pick(null)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="dialog.current" class="dlg-backdrop" @click.self="pick(null)" @keydown="onKey">
        <section ref="box" class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title"
          :aria-describedby="dialog.current.message ? 'dlg-msg' : undefined">
          <h2 id="dlg-title" class="dlg-title">{{ dialog.current.title }}</h2>
          <p v-if="dialog.current.message" id="dlg-msg" class="dlg-msg">{{ dialog.current.message }}</p>
          <input v-if="dialog.current.input" ref="field" v-model="dialog.input" class="field dlg-input"
            :aria-label="dialog.current.input.label" @keydown.enter.prevent="pick('yes')" />
          <div class="dlg-acts" :class="{ stacked: dialog.current.stacked }">
            <button v-for="b in dialog.current.buttons" :key="b.value" class="dlg-btn" :class="b.kind ?? 'primary'"
              @click="pick(b.value)">{{ b.label }}</button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dlg-backdrop {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 28px calc(24px + var(--safe-bottom));
  background: rgba(26, 24, 22, 0.42);
}
.dlg {
  width: 100%;
  max-width: 380px;
  max-height: 80vh;
  overflow-y: auto;
  padding: 24px 22px 18px;
  border: 1px solid var(--line);
  border-radius: 24px;
  background-color: var(--surface);
  background-image: var(--paper, none);
  box-shadow: 0 18px 48px -12px rgba(0, 0, 0, 0.45);
}
.dlg-title { margin: 0; font-size: 19px; font-weight: 700; line-height: 1.45; }
.dlg-msg { margin: 10px 0 0; font-size: 15px; line-height: 1.75; color: var(--muted); white-space: pre-line; }
.dlg-input { width: 100%; margin-top: 14px; }
.dlg-acts { display: flex; gap: 10px; margin-top: 20px; }
.dlg-acts.stacked { flex-direction: column; }
.dlg-btn {
  flex: 1;
  min-height: 46px;
  padding: 0 14px;
  border-radius: 23px;
  font: inherit;
  font-size: 16px;
  line-height: 1.3;
}
.dlg-btn.primary { border: 0; background: var(--ink); color: var(--bg); font-weight: 700; }
.dlg-btn.danger { border: 0; background: var(--accent); color: var(--on-accent); font-weight: 700; }
.dlg-btn.ghost { border: 1px solid var(--faint); background: none; color: var(--ink); }
.dlg-btn:active { transform: scale(0.97); }
.dlg-enter-active, .dlg-leave-active { transition: opacity 0.2s ease; }
.dlg-enter-active .dlg { transition: transform 0.32s var(--spring), opacity 0.2s ease; }
.dlg-leave-active .dlg { transition: transform 0.18s ease-in, opacity 0.18s ease-in; }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
.dlg-enter-from .dlg, .dlg-leave-to .dlg { transform: scale(0.94); opacity: 0; }
</style>

<script setup lang="ts">
/**
 * PIN 键盘。输入的每一位点亮一颗星。
 * - 给了 len：输满自动提交（解锁用）
 * - 没给 len：4–8 位，按“确定”提交（设置新 PIN 用）
 */
import { computed, ref } from 'vue'

const props = defineProps<{ len?: number; disabled?: boolean; shake?: number }>()
const emit = defineEmits<{ submit: [string]; extra: [] }>()
defineSlots<{ extra?: () => unknown }>()

const pin = ref('')
const slots = computed(() => props.len ?? Math.max(4, Math.min(8, pin.value.length + (pin.value.length < 8 ? 1 : 0))))

function press(d: string) {
  if (props.disabled) return
  const max = props.len ?? 8
  if (pin.value.length >= max) return
  pin.value += d
  if (props.len && pin.value.length === props.len) submit()
}
function back() {
  pin.value = pin.value.slice(0, -1)
}
function submit() {
  const v = pin.value
  if (v.length < 4) return
  pin.value = ''
  emit('submit', v)
}
function clear() {
  pin.value = ''
}
defineExpose({ clear })

function onKey(e: KeyboardEvent) {
  if (/^\d$/.test(e.key)) press(e.key)
  else if (e.key === 'Backspace') back()
  else if (e.key === 'Enter' && !props.len) submit()
}
</script>

<template>
  <div class="pinpad" tabindex="0" @keydown="onKey">
    <div :key="shake" class="dots" :class="{ shake: !!shake }" aria-live="polite" :aria-label="`已输入 ${pin.length} 位`">
      <span v-for="i in slots" :key="i" class="dot" :class="{ on: i <= pin.length }" />
    </div>
    <div class="keys">
      <button v-for="d in ['1', '2', '3', '4', '5', '6', '7', '8', '9']" :key="d" class="key" :disabled="disabled" @click="press(d)">{{ d }}</button>
      <div class="key-slot"><slot name="extra" /></div>
      <button class="key" :disabled="disabled" @click="press('0')">0</button>
      <button v-if="!len && pin.length >= 4" class="key small ok" @click="submit">确定</button>
      <button v-else class="key small" aria-label="删除" :disabled="!pin.length" @click="back">⌫</button>
    </div>
  </div>
</template>

<style scoped>
.pinpad { outline: none; display: flex; flex-direction: column; align-items: center; gap: 36px; }
.dots { display: flex; gap: 18px; height: 22px; align-items: center; }
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1.5px solid var(--faint);
  transition: all 0.15s;
}
.dot.on {
  border-color: var(--m3);
  background: var(--m3);
  box-shadow: 0 0 10px 1px var(--m3);
  transform: scale(1.15);
}
.shake { animation: shake 0.35s; }
@keyframes shake {
  20%, 60% { transform: translateX(-8px); }
  40%, 80% { transform: translateX(8px); }
}
.keys { display: grid; grid-template-columns: repeat(3, 76px); gap: 14px 26px; }
.key, .key-slot { width: 76px; height: 76px; }
.key-slot { display: grid; place-items: center; }
.key {
  border-radius: 50%;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--surface) 70%, transparent);
  font-family: var(--num);
  font-size: 30px;
  font-weight: 500;
}
.key:active:not(:disabled) { background: var(--line); }
.key:disabled { opacity: 0.35; }
.key.small { font-family: var(--sans); font-size: 18px; border-color: transparent; background: transparent; }
.key.ok { color: var(--m5); font-weight: 700; }
</style>

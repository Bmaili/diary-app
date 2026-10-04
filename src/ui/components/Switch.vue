<script setup lang="ts">
defineProps<{ modelValue: boolean; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
</script>

<template>
  <button class="sw" role="switch" :aria-checked="modelValue" :aria-label="label" :disabled="disabled"
    :class="{ on: modelValue }" @click="emit('update:modelValue', !modelValue)">
    <span class="knob"></span>
  </button>
</template>

<style scoped>
.sw {
  position: relative;
  flex: none;
  width: 48px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 14px;
  background: var(--line);
  transition: background 0.18s;
}
.sw.on { background: var(--m5); }
.sw:disabled { opacity: 0.4; }
.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 0.18s;
}
.sw.on .knob { transform: translateX(20px); }
</style>

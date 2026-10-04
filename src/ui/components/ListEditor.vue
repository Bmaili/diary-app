<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from './Icon.vue'

const props = defineProps<{ modelValue: string[]; suggestions: string[]; placeholder: string; label: string }>()
const emit = defineEmits<{ 'update:modelValue': [string[]] }>()
const input = ref('')

const filtered = computed(() => {
  const q = input.value.trim()
  return props.suggestions
    .filter((s) => !props.modelValue.includes(s) && (!q || s.includes(q)))
    .slice(0, 16)
})

function add(v = input.value) {
  const parts = v.split(/[,，、\n]/).map((x) => x.replace(/^#/, '').trim()).filter(Boolean)
  if (!parts.length) return
  emit('update:modelValue', Array.from(new Set([...props.modelValue, ...parts])))
  input.value = ''
}
function remove(v: string) {
  emit('update:modelValue', props.modelValue.filter((x) => x !== v))
}
</script>

<template>
  <div class="le">
    <div class="selected">
      <span v-if="!modelValue.length" class="muted none">还没有{{ label }}</span>
      <button v-for="v in modelValue" :key="v" class="chip on" :aria-label="`移除 ${v}`" @click="remove(v)">
        {{ v }}<Icon name="close" class="x" />
      </button>
    </div>
    <form class="add" @submit.prevent="add()">
      <input v-model="input" class="field" :placeholder="placeholder" enterkeyhint="done" />
      <button class="text-btn" type="submit" :disabled="!input.trim()">添加</button>
    </form>
    <div v-if="filtered.length" class="sugs">
      <span class="muted small">用过的{{ label }}</span>
      <div class="chips">
        <button v-for="s in filtered" :key="s" class="chip" @click="add(s)">{{ s }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.le { display: flex; flex-direction: column; gap: 14px; }
.selected { display: flex; flex-wrap: wrap; gap: 8px; min-height: 32px; align-items: center; }
.none { font-size: 14px; }
.x { width: 14px; height: 14px; }
.add { display: flex; gap: 8px; }
.sugs .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.small { font-size: 13px; }
</style>

<script setup lang="ts">
/**
 * 天气：点开只是看和改，不会自动重新获取（避免把当时记下的天气覆盖掉）。
 * 当天可以按当前位置重新获取一次，结果先填进输入框，点“完成”才保存。往日只能手动填。
 */
import { ref, watch } from 'vue'
import Sheet from './Sheet.vue'
import Icon from './Icon.vue'
import type { Weather } from '../../core/types'

const props = defineProps<{ open: boolean; current?: Weather; canFetch: boolean; fetcher: () => Promise<Weather> }>()
const emit = defineEmits<{ close: []; save: [Weather | null] }>()

const text = ref('')
const temp = ref('')
const busy = ref(false)
const err = ref('')
/** 获取到的其他字段（例如图标代码）随新天气一起保存 */
let fetched: Weather | null = null

watch(
  () => props.open,
  (o) => {
    if (!o) return
    text.value = props.current?.text ?? ''
    temp.value = props.current?.temp_c != null ? String(props.current.temp_c) : ''
    err.value = ''
    fetched = null
  },
)

async function refetch() {
  if (busy.value) return
  busy.value = true
  err.value = ''
  try {
    const w = await props.fetcher()
    fetched = w
    text.value = w.text ?? ''
    temp.value = w.temp_c != null ? String(w.temp_c) : ''
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function done() {
  const t = text.value.trim()
  const n = temp.value.trim() === '' ? undefined : Number(temp.value)
  if (n != null && !Number.isFinite(n)) {
    err.value = '温度要填数字'
    return
  }
  if (!t && n == null) emit('save', null)
  else {
    const base: Weather = fetched ?? { ...(props.current ?? {}) }
    const w: Weather = { ...base, text: t || undefined, temp_c: n != null ? Math.round(n * 10) / 10 : undefined }
    if (!w.text) delete w.text
    if (w.temp_c == null) delete w.temp_c
    const same = props.current && props.current.text === w.text && props.current.temp_c === w.temp_c && !fetched
    if (!same) emit('save', w)
  }
  emit('close')
}
</script>

<template>
  <Sheet :open="open" title="天气" @close="done">
    <div class="w-form">
      <label>
        <span>天气</span>
        <input v-model="text" class="field" placeholder="比如 晴、多云、小雨" aria-label="天气" />
      </label>
      <label class="temp">
        <span>温度</span>
        <div class="unit">
          <input v-model="temp" class="field num" inputmode="decimal" placeholder="—" aria-label="温度" />
          <span>°C</span>
        </div>
      </label>
    </div>
    <button v-if="canFetch" class="chip add refetch" :disabled="busy" @click="refetch">
      <Icon name="weather" class="ci" />{{ busy ? '获取中' : '按现在的位置重新获取' }}
    </button>
    <p v-else class="hint">往日的天气只能手动填。</p>
    <p v-if="err" class="err">{{ err }}</p>
    <p class="hint">改完点“完成”保存。两项都清空就是不记天气。</p>
  </Sheet>
</template>

<style scoped>
.w-form { display: grid; grid-template-columns: 1fr 120px; gap: 10px; }
.w-form label > span { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
.unit { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.unit .field { font-size: 18px; text-align: center; padding: 0 6px; }
.refetch { margin-top: 14px; }
.ci { width: 16px; height: 16px; }
.hint { margin: 10px 0 0; font-size: 12px; color: var(--faint); }
.err { margin: 10px 0 0; font-size: 13px; color: var(--danger); }
</style>

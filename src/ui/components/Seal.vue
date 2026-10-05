<script setup lang="ts">
/** 朱砂方印：2 个字竖排，4 个字两列（从右往左读）。纯装饰。 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ text: string; size?: number }>(), { size: 40 })
/** 印章从右往左、从上往下读：四个字时右列是前两个字 */
const cols = computed(() => {
  const t = [...props.text]
  if (t.length <= 2) return [t]
  const half = Math.ceil(t.length / 2)
  return [t.slice(0, half), t.slice(half)]
})
</script>

<template>
  <span class="seal" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${size / (cols[0].length > 1 ? 2.35 : 1.6)}px` }" aria-hidden="true">
    <span v-for="(c, i) in cols" :key="i" class="col">
      <span v-for="(ch, j) in c" :key="j">{{ ch }}</span>
    </span>
  </span>
</template>

<style scoped>
.seal {
  display: inline-flex;
  flex-direction: row-reverse;
  align-items: center;
  justify-content: center;
  gap: 1px;
  flex: none;
  border-radius: 4px;
  background: var(--accent);
  color: var(--on-accent);
  font-family: var(--kai);
  font-weight: 700;
  line-height: 1.02;
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--on-accent) 70%, transparent), inset 0 0 0 3.5px var(--accent);
  transform: rotate(-3deg);
}
.col { display: flex; flex-direction: column; align-items: center; }
</style>

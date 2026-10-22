<script setup lang="ts">
/**
 * 心情颜色（2026-10-22 加入，规格 6.6）：选一套预设配色，或者点上面某一档、从传统色里单独挑。
 * 存的是浅色下的五个颜色（prefs.ui.moodColors）；深色下的颜色和字色由代码推出来。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { DEFAULT_LIGHT, PRESETS, SWATCHES, isDefault, presetOf, swatchName, tooClose, validColors } from '../../core/moodPalette'
import { MOOD_LABELS } from '../mood'
import Icon from '../components/Icon.vue'
import MoodFace from '../components/MoodFace.vue'

const router = useRouter()

const colors = computed<string[]>(() => (validColors(prefs.ui.moodColors) ? prefs.ui.moodColors : DEFAULT_LIGHT))
const preset = computed(() => presetOf(prefs.ui.moodColors))
/** 正在调的那一档（0–4） */
const slot = ref(4)

function choosePreset(c: string[]) {
  prefs.ui.moodColors = isDefault(c) ? [] : [...c]
}

function pick(hex: string) {
  const next = [...colors.value]
  next[slot.value] = hex
  prefs.ui.moodColors = isDefault(next) ? [] : next
}

const close = computed(() => tooClose(colors.value).map(([a, b]) => `“${MOOD_LABELS[a - 1]}”和“${MOOD_LABELS[b - 1]}”`))
const day = (i: number) => 8 + i
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>心情颜色</h1>
    </header>

    <section>
      <div class="preview" role="radiogroup" aria-label="选一档来换颜色">
        <button v-for="(c, i) in colors" :key="i" class="lv" :class="[`mood-${i + 1}`, { on: slot === i }]" role="radio"
          :aria-checked="slot === i" :aria-label="`${MOOD_LABELS[i]}，${swatchName(c) ?? '自定的颜色'}`" @click="slot = i">
          <MoodFace :value="i + 1" :size="40" />
          <span class="cell num">{{ day(i) }}</span>
          <span class="lbl">{{ MOOD_LABELS[i] }}</span>
          <span class="cn">{{ swatchName(c) ?? '　' }}</span>
        </button>
      </div>
      <div class="ramp" aria-hidden="true" />
      <p v-if="close.length" class="note warn">{{ close.join('，') }}颜色太像，日历上可能分不出来。</p>
    </section>

    <section>
      <h2>配色</h2>
      <button v-for="p in PRESETS" :key="p.id" class="item preset" :aria-pressed="preset?.id === p.id" @click="choosePreset(p.colors)">
        <div>
          <div class="pname">{{ p.name }}<span class="dots"><i v-for="c in p.colors" :key="c" :style="{ background: c }" /></span></div>
          <div class="desc">{{ p.desc }}</div>
        </div>
        <Icon v-if="preset?.id === p.id" name="check" class="ok-mark" />
      </button>
      <p v-if="!preset" class="desc pad">现在是你自己调过的颜色。</p>
    </section>

    <section>
      <h2>单独换“{{ MOOD_LABELS[slot] }}”的颜色</h2>
      <p class="desc pad">点上面的某一档，再从这里挑一个传统色。</p>
      <div class="swatches">
        <button v-for="s in SWATCHES" :key="s.hex" class="sw" :class="{ on: colors[slot].toLowerCase() === s.hex }"
          :aria-label="s.name" :aria-pressed="colors[slot].toLowerCase() === s.hex" @click="pick(s.hex)">
          <i :style="{ background: s.hex }" />
          <span>{{ s.name }}</span>
        </button>
      </div>
      <p class="desc pad">深色模式下会自动调亮一些；心情块上的字用深色还是浅色，也按颜色自动选。</p>
      <button v-if="!isDefault(prefs.ui.moodColors)" class="text-btn reset" @click="prefs.ui.moodColors = []">恢复默认（青黛）</button>
    </section>
  </div>
</template>

<style scoped>
.preview { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; padding: 4px 12px 0; }
.lv {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 10px 2px 8px;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  color: var(--ink);
}
.lv.on { border-color: var(--line); background: var(--surface); }
.cell {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--mc);
  color: var(--onm);
  font-size: 14px;
  font-weight: 600;
}
.lbl { font-size: 13px; }
.cn { font-size: 12px; color: var(--muted); font-family: var(--kai); }
.lv.on .lbl { font-weight: 700; }
.ramp {
  height: 8px;
  margin: 10px 20px 6px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--m1), var(--m2), var(--m3), var(--m4), var(--m5));
}
.preset .pname { display: flex; align-items: center; gap: 10px; }
.dots { display: inline-flex; gap: 3px; }
.dots i { width: 12px; height: 12px; border-radius: 50%; }
.ok-mark { width: 22px; height: 22px; color: var(--ok); flex: none; }
.swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(58px, 1fr)); gap: 6px; padding: 10px 14px; }
.sw {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-height: 58px;
  padding: 6px 0;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
}
.sw i { width: 30px; height: 30px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08); }
.sw.on { color: var(--ink); font-weight: 700; }
.sw.on i { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--ink); }
.reset { margin: 6px 12px 0; }
</style>

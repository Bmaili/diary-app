<script setup lang="ts">
/** 年度日记本（规格 5.17）：选年份和范围，排成一本，交给系统打印存成 PDF */
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import { buildYearbookHtml, estimateYearbook, printYearbook, yearbookDates, yearbookYears } from '../../yearbookService'
import { cnYear } from '../../core/yearbook'
import { indexVersion } from '../../app'

const router = useRouter()
const years = computed(() => {
  void indexVersion.value
  return yearbookYears()
})
const o = reactive({ year: years.value[0] ?? String(new Date().getFullYear()), starredOnly: false, photos: true, summaries: true })
const counts = computed(() => {
  void indexVersion.value
  return { all: yearbookDates(o.year, false).length, starred: yearbookDates(o.year, true).length }
})
const count = computed(() => (o.starredOnly ? counts.value.starred : counts.value.all))

const pages = ref<number | null>(null)
let seq = 0
watch(
  () => [o.year, o.starredOnly, o.photos, o.summaries, indexVersion.value],
  async () => {
    const my = ++seq
    pages.value = null
    const n = await estimateYearbook({ ...o }).catch(() => null)
    if (my === seq) pages.value = n
  },
  { immediate: true },
)

const busy = ref('')
const error = ref('')

async function make() {
  if (busy.value || !count.value) return
  error.value = ''
  busy.value = '正在排版…'
  try {
    const { html } = await buildYearbookHtml({ ...o }, (d, t) => (busy.value = `正在排版 ${d} / ${t}`))
    busy.value = '正在打开打印界面…'
    await printYearbook(html, o.year)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}
</script>

<template>
  <div class="settings yearbook">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>年度日记本</h1>
    </header>

    <template v-if="years.length">
      <div class="years" role="radiogroup" aria-label="年份">
        <button v-for="y in years" :key="y" class="yr" role="radio" :aria-checked="o.year === y" :class="{ on: o.year === y }"
          @click="o.year = y">{{ y }}</button>
      </div>

      <div class="preview" aria-hidden="true">
        <div class="book">
          <span class="bt">浮生记</span>
          <span class="by">{{ cnYear(o.year) }}</span>
          <span class="bs">记</span>
        </div>
        <div class="spread">
          <div class="pg">
            <div class="pd">九月八日</div>
            <i class="ln"></i><i class="ln"></i><i class="ln short"></i>
            <div v-if="o.photos" class="ph"></div>
            <i v-else class="ln"></i>
          </div>
          <div class="pg">
            <div class="pd">九月十日</div>
            <i class="ln"></i><i class="ln"></i><i class="ln"></i><i class="ln"></i><i class="ln shorter"></i>
            <p class="pz">朱批一句</p>
          </div>
        </div>
      </div>
      <p class="yb-note">每月一页心情日历{{ o.summaries ? '和月度总结' : '' }}，后面是这个月的日记；请批过的日子带着朱批。</p>

      <section>
        <div class="item">
          <div>范围</div>
          <div class="range">
            <button class="chip" :class="{ on: !o.starredOnly }" :aria-pressed="!o.starredOnly" @click="o.starredOnly = false">全年 <span class="num">{{ counts.all }}</span> 篇</button>
            <button class="chip" :class="{ on: o.starredOnly }" :aria-pressed="o.starredOnly" :disabled="!counts.starred" @click="o.starredOnly = true">只要珍藏</button>
          </div>
        </div>
        <div class="item">
          <div>放进照片</div>
          <Switch v-model="o.photos" label="放进照片" />
        </div>
        <div class="item">
          <div>
            <div>放进 AI 写的总结</div>
            <div class="desc">有就放，没有就跳过。</div>
          </div>
          <Switch v-model="o.summaries" label="放进 AI 写的总结" />
        </div>
      </section>

      <div class="go">
        <p class="hint">
          <template v-if="o.starredOnly && !counts.starred">这一年还没有珍藏的日子。</template>
          <template v-else>
            <template v-if="pages != null">约 <span class="num">{{ pages }}</span> 页。</template>
            会打开系统的打印界面：选“另存为 PDF”保存，或者直接连打印机。<template v-if="o.photos">照片多的话排版要等一会儿。</template>
          </template>
        </p>
        <button class="solid-btn wide" :disabled="!!busy || !count" @click="make">{{ busy || '排版并打印 / 存为 PDF' }}</button>
        <p v-if="error" class="result bad">{{ error }}</p>
      </div>
    </template>
    <p v-else class="note">还没有日记。写上一阵子，再来排一本。</p>
  </div>
</template>

<style scoped>
.years { display: flex; gap: 8px; overflow-x: auto; padding: 6px 16px 2px; scrollbar-width: none; }
.years::-webkit-scrollbar { display: none; }
.yr {
  flex: none;
  height: 36px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 18px;
  background: var(--surface);
  color: var(--ink);
  font-family: var(--num);
  font-size: 15px;
}
.yr.on { background: var(--ink); border-color: var(--ink); color: var(--bg); }
.preview { display: flex; align-items: flex-end; gap: 12px; margin: 18px 16px 0; }
.book {
  position: relative;
  flex: none;
  width: 118px;
  height: 166px;
  border: 1px solid var(--line);
  background: color-mix(in srgb, var(--m5) 12%, var(--surface));
  box-shadow: 2px 3px 0 var(--line);
  font-family: var(--kai);
}
.bt { position: absolute; right: 18px; top: 20px; writing-mode: vertical-rl; font-size: 20px; letter-spacing: 4px; }
.by { position: absolute; right: 48px; top: 24px; writing-mode: vertical-rl; font-size: 12px; letter-spacing: 2px; color: var(--muted); }
.bs {
  position: absolute;
  left: 14px;
  bottom: 16px;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  transform: rotate(-3deg);
}
.spread { flex: 1; min-width: 0; height: 150px; display: flex; border: 1px solid var(--line); background: var(--surface); }
.pg { flex: 1; min-width: 0; padding: 12px 10px; }
.pg + .pg { border-left: 1px solid var(--line); }
.pd { font-family: var(--kai); font-size: 11px; font-weight: 700; }
.ln { display: block; height: 5px; margin-top: 7px; border-radius: 2px; background: var(--line); }
.ln.short { width: 70%; }
.ln.shorter { width: 55%; }
.ph { height: 46px; margin-top: 9px; border-radius: 2px; background: color-mix(in srgb, var(--m2) 45%, var(--line)); }
.pz { margin: 8px 0 0; font-family: var(--kai); font-size: 10px; color: var(--accent); }
.range { display: flex; gap: 6px; }
.chip {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 15px;
  background: none;
  color: var(--ink);
  font-size: 13px;
}
.chip.on { background: var(--ink); border-color: var(--ink); color: var(--bg); }
.chip:disabled { opacity: 0.45; }
.yb-note { margin: 12px 20px 0; font-size: 13px; line-height: 1.6; color: var(--muted); }
.go { padding: 8px 16px calc(28px + var(--safe-bottom)); }
.hint { margin: 0 4px 10px; font-size: 13px; line-height: 1.6; color: var(--muted); text-align: center; }
.wide { width: 100%; }
.result.bad { color: var(--danger); font-size: 13px; text-align: center; }
</style>

<script setup lang="ts">
/**
 * 小传（规格 7.7）：一个人、一个地方或一个标签在日记里的样子。数字都由 app 从标注里算，
 * 只有点了“请 AI 写几句”才把提到它的日记发给模型；写好的存在本机，下次直接看。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { index, indexVersion, today } from '../../app'
import { prefs } from '../../prefs'
import { ago, buildBio, companion, sealText } from '../../core/bio'
import { cnDay } from '../../core/answer'
import { MOOD_LABELS } from '../mood'
import type { ListField } from '../../core/types'
import {
  deletePortrait, ensureConsent, loadPortraits, portraitKey, portraits, profileFor, requestPortrait,
} from '../../aiService'
import { ask } from '../dialog'

const route = useRoute()
const router = useRouter()
const field = computed(() => route.params.field as ListField)
const value = computed(() => String(route.params.value ?? ''))
const FIELD_ICON: Record<ListField, string> = { people: 'person', places: 'pin', tags: 'hash' }

const bio = computed(() => {
  void indexVersion.value
  return buildBio(index.all(), field.value, value.value)
})
const aiDays = computed(() => {
  void indexVersion.value
  return buildBio(index.aiRows(), field.value, value.value).days.length
})
const t = computed(() => today())
const year = ref('')
watch(bio, (b) => {
  if (!b.years.includes(year.value)) year.value = b.years[0] ?? t.value.slice(0, 4)
}, { immediate: true })
const months = computed(() => bio.value.months(year.value))
const maxMonth = computed(() => Math.max(1, ...months.value))
const comp = computed(() => companion(bio.value))
const seal = computed(() => sealText(field.value, value.value))
const moodTotal = computed(() => bio.value.moods.slice(1).reduce((a, b) => a + b, 0))
const moodAria = computed(() => bio.value.moods.slice(1).map((n, i) => `${MOOD_LABELS[i]} ${n} 天`).join('，'))
const barsAria = computed(() => `${year.value} 年每月：${months.value.map((n, i) => `${i + 1} 月 ${n} 天`).join('，')}`)
const unextracted = computed(() => {
  void indexVersion.value
  return index.needsExtraction().length
})
const dot = (d?: string) => d?.replace(/-/g, '.') ?? ''

/** 时间线：按月分组，先显示 40 天 */
const limit = ref(40)
const timeline = computed(() => {
  const y = t.value.slice(0, 4)
  const groups: { label: string; days: { date: string; day: string; mood?: number; preview: string }[] }[] = []
  for (const d of bio.value.days.slice(0, limit.value)) {
    const label = `${d.date.slice(0, 4) === y ? '' : `${d.date.slice(0, 4)} 年 `}${Number(d.date.slice(5, 7))} 月`
    const g = groups[groups.length - 1]
    const item = { date: d.date, day: cnDay(d.date, y).replace(/^.*?月/, ''), ...(d.mood ? { mood: d.mood } : {}), preview: d.preview }
    if (g?.label === label) g.days.push(item)
    else groups.push({ label, days: [item] })
  }
  return groups
})

// ---------- AI 写的几句 ----------

onMounted(() => void loadPortraits())
const hasProfile = computed(() => prefs.ai.profiles.length > 0)
const portrait = computed(() => portraits.map[portraitKey(field.value, value.value)])
const busy = ref(false)
const err = ref('')
const who = computed(() => (field.value === 'tags' ? `“${value.value}”` : value.value))
async function write() {
  if (busy.value) return
  err.value = ''
  if (!(await ensureConsent('summary'))) return
  busy.value = true
  try {
    await requestPortrait(field.value, value.value)
  } catch (e) {
    err.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function remove() {
  if (!(await ask({ title: '删去这几句？', message: 'AI 写的，随时可以再请它写。', ok: '删去', danger: true }))) return
  await deletePortrait(field.value, value.value)
}
const writtenAt = (at: number) => {
  const d = new Date(at)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}
</script>

<template>
  <div class="settings who">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>{{ value }}</h1>
    </header>

    <p v-if="!bio.days.length" class="note">日记的标注里还没有{{ who }}。做过 AI 标注、或者在编辑页手动填上以后，这里就有了。</p>

    <template v-else>
      <div class="hero">
        <span class="seal" :class="`n${[...seal].length}`" aria-hidden="true">{{ seal }}</span>
        <div class="hero-t">
          <div>第一次写到：<span class="num">{{ dot(bio.first) }}</span></div>
          <div>最近一次：<span class="num">{{ dot(bio.last) }}</span>，{{ ago(bio.last!, t) }}</div>
        </div>
      </div>

      <div class="facts">
        <div><b class="num">{{ bio.inYear(year) }}</b><small>{{ year === t.slice(0, 4) ? '今年' : `${year} 年` }}写到的天数</small></div>
        <div><b class="num">{{ bio.days.length }}</b><small>一共</small></div>
        <div v-if="comp"><b class="c">{{ comp.value }}</b><small>{{ comp.label }}</small></div>
        <div v-else><b class="num">{{ bio.years.length }}</b><small>出现过几年</small></div>
      </div>

      <h2 class="sec">
        <span>{{ year === t.slice(0, 4) ? '今年' : `${year} 年` }}每月</span>
        <span v-if="bio.years.length > 1" class="yrs">
          <button v-for="y in bio.years" :key="y" class="yr num" :class="{ on: y === year }" :aria-pressed="y === year" @click="year = y">{{ y }}</button>
        </span>
      </h2>
      <div class="bars" role="img" :aria-label="barsAria">
        <div v-for="(n, i) in months" :key="i"><i :class="{ z: !n }" :style="{ height: n ? `${6 + (n / maxMonth) * 46}px` : '2px' }"></i><small class="num">{{ i + 1 }}</small></div>
      </div>

      <template v-if="moodTotal">
        <h2 class="sec"><span>写到{{ who }}的日子，心情</span></h2>
        <div class="mix" role="img" :aria-label="moodAria">
          <template v-for="m in [5, 4, 3, 2, 1]" :key="m"><i v-if="bio.moods[m]" :class="`mood-${m}`" :style="{ flex: bio.moods[m] }"></i></template>
        </div>
        <div class="mixl">
          <template v-for="m in [5, 4, 3, 2, 1]" :key="m"><span v-if="bio.moods[m]"><i :class="`mood-${m}`"></i>{{ MOOD_LABELS[m - 1] }} <span class="num">{{ bio.moods[m] }}</span></span></template>
        </div>
      </template>

      <template v-if="bio.together.length">
        <h2 class="sec"><span>常一起出现</span></h2>
        <div class="with">
          <router-link v-for="x in bio.together" :key="x.field + x.value" :to="`/who/${x.field}/${encodeURIComponent(x.value)}`" replace class="chip">
            <Icon :name="FIELD_ICON[x.field]" class="wi" />{{ x.value }}<small class="num">{{ x.count }}</small>
          </router-link>
        </div>
      </template>

      <template v-if="hasProfile">
        <div v-if="portrait" class="portrait">
          <p>{{ portrait.text }}</p>
          <div class="pm">
            <span>{{ portrait.model }} 写于 {{ writtenAt(portrait.at) }}<template v-if="aiDays > portrait.total">，之后又写到 <span class="num">{{ aiDays - portrait.total }}</span> 天</template></span>
            <span class="pa">
              <button class="lk" :disabled="busy" @click="write">{{ busy ? '正在写' : '换一句' }}</button>
              <button class="lk" :disabled="busy" @click="remove">删去</button>
            </span>
          </div>
        </div>
        <button v-else class="ask" :disabled="busy || !aiDays" @click="write">
          <Icon name="sparkle" />
          <span>
            {{ busy ? `正在读 ${aiDays} 篇日记……` : `请 AI 写几句“你和${who}的这些日子”` }}
            <small v-if="!busy">{{ aiDays ? `会把提到${who}的 ${aiDays} 篇日记发给 ${profileFor('summary')?.name}` : '提到它的日记都设了不让 AI 读' }}</small>
          </span>
        </button>
        <p v-if="err" class="result bad pad">{{ err }}</p>
      </template>

      <h2 class="sec"><span>时间线</span><span class="faint num">{{ bio.days.length }} 天</span></h2>
      <div class="tl">
        <template v-for="g in timeline" :key="g.label">
          <p class="m">{{ g.label }}</p>
          <router-link v-for="d in g.days" :key="d.date" :to="`/entry/${d.date}`" class="e">
            <i class="md" :class="d.mood ? `mood-${d.mood}` : 'mood-0'"></i>
            <b>{{ d.day }}</b>
            <span>{{ d.preview || '（只记了心情）' }}</span>
          </router-link>
        </template>
      </div>
      <button v-if="bio.days.length > limit" class="text-btn more" @click="limit += 60">再显示 {{ Math.min(60, bio.days.length - limit) }} 天</button>
      <p v-if="unextracted" class="desc pad foot">还有 <span class="num">{{ unextracted }}</span> 篇没做过 AI 标注，这里只按标注过的统计，可能少算。</p>
    </template>
  </div>
</template>

<style scoped>
.who { padding-bottom: calc(40px + var(--safe-bottom)); }
.who .note { margin-top: 12px; }
.hero { display: flex; align-items: center; gap: 16px; margin: 4px 20px 14px; }
.seal {
  flex: none;
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 6px;
  background: var(--accent);
  color: var(--on-accent);
  font-family: var(--kai);
  font-size: 26px;
  line-height: 1.05;
  transform: rotate(-3deg);
  writing-mode: vertical-rl;
  text-align: center;
}
.seal.n1 { font-size: 34px; writing-mode: horizontal-tb; }
.seal.n2 { writing-mode: horizontal-tb; font-size: 25px; letter-spacing: 1px; }
.seal.n3, .seal.n4 { font-size: 22px; line-height: 1.2; letter-spacing: 0; }
.hero-t { font-size: 14px; line-height: 1.8; color: var(--muted); }
.facts { display: grid; grid-template-columns: repeat(3, 1fr); margin: 0 20px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.facts div { min-width: 0; padding: 10px 4px; text-align: center; }
.facts div + div { border-left: 1px solid var(--line); }
.facts b { display: block; font-size: 22px; font-weight: 600; line-height: 1.35; }
.facts b.c { font-size: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.facts small { font-size: 12px; color: var(--muted); }
.sec { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 18px 20px 8px; font-size: 13px; font-weight: 400; color: var(--muted); }
.yrs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
.yr { min-height: 28px; padding: 0 10px; border: 1px solid var(--line); border-radius: 14px; background: none; color: var(--muted); font-size: 13px; }
.yr.on { background: var(--ink); border-color: var(--ink); color: var(--bg); }
.bars { display: grid; grid-template-columns: repeat(12, 1fr); gap: 6px; align-items: end; height: 70px; margin: 0 20px; }
.bars div { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
.bars i { width: 100%; max-width: 16px; border-radius: 3px 3px 1px 1px; background: var(--ink); opacity: 0.78; }
.bars i.z { background: var(--line); opacity: 1; }
.bars small { margin-top: 3px; font-size: 10px; color: var(--faint); }
.mix { display: flex; gap: 2px; height: 10px; margin: 0 20px; border-radius: 5px; overflow: hidden; }
.mix i { background: var(--mc); }
.mixl { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 6px 20px 0; font-size: 12px; color: var(--muted); }
.mixl i { display: inline-block; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; background: var(--mc); vertical-align: 1px; }
.with { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 20px; }
.with .chip { display: inline-flex; align-items: center; gap: 4px; min-height: 32px; padding: 3px 12px; color: var(--ink); text-decoration: none; font-size: 14px; }
.with small { font-size: 12px; color: var(--faint); }
.wi { width: 14px; height: 14px; color: var(--faint); }
.ask { display: flex; align-items: center; gap: 10px; width: calc(100% - 40px); margin: 18px 20px 0; padding: 12px 14px; border: 1px dashed var(--faint); border-radius: 14px; background: none; color: var(--ink); text-align: left; font-size: 14.5px; line-height: 1.5; }
.ask svg { flex: none; width: 20px; height: 20px; color: var(--accent); }
.ask small { display: block; font-size: 12px; color: var(--faint); }
.ask:disabled { opacity: 0.7; }
.portrait { margin: 18px 20px 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.portrait p { margin: 0; font-family: var(--kai); font-size: 16px; line-height: 1.85; }
.pm { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 10px; margin-top: 6px; font-size: 12px; color: var(--faint); }
.pa { display: flex; gap: 12px; }
.lk { padding: 0; border: 0; background: none; color: var(--muted); font-size: 12.5px; }
.faint { color: var(--faint); }
.tl { margin: 2px 20px 0 26px; padding-left: 16px; border-left: 1px solid var(--line); }
.tl .m { position: relative; margin: 6px 0 2px; font-size: 13px; color: var(--muted); }
.tl .m::before { content: ''; position: absolute; left: -21px; top: 6px; width: 9px; height: 9px; border-radius: 50%; background: radial-gradient(circle, var(--ink) 35%, transparent 72%); }
.tl .e { display: flex; align-items: baseline; gap: 6px; padding: 6px 0; color: inherit; text-decoration: none; font-size: 14px; line-height: 1.6; }
.tl .e .md { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--mc); transform: translateY(-1px); }
.tl .e b { flex: none; font-family: var(--kai); font-weight: 400; }
.tl .e span { min-width: 0; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.more { display: block; margin: 8px auto 0; }
.foot { margin-top: 16px; }
</style>

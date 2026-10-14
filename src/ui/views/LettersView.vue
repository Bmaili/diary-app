<script setup lang="ts">
/** 寄往来日：信匣（规格 5.13）。封着的信只显示日期，到了的可以拆，拆过的随时重读 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { today } from '../../app'
import { daysUntil, letterState, letterText, quickDates, type Letter } from '../../core/letters'
import { addDays, parseYmd } from '../../core/time'
import { changeOpenDate, letters, reloadLetters, trashLetterById } from '../../lettersService'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import { ask } from '../dialog'

const router = useRouter()
onMounted(() => void reloadLetters())

const t = computed(() => today())
const groups = computed(() => {
  const by = { arrived: [] as Letter[], sealed: [] as Letter[], opened: [] as Letter[] }
  for (const l of letters.list) by[letterState(l, t.value)].push(l)
  by.opened.sort((a, b) => ((b.meta.opened ?? '') < (a.meta.opened ?? '') ? -1 : 1))
  return by
})

const dot = (d: string) => {
  const x = parseYmd(d)
  return `${x.getFullYear()}.${x.getMonth() + 1}.${x.getDate()}`
}
/** 拆信日是节日一类的，标一下 */
const dayName = (d: string) => (d.slice(5) === '01-01' ? '元日' : '')
const firstLine = (l: Letter) => letterText(l.body).split('\n').map((s) => s.trim()).find(Boolean)?.replace(/^#+\s*/, '') ?? (letterText(l.body) ? '（空白的信）' : '（一封只有照片的信）')

// ---------- 封着的信：改日期、撤回 ----------

const editing = ref<Letter | null>(null)
const newDate = ref('')
const err = ref('')
const tomorrow = computed(() => addDays(t.value, 1))
function edit(l: Letter) {
  editing.value = l
  newDate.value = l.meta.open_on
  err.value = ''
}
async function saveDate() {
  const l = editing.value
  if (!l) return
  if (!newDate.value || newDate.value <= t.value) {
    err.value = '要选明天以后的日子'
    return
  }
  try {
    if (newDate.value !== l.meta.open_on) await changeOpenDate(l.id, newDate.value)
    editing.value = null
  } catch (e) {
    err.value = (e as Error).message
  }
}
async function withdraw() {
  const l = editing.value
  if (!l) return
  const ok = await ask({
    title: '撤回这封信？',
    message: '信会移到“设置 → 最近删除”，保留 30 天，在那里可以恢复。撤回时不会给你看内容。',
    ok: '撤回', danger: true,
  })
  if (!ok) return
  await trashLetterById(l.id)
  editing.value = null
}
</script>

<template>
  <div class="letters-page">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>寄往来日</h1>
      <router-link to="/letters/new" class="write-btn"><Icon name="plus" />写一封</router-link>
    </header>
    <p class="intro">尺素一封，寄与来日。</p>

    <div v-if="letters.loaded && !letters.list.length" class="empty">
      <svg class="env-art" viewBox="0 0 140 96" aria-hidden="true">
        <rect x="2" y="2" width="136" height="92" rx="4" />
        <path d="M2 4 L70 52 L138 4" />
      </svg>
      <p>匣中尚无来信。</p>
      <p class="muted">生日、新年，或只是一年后的今天——写几句给那时的自己。</p>
      <router-link to="/letters/new" class="solid-btn link-btn">写一封信</router-link>
    </div>

    <section v-if="groups.arrived.length">
      <h2 class="sec">到了</h2>
      <router-link v-for="l in groups.arrived" :key="l.id" :to="`/letters/${l.id}`" class="env arrived" :aria-label="`一封写于 ${dot(l.id.slice(0, 10))} 的信到了，点开拆`">
        <svg class="flap" viewBox="0 0 358 70" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0 L179 62 L358 0" /></svg>
        <span class="seal">启</span>
        <span class="env-foot">
          <span class="when">今天可以拆了</span>
          <span class="sub">写于 <span class="num">{{ dot(l.id.slice(0, 10)) }}</span></span>
        </span>
      </router-link>
    </section>

    <section v-if="groups.sealed.length">
      <h2 class="sec">未到</h2>
      <button v-for="l in groups.sealed" :key="l.id" class="env" :aria-label="`一封 ${dot(l.meta.open_on)} 才能拆的信，点一下改日期或撤回`" @click="edit(l)">
        <svg class="flap" viewBox="0 0 358 70" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0 L179 62 L358 0" /></svg>
        <span class="seal">封</span>
        <span class="env-foot">
          <span class="when"><span class="num">{{ dot(l.meta.open_on) }}</span> {{ dayName(l.meta.open_on) }}</span>
          <span class="sub">还有 <span class="num">{{ daysUntil(t, l.meta.open_on) }}</span> 天 · 写于 <span class="num">{{ dot(l.id.slice(0, 10)) }}</span></span>
        </span>
      </button>
    </section>

    <section v-if="groups.opened.length">
      <h2 class="sec">已拆开</h2>
      <router-link v-for="l in groups.opened" :key="l.id" :to="`/letters/${l.id}`" class="opened-row">
        <span class="line">{{ firstLine(l) }}</span>
        <span class="num small">{{ dot(l.meta.open_on) }}</span>
      </router-link>
    </section>

    <p v-if="letters.list.length" class="foot-note">云中谁寄锦书来——是从前的你。</p>

    <Sheet :open="!!editing" title="这封信" @close="editing = null">
      <template v-if="editing">
        <p class="sheet-desc">还有 <span class="num">{{ daysUntil(t, editing.meta.open_on) }}</span> 天才能拆。可以换一个拆信的日子。</p>
        <div class="chips">
          <button v-for="q in quickDates(t)" :key="q.label" class="chip" :class="{ on: newDate === q.date }" @click="newDate = q.date">{{ q.label }}</button>
        </div>
        <label class="date-row"><span>拆信日期</span><input v-model="newDate" type="date" class="field" :min="tomorrow" /></label>
        <p v-if="err" class="result bad">{{ err }}</p>
        <button class="solid-btn wide" @click="saveDate">保存日期</button>
        <button class="text-btn danger wide" @click="withdraw">撤回这封信</button>
      </template>
    </Sheet>
  </div>
</template>

<style scoped>
.letters-page { padding-bottom: calc(var(--safe-bottom) + 28px); }
.write-btn { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; margin-right: 12px; min-height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 18px; background: var(--surface); color: var(--ink); font-size: 14px; text-decoration: none; }
.write-btn svg { width: 16px; height: 16px; }
.intro { margin: 2px 20px 18px; font-family: var(--kai); font-size: 16px; color: var(--muted); }
.sec { margin: 6px 20px 10px; font-size: 14px; font-weight: 400; color: var(--muted); }
.env {
  position: relative;
  display: block;
  width: calc(100% - 32px);
  height: 132px;
  margin: 0 16px 14px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 6px;
  background-color: var(--surface);
  background-image: var(--paper, none);
  color: inherit;
  font: inherit;
  text-align: left;
  text-decoration: none;
  overflow: hidden;
}
.env:active { opacity: 0.7; }
.flap { position: absolute; left: 0; top: 0; width: 100%; height: 70px; }
.flap path { fill: none; stroke: var(--line); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.seal { position: absolute; left: 50%; top: 44px; display: grid; place-items: center; width: 38px; height: 38px; margin-left: -19px; border-radius: 4px; background: var(--accent); color: var(--on-accent); font-family: var(--kai); font-size: 18px; }
.env.arrived { border-color: var(--accent); }
.env-foot { position: absolute; left: 16px; right: 16px; bottom: 12px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.when { font-size: 15px; }
.sub { font-size: 13px; color: var(--muted); white-space: nowrap; }
.opened-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 13px 20px; border-top: 1px solid var(--line); color: inherit; text-decoration: none; }
.opened-row:last-child { border-bottom: 1px solid var(--line); }
.opened-row .line { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opened-row .small { flex: none; font-size: 13px; color: var(--muted); }
.foot-note { margin: 22px 24px 0; font-family: var(--kai); font-size: 14px; line-height: 1.6; color: var(--muted); text-align: center; }
.empty { display: flex; flex-direction: column; align-items: center; padding: 30px 32px; text-align: center; }
.empty p { margin: 4px 0; }
.empty p:first-of-type { margin-top: 18px; font-weight: 700; }
.empty .link-btn { margin-top: 18px; display: inline-flex; align-items: center; text-decoration: none; }
.env-art { width: 140px; height: 96px; }
.env-art rect { fill: var(--surface); stroke: var(--faint); }
.env-art path { fill: none; stroke: var(--faint); }
.sheet-desc { margin: 4px 0 12px; color: var(--muted); line-height: 1.6; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.date-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 14px 0; }
.date-row .field { max-width: 60%; }
.wide { width: 100%; margin-top: 8px; }
.danger { color: var(--danger); }
</style>

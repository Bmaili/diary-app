<script setup lang="ts">
/** 写一封信（规格 5.13）：写到一半离开也不丢（草稿存在这台手机上），封存后到期前看不到 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { today } from '../../app'
import { quickDates } from '../../core/letters'
import { addDays } from '../../core/time'
import { sealLetter } from '../../lettersService'
import { prefs } from '../../prefs'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'

const router = useRouter()
const d = prefs.letterDraft
const t = today()
const quick = quickDates(t)
const tomorrow = addDays(t, 1)
const custom = ref(false)
const busy = ref(false)
const err = ref('')

onMounted(() => {
  // 默认一年后；草稿里的日期已经过了的话也换回一年后
  if (!d.openOn || d.openOn <= t) d.openOn = quick[0].date
  custom.value = !quick.some((q) => q.date === d.openOn)
})

const canSeal = computed(() => d.body.trim().length > 0 && d.openOn > t)

function pickQuick(date: string) {
  d.openOn = date
  custom.value = false
}

async function seal() {
  if (!canSeal.value || busy.value) return
  busy.value = true
  err.value = ''
  try {
    await sealLetter({ body: d.body, openOn: d.openOn, remind: d.remind })
    d.body = ''
    d.openOn = ''
    d.remind = true
    router.replace('/letters')
  } catch (e) {
    err.value = `没有封存成功：${(e as Error).message}`
  } finally {
    busy.value = false
  }
}

function goBack() {
  if (window.history.state?.back) router.back()
  else router.replace('/letters')
}
</script>

<template>
  <div class="write-letter">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="goBack"><Icon name="back" /></button>
      <h1>写一封信</h1>
      <button class="seal-btn" :disabled="!canSeal || busy" @click="seal">{{ busy ? '封存中' : '封存' }}</button>
    </header>

    <label class="paper-wrap">
      <span class="sr">信的内容</span>
      <textarea v-model="d.body" class="letter-input" placeholder="一年后的我：&#10;&#10;现在的你在想什么、担心什么、盼着什么？写下来，到那天再读。" />
    </label>
    <p class="draft-note">写到一半离开也没关系，回来还在。</p>

    <h2 class="sec">哪天拆开</h2>
    <div class="chips">
      <button v-for="q in quick" :key="q.label" class="chip when" :class="{ on: !custom && d.openOn === q.date }" :aria-pressed="!custom && d.openOn === q.date" @click="pickQuick(q.date)">
        {{ q.label }}<span class="num">{{ q.date.replace(/-0?/g, '.') }}</span>
      </button>
      <button class="chip when" :class="{ on: custom }" :aria-pressed="custom" @click="custom = true">选个日子</button>
    </div>
    <label v-if="custom" class="date-row"><span>拆信日期</span><input v-model="d.openOn" type="date" class="field" :min="tomorrow" /></label>

    <div class="remind">
      <div>
        <div>到那天提醒我</div>
        <div class="desc">早上 9 点发一条通知，只说“有一封信到了”，不露内容</div>
      </div>
      <Switch v-model="d.remind" label="到那天提醒我" />
    </div>

    <p v-if="err" class="result bad pad">{{ err }}</p>
    <p class="foot-note">封存后到那天之前看不到内容，但可以改日期或者撤回。</p>
  </div>
</template>

<style scoped>
.write-letter { padding-bottom: calc(var(--safe-bottom) + 28px); }
.seal-btn { margin-left: auto; margin-right: 12px; min-height: 38px; padding: 0 18px; border: 0; border-radius: 19px; background: var(--accent); color: var(--on-accent); font: inherit; font-size: 15px; font-weight: 700; }
.seal-btn:disabled { opacity: 0.45; }
.paper-wrap { display: block; margin: 6px 16px 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.letter-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 46vh;
  padding: 16px 18px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background-color: var(--surface);
  background-image: repeating-linear-gradient(transparent 0 33px, var(--line) 33px 34px);
  background-position: 0 14px;
  background-attachment: local;
  color: var(--ink);
  font: inherit;
  font-size: 17px;
  line-height: 34px;
  resize: none;
}
.letter-input::placeholder { color: var(--faint); }
.draft-note { margin: 6px 20px 0; font-size: 12px; color: var(--faint); }
.sec { margin: 18px 20px 10px; font-size: 14px; font-weight: 400; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 16px; }
.chip.when { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; min-height: 44px; line-height: 1.2; }
.chip.when .num { font-size: 12px; opacity: 0.75; }
.date-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 12px 20px 0; }
.date-row .field { max-width: 60%; }
.remind { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 18px 16px 0; padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.remind .desc { margin-top: 2px; font-size: 13px; color: var(--muted); line-height: 1.5; }
.foot-note { margin: 16px 24px 0; font-size: 13px; line-height: 1.6; color: var(--muted); text-align: center; }
</style>

<script setup lang="ts">
/**
 * 每日清单（2026-10-26 加入，SPEC 5.2）：列好每天照例要做的事，今天第一次打开日记时预填成待办。
 * 每一项可以选每天、工作日、休息日，或者指定星期几（每周的事就是这样设的）。
 * 清单存在 prefs.write.checklist；日记里只是普通的待办，文件格式不变。
 */
import { computed, nextTick, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { today } from '../../app'
import { WEEK_ORDER, isWorkday, itemsFor, oneLine, weekName, whenLabel, type ChecklistItem, type ChecklistWhen } from '../../core/checklist'
import { holidayOn } from '../../core/holidays'
import { holidayVersion } from '../../holidayService'
import { weekday } from '../../core/time'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'

const router = useRouter()
const items = computed(() => prefs.write.checklist)

/** 正在改的那一项：index 为 -1 是新添的 */
const editing = ref<number | null>(null)
const draft = reactive<{ text: string; when: ChecklistWhen; weekdays: number[] }>({ text: '', when: 'daily', weekdays: [] })
const input = ref<HTMLInputElement | null>(null)

function openItem(i: number) {
  const it = i >= 0 ? items.value[i] : null
  draft.text = it?.text ?? ''
  draft.when = it?.when ?? 'daily'
  draft.weekdays = [...(it?.weekdays ?? [])]
  editing.value = i
  if (i < 0) nextTick(() => setTimeout(() => input.value?.focus(), 250))
}

/** 关面板时存下：文字删空了就去掉这一项；星期一个都没选就当每天 */
function commit() {
  const i = editing.value
  editing.value = null
  if (i == null) return
  const text = oneLine(draft.text)
  const list = [...prefs.write.checklist]
  if (!text) {
    if (i >= 0) list.splice(i, 1)
    prefs.write.checklist = list
    return
  }
  const when: ChecklistWhen = draft.when === 'weekly' && !draft.weekdays.length ? 'daily' : draft.when
  const item: ChecklistItem = when === 'weekly' ? { text, when, weekdays: WEEK_ORDER.filter((d) => draft.weekdays.includes(d)) } : { text, when }
  if (i >= 0) list[i] = item
  else list.push(item)
  prefs.write.checklist = list
}

function setWhen(w: Exclude<ChecklistWhen, 'weekly'>) {
  draft.when = w
  draft.weekdays = []
}

function toggleDay(d: number) {
  const on = draft.weekdays.includes(d)
  draft.weekdays = on ? draft.weekdays.filter((x) => x !== d) : [...draft.weekdays, d]
  draft.when = draft.weekdays.length ? 'weekly' : 'daily'
}

function move(delta: number) {
  const i = editing.value
  if (i == null || i < 0) return
  const j = i + delta
  if (j < 0 || j >= items.value.length) return
  const list = [...prefs.write.checklist]
  ;[list[i], list[j]] = [list[j], list[i]]
  prefs.write.checklist = list
  editing.value = j
}

function removeItem() {
  draft.text = ''
  commit()
}

/** 今天会预填哪些（节假日数据更新后跟着变） */
const t = today()
const todayItems = computed(() => {
  void holidayVersion.value
  return itemsFor(prefs.write.checklist, t, holidayOn)
})
const todayKind = computed(() => {
  void holidayVersion.value
  const h = holidayOn(t)
  const base = isWorkday(t, holidayOn) ? '工作日' : '休息日'
  if (h) return `${weekday(t)}，${h.off ? `${h.name}假期` : '调休上班'}，算${base}`
  return `${weekday(t)}，${base}`
})
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>每日清单</h1>
    </header>

    <p class="desc pad intro">列好每天照例要做的事。今天第一次打开日记时，它们会填成待办，在阅读视图里勾一下就记进当天的日记。一项都没勾、也没写字就离开，不会保存。</p>

    <section>
      <button v-for="(it, i) in items" :key="i" class="item link row" @click="openItem(i)">
        <div class="text">{{ it.text }}</div>
        <span class="when">{{ whenLabel(it) }}</span>
        <Icon name="right" class="chev" />
      </button>
      <button class="item link add" @click="openItem(-1)">
        <div><Icon name="plus" class="plus" />添一项</div>
      </button>
    </section>

    <section v-if="items.length">
      <h2>今天会填上（{{ todayKind }}）</h2>
      <ul v-if="todayItems.length" class="preview prose">
        <li v-for="(x, i) in todayItems" :key="i"><input type="checkbox" disabled /> {{ x }}</li>
      </ul>
      <p v-else class="desc pad">今天没有要填的事。</p>
    </section>

    <section>
      <p class="desc pad">每周固定某天的事，选“指定星期几”就好，比如周日大扫除。工作日、休息日按法定节假日和调休算：放假的周一算休息日，调休上班的周六算工作日。改了清单只影响以后的日子，已经填进日记的不变。</p>
    </section>

    <Sheet :open="editing != null" :title="editing === -1 ? '添一项' : '这一项'" @close="commit">
      <div class="form sheet-form">
        <input ref="input" v-model="draft.text" class="field" placeholder="比如 读书半小时" aria-label="要做的事" enterkeyhint="done"
          @keydown.enter.prevent="commit" />
        <h3>哪些天</h3>
        <div class="chips" role="group" aria-label="出现的日子">
          <button class="chip" :class="{ on: draft.when === 'daily' }" :aria-pressed="draft.when === 'daily'" @click="setWhen('daily')">每天</button>
          <button class="chip" :class="{ on: draft.when === 'workday' }" :aria-pressed="draft.when === 'workday'" @click="setWhen('workday')">工作日</button>
          <button class="chip" :class="{ on: draft.when === 'restday' }" :aria-pressed="draft.when === 'restday'" @click="setWhen('restday')">休息日</button>
        </div>
        <div class="chips week" role="group" aria-label="指定星期几">
          <button v-for="d in WEEK_ORDER" :key="d" class="chip day" :class="{ on: draft.when === 'weekly' && draft.weekdays.includes(d) }"
            :aria-pressed="draft.when === 'weekly' && draft.weekdays.includes(d)" :aria-label="`周${weekName(d)}`" @click="toggleDay(d)">{{ weekName(d) }}</button>
        </div>
        <p class="hint">也可以点下面一排，指定星期几（可以多选）。</p>
        <div v-if="editing != null && editing >= 0" class="ops">
          <button class="text-btn" :disabled="editing === 0" @click="move(-1)"><Icon name="up" />往前</button>
          <button class="text-btn" :disabled="editing === items.length - 1" @click="move(1)"><Icon name="down" />往后</button>
          <button class="text-btn danger" @click="removeItem"><Icon name="trash" />删去</button>
        </div>
      </div>
    </Sheet>
  </div>
</template>

<style scoped>
.intro { margin-top: 10px; }
.row .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { flex: none; max-width: 45%; font-size: 13px; color: var(--muted); text-align: right; }
.add { color: var(--muted); }
.add .plus { width: 18px; height: 18px; vertical-align: -3px; margin-right: 6px; }
.preview { margin: 4px 20px 0; padding: 0; list-style: none; font-size: 16px; line-height: 1.9; }
.preview input { margin: 0 6px 0 0; vertical-align: -1px; }
.sheet-form { padding: 0 0 8px; }
.sheet-form h3 { margin: 18px 0 8px; font-size: 13px; font-weight: 700; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chips.week { margin-top: 10px; }
.chip.day { min-width: 38px; justify-content: center; padding: 0; font-family: var(--serif); }
.ops { display: flex; gap: 4px; margin-top: 18px; flex-wrap: wrap; }
.ops .text-btn { display: inline-flex; align-items: center; gap: 4px; padding: 0 12px; font-weight: 600; }
.ops .text-btn svg { width: 18px; height: 18px; }
.ops .danger { margin-left: auto; color: var(--danger); }
</style>

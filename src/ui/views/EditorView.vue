<script setup lang="ts">
/**
 * 编辑页。逻辑分在 ui/editor/ 下：
 * useEntrySession（打开、自动保存、离开、删除）、usePlaceWeather、useTextarea（编辑框与快捷按钮）、
 * useImages（插图与图片说明）、useAiExtract（AI 标注）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { renderMarkdown } from '../markdown'
import { index, indexVersion, today } from '../../app'
import { bodyFor } from '../../core/session'
import { setListFieldManually } from '../../core/entryFile'
import { isValidYmd, parseYmd, weekday } from '../../core/time'
import { lunar as lunarDay } from '../../holidayService'
import { resolveImages } from '../../imageService'
import type { ListField } from '../../core/types'
import { toggleTask } from '../../core/mdEdit'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import ListEditor from '../components/ListEditor.vue'
import MoodSlider from '../components/MoodSlider.vue'
import LocationSheet from '../components/LocationSheet.vue'
import WeatherSheet from '../components/WeatherSheet.vue'
import ExtractSheet from '../components/ExtractSheet.vue'
import ImageSourceSheet from '../components/ImageSourceSheet.vue'
import CaptionSheet from '../components/CaptionSheet.vue'
import EditorToolbar from '../components/EditorToolbar.vue'
import { useEntrySession } from '../editor/useEntrySession'
import { usePlaceWeather } from '../editor/usePlaceWeather'
import { useTextarea } from '../editor/useTextarea'
import { useImages } from '../editor/useImages'
import { useAiExtract } from '../editor/useAiExtract'

const route = useRoute()
const router = useRouter()
const date = String(route.params.date)

const { session, text, status, saveError, statusText, meta, readOnly, isToday, open, flush, metaChanged, remove, isLeft } = useEntrySession(date)
const mode = ref<'write' | 'read'>('write')
/** 元数据下面的一行提示（定位失败、插图失败、AI 设置等） */
const placeNote = ref('')
const note = (s: string) => (placeNote.value = s)

const { textarea, focused, autosize, focusEnd, onFocus, onBlur, onTool, onBeforeInput, replaceText } = useTextarea(text, readOnly, () => chooseImage())
const { placeBusy, locOpen, weatherOpen, fillPlace, pickLocation, locLabel, fetchNowWeather, saveWeather, weatherText } =
  usePlaceWeather({ date, meta, changed: metaChanged, isLeft, note })
const { imgBusy, imgSheet, chooseImage, insertImage, caption, canCaption, autoCaption, saveCaption, lateCaption, onReadingImage } = useImages({
  text, date, readOnly, meta, autosize, replaceText, flush, note,
  cursor: () => (mode.value === 'write' && textarea.value ? textarea.value.selectionStart : null),
})
const { canExtract, ai, runExtract, acceptExtract } = useAiExtract(date, session, flush, note)

const title = computed(() => {
  const d = parseYmd(date)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
})
const subtitle = computed(() => {
  const y = date.slice(0, 4)
  const l = lunarDay(date)
  const parts = [y === today().slice(0, 4) ? '' : `${y}年`, weekday(date), l.full.replace('农历', ''), l.festival, l.jieqi, l.holiday?.off && !l.festival ? `${l.holiday.name}假期` : '']
  if (!isToday.value && !session.value?.existed) parts.push('补写')
  return parts.filter(Boolean).join(' · ')
})

// ---------- 阅读视图 ----------

const renderedRaw = computed(() => (session.value ? renderMarkdown(bodyFor(session.value, text.value)) : ''))
const rendered = ref('')
watch([renderedRaw, mode], async ([raw, m]) => {
  if (m !== 'read') return
  // 待办方框默认是禁用的；可编辑时让它能点
  const html = readOnly.value ? raw : raw.replace(/<input ((?:checked="" )?)disabled="" type="checkbox">/g, '<input $1type="checkbox" class="task">')
  rendered.value = html
  // 把相对路径的图片换成本地文件内容
  rendered.value = await resolveImages(html)
})

/** 阅读视图里勾选待办：改写正文对应的 [ ] / [x] */
function onReadingChange(e: Event) {
  const el = e.target as HTMLInputElement
  if (readOnly.value || el.type !== 'checkbox') return
  const boxes = Array.from((e.currentTarget as HTMLElement).querySelectorAll('input[type="checkbox"]'))
  const next = toggleTask(text.value, boxes.indexOf(el), el.checked)
  if (next == null) return
  text.value = next
  void flush()
}

/** 阅读视图里点图片：改图片说明 */
function onReadingClick(e: MouseEvent) {
  const img = (e.target as HTMLElement).closest('img')
  if (img && !readOnly.value) onReadingImage(img, e.currentTarget as HTMLElement)
}

/** 阅读视图里双击正文进入编辑（点到待办方框、链接、图片时不算） */
function onReadingDblClick(e: MouseEvent) {
  const t = e.target as HTMLElement
  if (readOnly.value || t.closest('input, a, img')) return
  toggleMode()
}

function toggleMode() {
  if (mode.value === 'write') {
    void flush()
    mode.value = 'read'
  } else {
    mode.value = 'write'
    nextTick(() => {
      autosize()
      focusEnd()
    })
  }
}

onMounted(async () => {
  if (!isValidYmd(date)) {
    router.replace('/')
    return
  }
  const s = await open(route.query.append === '1')
  // 光标滚动进视野时，留出按钮条的高度
  document.documentElement.style.scrollPaddingBottom = '72px'
  // 已经写过的日记默认打开阅读视图；新的一天和“写今天”追加段落时直接编辑
  if (!s.error && s.existed && !s.appended) mode.value = 'read'
  await nextTick()
  autosize()
  if (!s.error && (!s.existed || s.appended)) focusEnd()
  if (!s.error && isToday.value) void fillPlace()
})
onBeforeUnmount(() => {
  document.documentElement.style.scrollPaddingBottom = ''
})

// ---------- 元数据 ----------

/** 心情：拖动条松手或点文字后立即保存 */
const mood = computed({
  get: () => meta.value?.mood,
  set: (v: number | undefined) => {
    const m = meta.value
    if (!m || m.mood === v) return
    if (v == null) delete m.mood
    else m.mood = v
    metaChanged()
  },
})

/** 不让 AI 读这篇：问答、总结、抽取、图片说明都跳过 */
function toggleAiExclude() {
  const m = meta.value
  if (!m || readOnly.value) return
  if (m.ai_exclude) delete m.ai_exclude
  else m.ai_exclude = true
  note(m.ai_exclude ? '这篇不会给 AI 读：问答、总结、标注都会跳过它。' : '这篇恢复给 AI 读。')
  metaChanged()
}

const sheet = ref<'' | 'tags' | 'more'>('')
const draft = reactive<Record<ListField, string[]>>({ tags: [], people: [], places: [] })
function openSheet(which: 'tags' | 'more') {
  const m = meta.value
  if (!m || readOnly.value) return
  draft.tags = [...(m.tags ?? [])]
  draft.people = [...(m.people ?? [])]
  draft.places = [...(m.places ?? [])]
  sheet.value = which
}
function closeSheet() {
  const m = meta.value
  if (m) {
    const fields: ListField[] = sheet.value === 'tags' ? ['tags'] : ['people', 'places']
    let changed = false
    for (const f of fields) if (setListFieldManually(m, f, draft[f])) changed = true
    if (changed) metaChanged()
  }
  sheet.value = ''
}
const suggestions = computed(() => {
  void indexVersion.value
  return {
    tags: index.values('tags').map((x) => x.value),
    people: index.values('people').map((x) => x.value),
    places: index.values('places').map((x) => x.value),
  }
})

async function removeEntry() {
  const ok = await remove(
    `删除${title.value}的日记？\n\n日记和这天插的图片会移到“设置 → 最近删除”，保留 30 天，可以恢复。` +
      '开了同步的话，云端的副本会在下次同步时删除。',
  )
  if (ok) goBack()
}

function goBack() {
  if (window.history.state?.back) router.back()
  else router.replace('/')
}
</script>

<template>
  <div class="editor">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="goBack"><Icon name="back" /></button>
      <div class="titles">
        <h1>{{ title }}</h1>
        <span class="sub">
          <span class="sub-text">{{ subtitle }}</span>
          <Transition name="status" mode="out-in">
            <span v-if="statusText" :key="statusText" class="status" aria-live="polite">{{ statusText }}</span>
          </Transition>
        </span>
      </div>
      <button v-if="session?.existed" class="icon-btn" aria-label="删除这篇日记" @click="removeEntry">
        <Icon name="trash" />
      </button>
      <button v-if="meta && !readOnly" class="icon-btn ai-ex" :class="{ on: meta.ai_exclude }" :aria-pressed="!!meta.ai_exclude"
        :aria-label="meta.ai_exclude ? 'AI 不读这篇（点一下恢复）' : '不让 AI 读这篇'" @click="toggleAiExclude">
        <Icon :name="meta.ai_exclude ? 'eye-off' : 'eye'" />
      </button>
      <button class="icon-btn" :aria-label="mode === 'write' ? '阅读视图' : '编辑'" :disabled="!session"
        @click="toggleMode">
        <Transition name="swap" mode="out-in"><Icon :key="mode" :name="mode === 'write' ? 'read' : 'pen'" /></Transition>
      </button>
    </header>

    <template v-if="session && meta">
      <p v-if="session.error" class="banner">
        这个文件的格式有误（{{ session.error }}）。为避免损坏数据，app 不会改写它，请在其他编辑器里修正后再打开。
      </p>
      <p v-if="status === 'error'" class="banner">保存失败：{{ saveError }}。内容还在编辑框里，请稍后再试。</p>

      <MoodSlider v-if="!readOnly" v-model="mood" :title="isToday ? '今天的心情' : '这天的心情'">
        <template #top>
          <div class="readouts">
            <button class="readout" :class="{ empty: !locLabel }" :aria-label="`位置：${locLabel || '未记录'}`" @click="locOpen = true">
              <Icon name="pin" class="ri" /><span>{{ locLabel || (placeBusy ? '正在定位…' : '记录位置') }}</span>
            </button>
            <button class="readout" :class="{ empty: !weatherText }" :aria-label="`天气：${weatherText || '未记录'}`" @click="weatherOpen = true">
              <Icon name="weather" class="ri" /><span>{{ weatherText || (placeBusy ? '正在取天气…' : '天气') }}</span>
            </button>
          </div>
        </template>
        <template #bottom>
          <TransitionGroup tag="div" name="tok" class="tokens" aria-label="标签、人物和去过的地方">
            <span v-for="t in meta.tags ?? []" :key="'t' + t" class="tok tag" @click="openSheet('tags')">#{{ t }}</span>
            <span v-for="t in meta.people ?? []" :key="'u' + t" class="tok" @click="openSheet('more')"><Icon name="person" class="ti" />{{ t }}</span>
            <span v-for="t in meta.places ?? []" :key="'p' + t" class="tok" @click="openSheet('more')"><Icon name="pin" class="ti" />{{ t }}</span>
            <span v-if="!meta.tags?.length && !meta.people?.length && !meta.places?.length" key="none" class="tok none">还没有标签、人物和地点</span>
          </TransitionGroup>
        </template>
      </MoodSlider>

      <div v-if="!readOnly" class="actions" role="toolbar" aria-label="编辑标签、人物地点和插图">
        <button class="act" @click="openSheet('tags')"><Icon name="hash" class="ci" />{{ meta.tags?.length ? '改标签' : '加标签' }}</button>
        <button class="act" @click="openSheet('more')"><Icon name="person" class="ci" />人物和地点</button>
        <button class="act" :disabled="imgBusy" @click="chooseImage"><Icon name="image" class="ci" />{{ imgBusy ? '处理中' : '插图' }}</button>
        <button v-if="canExtract && !meta.ai_exclude" class="act" @click="runExtract"><Icon name="sparkle" class="ci" />AI 标注</button>
      </div>
      <p v-if="placeNote" class="place-note">{{ placeNote }}</p>

      <main class="paper" :class="{ 'with-tools': mode === 'write' && focused }">
        <textarea v-show="mode === 'write'" ref="textarea" v-model="text" class="input prose" :readonly="readOnly"
          :placeholder="isToday ? '今天过得怎么样？' : '这一天发生了什么？'" aria-label="日记正文" @input="autosize"
          @focus="onFocus" @blur="onBlur" @beforeinput="onBeforeInput" />
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-if="mode === 'read'" class="prose reading" :class="{ editable: !readOnly }" @change="onReadingChange" @click="onReadingClick"
          @dblclick="onReadingDblClick" v-html="rendered" />
        <p v-if="mode === 'read' && !readOnly" class="read-hint">双击正文或点右上角的笔开始编辑，点图片写说明</p>
      </main>
      <EditorToolbar v-if="mode === 'write' && !readOnly && focused" :img-busy="imgBusy" @action="onTool" />
    </template>

    <ExtractSheet :open="ai.open" :busy="ai.busy" :error="ai.error" :x="ai.x" :meta="meta" @close="ai.open = false" @accept="acceptExtract" />
    <WeatherSheet :open="weatherOpen" :current="meta?.weather" :can-fetch="isToday" :fetcher="fetchNowWeather"
      @close="weatherOpen = false" @save="saveWeather" />
    <ImageSourceSheet :open="imgSheet" @close="imgSheet = false" @pick="insertImage" />
    <CaptionSheet :open="caption.open" :date="date" :src="caption.src" :current="caption.current" :excerpt="() => text"
      :can-ai="canCaption" :auto="autoCaption" @close="caption.open = false" @save="saveCaption" @late="lateCaption" />
    <LocationSheet :open="locOpen" :current="meta?.location" :can-locate="isToday" @close="locOpen = false" @pick="pickLocation" />
    <Sheet :open="sheet === 'tags'" title="标签" @close="closeSheet">
      <ListEditor v-model="draft.tags" :suggestions="suggestions.tags" label="标签" placeholder="输入标签，如 读书" />
    </Sheet>
    <Sheet :open="sheet === 'more'" title="人物和地点" @close="closeSheet">
      <h3 class="sheet-sub">提到的人</h3>
      <ListEditor v-model="draft.people" :suggestions="suggestions.people" label="人物" placeholder="输入名字" />
      <h3 class="sheet-sub">这天去过的地方</h3>
      <ListEditor v-model="draft.places" :suggestions="suggestions.places" label="地点" placeholder="输入地点，如 楼下面馆" />
    </Sheet>
  </div>
</template>

<style scoped>
.editor { min-height: 100vh; background: var(--bg); }
.titles { flex: 1; display: flex; flex-direction: column; margin-left: 4px; min-width: 0; }
.titles h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-family: var(--num); font-size: 22px; font-weight: 600; line-height: 1.2; letter-spacing: 0.02em; }
.sub { display: flex; gap: 6px; min-width: 0; font-size: 12px; color: var(--muted); white-space: nowrap; }
.sub-text { overflow: hidden; text-overflow: ellipsis; }
.status { flex: none; color: var(--faint); }
.status::before { content: '·'; margin-right: 6px; }
.banner {
  margin: 4px 16px 8px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  color: var(--danger);
  font-size: 14px;
}
.readouts { display: flex; gap: 6px; }
.readout {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  max-width: 62%;
  min-height: 32px;
  padding: 0 10px 0 6px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  font-size: 14px;
  font-weight: 600;
}
.readout:last-child { flex: none; max-width: 40%; }
.readout span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.readout:active { background: var(--line); }
.readout.empty { color: var(--faint); font-weight: 400; }
.ri { width: 17px; height: 17px; flex: none; color: var(--muted); }
.tokens { display: flex; flex-wrap: wrap; gap: 2px 12px; padding: 0 4px; font-size: 14px; color: var(--muted); }
.tok { display: inline-flex; align-items: center; gap: 2px; line-height: 1.8; }
.tok.tag { color: var(--ink); font-weight: 700; }
.tok.none { color: var(--faint); font-size: 13px; }
.ti { width: 14px; height: 14px; opacity: 0.75; }
.tok-enter-active, .tok-leave-active { transition: opacity 0.25s, transform 0.3s cubic-bezier(0.3, 1.4, 0.5, 1); }
.tok-enter-from, .tok-leave-to { opacity: 0; transform: scale(0.6); }
.actions { display: flex; gap: 8px; overflow-x: auto; padding: 0 16px 12px; scrollbar-width: none; }
.actions::-webkit-scrollbar { display: none; }
.act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  min-height: 34px;
  padding: 0 12px 0 10px;
  border: 0;
  border-radius: 10px;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line);
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  transition: transform 0.15s;
}
.act:active { transform: scale(0.94); background: var(--line); }
.act:disabled { opacity: 0.6; }
.act.on { background: var(--ink); color: var(--bg); box-shadow: none; }
.status-enter-active, .status-leave-active { transition: opacity 0.2s, transform 0.2s; }
.status-enter-from { opacity: 0; transform: translateY(6px); }
.status-leave-to { opacity: 0; transform: translateY(-6px); }
.swap-enter-active, .swap-leave-active { transition: transform 0.22s var(--spring), opacity 0.15s; }
.swap-enter-from { opacity: 0; transform: rotate(-90deg) scale(0.5); }
.swap-leave-to { opacity: 0; transform: rotate(90deg) scale(0.5); }
/* 切换阅读 / 编辑：内容轻轻浮上来 */
.reading { animation: rise-in 0.3s var(--ease-out); }
.reading :deep(img) { animation: pop-in 0.4s var(--ease-out); }
.ai-ex { position: relative; color: var(--faint); }
.ai-ex.on { color: var(--accent); }
/* 打开后图标下面写一个小字，免得只看图标猜不出意思 */
.ai-ex::after { content: 'AI'; position: absolute; left: 50%; bottom: -1px; transform: translateX(-50%); font-size: 9px; font-weight: 700; letter-spacing: 0.05em; }
.ai-ex.on::after { content: 'AI 不读'; white-space: nowrap; }
.read-hint { animation: fade-in 0.6s 0.4s backwards; margin: 24px 0 0; font-size: 12px; color: var(--faint); text-align: center; }
.ci { width: 16px; height: 16px; flex: none; }
.place-note { margin: -4px 20px 10px; font-size: 12px; color: var(--faint); }
.paper { padding: 4px 20px calc(40px + var(--safe-bottom)); }
.paper.with-tools { padding-bottom: calc(96px + var(--safe-bottom)); }
.reading :deep(li:has(> .task)) { list-style: none; margin-left: -1.2em; }
.reading :deep(.task) { width: 18px; height: 18px; margin: 0 6px 0 0; vertical-align: -3px; accent-color: var(--m4); }
.input {
  display: block;
  width: 100%;
  min-height: 50vh;
  padding: 0;
  border: 0;
  outline: none;
  resize: none;
  background: transparent;
  overflow: hidden;
}
.input::placeholder { color: var(--faint); }
.reading { min-height: 50vh; }
.reading.editable :deep(img) { cursor: pointer; }
.sheet-sub { margin: 18px 0 10px; font-size: 14px; font-weight: 600; color: var(--muted); }
.sheet-sub:first-child { margin-top: 4px; }
</style>

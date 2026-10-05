<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { renderMarkdown } from '../markdown'
import { App as CapApp } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { deleteEntryToTrash, enqueue, index, indexVersion, refreshDate, repo, today } from '../../app'
import { syncAfterEdit, syncOnHide } from '../../syncService'
import { bodyFor, openSession, type EditSession } from '../../core/session'
import { hasContent, setListFieldManually } from '../../core/entryFile'
import { isValidYmd, parseYmd, weekday } from '../../core/time'
import { lunarDay } from '../../core/lunar'
import type { ListField } from '../../core/types'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import ListEditor from '../components/ListEditor.vue'
import MoodSlider from '../components/MoodSlider.vue'
import LocationSheet from '../components/LocationSheet.vue'
import WeatherSheet from '../components/WeatherSheet.vue'
import { autoFill, fetchWeather, getPosition } from '../../placeService'
import { cleanCameraTemp, compress, pickImage, resolveImages, saveImage } from '../../imageService'
import { prefs } from '../../prefs'
import type { Location, Weather } from '../../core/types'
import { ensureConsent, extractPreview, profileFor } from '../../aiService'
import { applyExtraction, type Extraction } from '../../core/llm/extract'
import { diaryChanged } from '../../app'
import EditorToolbar, { type ToolAction } from '../components/EditorToolbar.vue'
import { continueList, insertAt, toggleLines, toggleTask, toggleWrap, type Edit } from '../../core/mdEdit'
import { hhmm } from '../../core/time'

const route = useRoute()
const router = useRouter()
const date = String(route.params.date)

const session = ref<EditSession | null>(null)
const text = ref('')
const mode = ref<'write' | 'read'>('write')
const status = ref<'idle' | 'saving' | 'saved' | 'empty' | 'error'>('idle')
const saveError = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)

let savedBody = ''
let metaDirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let left = false
/** 已经删除：之后不再写盘 */
let deleted = false


const meta = computed(() => session.value?.doc.meta)
const readOnly = computed(() => !!session.value?.error)
const isToday = computed(() => date === today())
const title = computed(() => {
  const d = parseYmd(date)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
})
const subtitle = computed(() => {
  const y = date.slice(0, 4)
  const l = lunarDay(date)
  const parts = [`${y} 年`, weekday(date), l.full, ...(l.festival ? [l.festival] : []), ...(l.jieqi ? [l.jieqi] : [])]
  if (!isToday.value && !session.value?.existed) parts.push('补写')
  return parts.join('，')
})
const renderedRaw = computed(() =>
  session.value ? renderMarkdown(bodyFor(session.value, text.value)) : '',
)
// 阅读视图：把相对路径的图片换成本地文件内容
const rendered = ref('')
watch([renderedRaw, mode], async ([raw, m]) => {
  if (m !== 'read') return
  // 待办方框默认是禁用的；可编辑时让它能点
  const html = readOnly.value ? raw : raw.replace(/<input ((?:checked="" )?)disabled="" type="checkbox">/g, '<input $1type="checkbox" class="task">')
  rendered.value = html
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
const statusText = computed(() => {
  if (readOnly.value) return '只读'
  switch (status.value) {
    case 'saving': return '保存中'
    case 'saved': return '已保存'
    case 'empty': return '写点内容才会保存'
    case 'error': return '保存失败'
    default: return ''
  }
})

// ---------- 保存 ----------

/**
 * 有改动后最多 1 秒写盘一次（节流而不是防抖）：
 * 即使一直不停地打字，被强行杀掉时也最多丢失最后 1 秒的输入（阶段 1 验收项）。
 */
function schedule() {
  if (readOnly.value || timer) return
  timer = setTimeout(() => void flush(), 1000)
}

function flush(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const s = session.value
  if (!s || s.error || deleted) return Promise.resolve()
  const body = bodyFor(s, text.value)
  return enqueue(async () => {
    if (body === savedBody && !metaDirty) return
    if (!hasContent(body)) {
      status.value = 'empty'
      return
    }
    status.value = 'saving'
    try {
      s.doc.body = body
      await repo.saveEntry(s.doc)
      savedBody = body
      metaDirty = false
      s.existed = true
      status.value = 'saved'
      await refreshDate(date)
    } catch (e) {
      status.value = 'error'
      saveError.value = (e as Error).message
    }
  })
}

watch(text, schedule)

function onHidden() {
  if (document.visibilityState === 'hidden') void flush().then(syncOnHide)
}

let pauseHandle: PluginListenerHandle | null = null

onMounted(async () => {
  if (!isValidYmd(date)) {
    router.replace('/')
    return
  }
  const s = await openSession(repo, date, { append: route.query.append === '1' })
  session.value = s
  savedBody = s.originalBody
  text.value = s.initialText
  document.addEventListener('visibilitychange', onHidden)
  window.addEventListener('pagehide', onHidden)
  // 光标滚动进视野时，留出按钮条的高度
  document.documentElement.style.scrollPaddingBottom = '72px'
  if (Capacitor.isNativePlatform()) {
    pauseHandle = await CapApp.addListener('pause', () => void flush())
  }
  // 已经写过的日记默认打开阅读视图；新的一天和“写今天”追加段落时直接编辑
  if (!s.error && s.existed && !s.appended) mode.value = 'read'
  await nextTick()
  autosize()
  if (!s.error && (!s.existed || s.appended)) focusEnd()
  if (!s.error && isToday.value) void fillPlace()
})

// ---------- 位置与天气 ----------

const placeNote = ref('')
const skipKey = `nolocate:${date}`

/** 当天第一次打开：自动记位置和天气（规格 5.3、5.4）。补写往日日记不自动获取。 */
const placeBusy = ref(false)
async function fillPlace() {
  const m = meta.value
  if (!m || (m.location && m.weather) || !prefs.place.autoLocate) return
  placeBusy.value = true
  const r = await autoFill(m, { skipLocation: prefs.seen.includes(skipKey) }).finally(() => (placeBusy.value = false))
  if (!session.value || left) return
  let changed = false
  if (r.location && !m.location) {
    m.location = r.location
    changed = true
  }
  if (r.weather && !m.weather) {
    m.weather = r.weather
    changed = true
  }
  if (r.errors.length && !changed) placeNote.value = r.errors[0]
  if (changed) {
    metaDirty = true
    schedule()
  }
}

const locOpen = ref(false)
function pickLocation(loc: Location | null) {
  const m = meta.value
  locOpen.value = false
  if (!m) return
  if (loc === null) {
    delete m.location
    if (!prefs.seen.includes(skipKey)) prefs.seen.push(skipKey)
  } else {
    m.location = loc
    // 选了具体地点，就把它算作“这天去过的地方”（自动带入，不算手动修改，不锁定）
    if (loc.name && !(m.places ?? []).includes(loc.name)) m.places = [...(m.places ?? []), loc.name]
  }
  metaDirty = true
  void flush()
}
const locLabel = computed(() => {
  const l = meta.value?.location
  if (!l) return ''
  if (l.name) return l.name
  if (l.address) return l.address.replace(/^.+?(省|自治区)/, '').slice(0, 14)
  return '已记坐标'
})

const weatherOpen = ref(false)
/** 按现在的位置取天气，只在天气框里点“重新获取”时调用 */
async function fetchNowWeather() {
  const m = meta.value
  const at = m?.location?.lat != null ? { lat: m.location.lat, lng: m.location.lng! } : await getPosition().catch(() => prefs.place.defaultCity)
  if (!at) throw new Error('没有位置，也没有设置默认城市')
  return fetchWeather(at.lat, at.lng)
}
function saveWeather(w: Weather | null) {
  const m = meta.value
  if (!m) return
  if (w) m.weather = w
  else delete m.weather
  metaDirty = true
  void flush()
}

// ---------- AI 标注（单篇抽取，规格 7.3：先显示结果，确认后才写入） ----------

const canExtract = computed(() => !!profileFor('extract'))
const ai = reactive({ open: false, busy: false, error: '', x: null as Extraction | null, model: '' })
async function runExtract() {
  if (ai.busy || !ensureConsent('extract')) return
  await flush()
  if (!session.value?.existed) {
    placeNote.value = '先写点内容再让 AI 标注'
    return
  }
  Object.assign(ai, { open: true, busy: true, error: '', x: null })
  try {
    const r = await extractPreview(date)
    ai.x = r.x
    ai.model = r.model
  } catch (e) {
    ai.error = (e as Error).message
  } finally {
    ai.busy = false
  }
}
async function acceptExtract() {
  const s = session.value
  if (!s || !ai.x) return
  applyExtraction(s.doc, ai.x, ai.model)
  await enqueue(async () => {
    await repo.saveEntry(s.doc, new Date(), { touchUpdated: false })
    await refreshDate(date)
  })
  diaryChanged()
  ai.open = false
}
/** 不让 AI 读这篇：问答、总结、抽取都跳过 */
function toggleAiExclude() {
  const m = meta.value
  if (!m || readOnly.value) return
  if (m.ai_exclude) delete m.ai_exclude
  else m.ai_exclude = true
  metaDirty = true
  void flush()
}
const FIELD_NAMES = { places: '去过的地方', people: '提到的人', tags: '标签' } as const

// ---------- 插图 ----------

const imgBusy = ref(false)
const imgSheet = ref(false)
/** 打开选图方式前记下光标位置（打开弹窗时编辑框会失焦）；阅读视图里插到末尾 */
let imgPos: number | null = null
function chooseImage() {
  if (readOnly.value || imgBusy.value) return
  imgPos = mode.value === 'write' && textarea.value ? textarea.value.selectionStart : null
  imgSheet.value = true
}
async function insertImage(source: 'camera' | 'gallery') {
  imgSheet.value = false
  if (readOnly.value || imgBusy.value) return
  const file = await pickImage(source)
  if (!file) return
  imgBusy.value = true
  try {
    const md = await saveImage(date, await compress(file))
    if (source === 'camera') void cleanCameraTemp()
    const pos = imgPos ?? text.value.length
    const before = text.value.slice(0, pos)
    const after = text.value.slice(pos)
    const pre = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : ''
    text.value = `${before}${pre}${md}\n\n${after.replace(/^\n+/, '')}`
    await nextTick()
    autosize()
  } catch (e) {
    placeNote.value = `插图失败：${(e as Error).message}`
  } finally {
    imgBusy.value = false
  }
}

onBeforeUnmount(() => {
  document.documentElement.style.scrollPaddingBottom = ''
  document.removeEventListener('visibilitychange', onHidden)
  window.removeEventListener('pagehide', onHidden)
  pauseHandle?.remove()
  if (!left) void flush()
})

onBeforeRouteLeave(async () => {
  left = true
  const s = session.value
  if (!s || s.error || deleted) return true
  if (timer) clearTimeout(timer)
  const body = bodyFor(s, text.value)
  if (!hasContent(body) && s.existed) {
    if (window.confirm('正文已清空。要删除这一天的日记吗？\n\n删除后可以在“设置 → 最近删除”里找回，保留 30 天。')) {
      await deleteEntryToTrash(date)
      syncAfterEdit()
    }
    return true
  }
  await flush()
  syncAfterEdit()
  return true
})

// ---------- 编辑框 ----------

function autosize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.max(el.scrollHeight, window.innerHeight * 0.5)}px`
}

function focusEnd() {
  const el = textarea.value
  if (!el) return
  el.focus()
  const n = el.value.length
  el.setSelectionRange(n, n)
  if (Capacitor.getPlatform() === 'android') Keyboard.show().catch(() => {})
  el.scrollIntoView({ block: 'end' })
}

// ---------- 快捷按钮与列表续行 ----------

const focused = ref(false)
function onFocus() {
  focused.value = true
}
function onBlur() {
  // 点按钮条时编辑框不会失焦；真正离开编辑框（收起键盘、点了别处）才隐藏按钮条
  setTimeout(() => (focused.value = document.activeElement === textarea.value), 150)
}

/** 用 execCommand 改文字：会触发 input 事件（v-model 同步），并进入系统的撤销记录 */
function applyEdit(e: Edit) {
  const el = textarea.value
  if (!el || readOnly.value) return
  el.focus()
  el.setSelectionRange(e.from, e.to)
  let ok = false
  try {
    ok = e.insert ? document.execCommand('insertText', false, e.insert) : e.from === e.to || document.execCommand('delete')
  } catch {
    ok = false
  }
  if (!ok) {
    el.setRangeText(e.insert, e.from, e.to, 'end')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  el.setSelectionRange(e.selStart, e.selEnd)
  autosize()
}

function state() {
  const el = textarea.value!
  return { text: el.value, start: el.selectionStart, end: el.selectionEnd }
}

function onTool(a: ToolAction) {
  const el = textarea.value
  if (!el || readOnly.value) return
  switch (a) {
    case 'bold': return applyEdit(toggleWrap(state()))
    case 'bullet':
    case 'number':
    case 'todo':
    case 'quote': return applyEdit(toggleLines(state(), a))
    case 'time': return applyEdit(insertAt(state(), `${hhmm(new Date())} `))
    case 'image': return chooseImage()
    case 'undo':
      el.focus()
      document.execCommand('undo')
      autosize()
  }
}

/**
 * 回车续行。用 beforeinput 而不是 keydown：安卓输入法的回车往往没有可靠的 keydown，
 * 输入法组字（拼音候选）过程中不处理。
 */
function onBeforeInput(ev: InputEvent) {
  const isEnter = ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph' || (ev.inputType === 'insertText' && ev.data === '\n')
  if (!isEnter || ev.isComposing || readOnly.value) return
  const e = continueList(state())
  if (!e) return
  ev.preventDefault()
  applyEdit(e)
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

// ---------- 元数据 ----------

/** 心情：拖动条松手或点文字后立即保存 */
const mood = computed({
  get: () => meta.value?.mood,
  set: (v: number | undefined) => {
    const m = meta.value
    if (!m || m.mood === v) return
    if (v == null) delete m.mood
    else m.mood = v
    metaDirty = true
    void flush()
  },
})

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
    for (const f of fields) if (setListFieldManually(m, f, draft[f])) metaDirty = true
    if (metaDirty) void flush()
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

const weatherText = computed(() => {
  const w = meta.value?.weather
  if (!w) return ''
  return [w.text, w.temp_c != null ? `${w.temp_c}°C` : ''].filter(Boolean).join(' ')
})

/** 删除这一天：移到“最近删除”，云端副本在下次同步时删除 */
async function removeEntry() {
  const s = session.value
  if (!s?.existed) return
  const ok = window.confirm(
    `删除${title.value}的日记？\n\n日记和这天插的图片会移到“设置 → 最近删除”，保留 30 天，可以恢复。` +
      '开了同步的话，云端的副本会在下次同步时删除。',
  )
  if (!ok) return
  // 先把最后一秒的输入存下来，回收站里的才是完整版本
  if (hasContent(bodyFor(s, text.value))) await flush()
  left = true
  deleted = true
  await deleteEntryToTrash(date)
  syncAfterEdit()
  goBack()
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
        <span class="sub">{{ subtitle }}</span>
      </div>
      <Transition name="status" mode="out-in">
        <span :key="statusText" class="status" aria-live="polite">{{ statusText }}</span>
      </Transition>
      <button v-if="session?.existed" class="icon-btn" aria-label="删除这篇日记" @click="removeEntry">
        <Icon name="trash" />
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
        <button class="act" :class="{ on: meta.ai_exclude }" :aria-pressed="!!meta.ai_exclude" @click="toggleAiExclude">
          <Icon name="eye-off" class="ci" />{{ meta.ai_exclude ? 'AI 不读这篇' : '不让 AI 读' }}
        </button>
      </div>
      <p v-if="placeNote" class="place-note">{{ placeNote }}</p>

      <main class="paper" :class="{ 'with-tools': mode === 'write' && focused }">
        <textarea v-show="mode === 'write'" ref="textarea" v-model="text" class="input prose" :readonly="readOnly"
          :placeholder="isToday ? '今天过得怎么样？' : '这一天发生了什么？'" aria-label="日记正文" @input="autosize"
          @focus="onFocus" @blur="onBlur" @beforeinput="onBeforeInput" />
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-if="mode === 'read'" class="prose reading" @change="onReadingChange" @dblclick="onReadingDblClick" v-html="rendered" />
        <p v-if="mode === 'read' && !readOnly" class="read-hint">双击正文或点右上角的笔开始编辑</p>
      </main>
      <EditorToolbar v-if="mode === 'write' && !readOnly && focused" :img-busy="imgBusy" @action="onTool" />
    </template>

    <Sheet :open="ai.open" title="AI 标注" @close="ai.open = false">
      <p v-if="ai.busy" class="muted">正在读这篇日记……</p>
      <p v-if="ai.error" class="ai-err">{{ ai.error }}</p>
      <template v-if="ai.x && meta">
        <div v-for="f in (['places', 'people', 'tags'] as const)" :key="f" class="ai-row">
          <div class="ai-h">{{ FIELD_NAMES[f] }}<span v-if="meta.locked?.includes(f)" class="ai-lock">你改过，不会覆盖</span></div>
          <div class="ai-vals" :class="{ dim: meta.locked?.includes(f) }">
            <span v-for="v in ai.x[f]" :key="v" class="chip" :class="{ on: !(meta[f] ?? []).includes(v) }">{{ v }}</span>
            <span v-if="!ai.x[f].length" class="muted">（无）</span>
          </div>
        </div>
        <p class="muted small-note">深色的是新增的。确认后写入这篇日记的元数据。</p>
        <button class="solid-btn" @click="acceptExtract">写入</button>
      </template>
    </Sheet>
    <WeatherSheet :open="weatherOpen" :current="meta?.weather" :can-fetch="isToday" :fetcher="fetchNowWeather"
      @close="weatherOpen = false" @save="saveWeather" />
    <Sheet :open="imgSheet" title="插图" @close="imgSheet = false">
      <div class="img-src">
        <button class="src" @click="insertImage('camera')"><Icon name="camera" /><span>拍照</span></button>
        <button class="src" @click="insertImage('gallery')"><Icon name="image" /><span>从相册选</span></button>
      </div>
      <p class="muted small-note">拍的照片只存进日记，不会出现在系统相册里。</p>
    </Sheet>
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
.sub { font-size: 12px; color: var(--muted); }
.status { font-size: 12px; color: var(--faint); white-space: nowrap; }
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
.read-hint { animation: fade-in 0.6s 0.4s backwards; margin: 24px 0 0; font-size: 12px; color: var(--faint); text-align: center; }
.img-src { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.src {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 0;
  border: 1px solid var(--line);
  border-radius: 20px;
  background: var(--surface);
  font-weight: 700;
}
.src svg { width: 30px; height: 30px; }
.src:active { transform: scale(0.96); }
.ci { width: 16px; height: 16px; flex: none; }
.chip:disabled { opacity: 1; }
.ai-row { margin-bottom: 14px; }
.ai-h { margin-bottom: 6px; font-size: 13px; font-weight: 700; color: var(--muted); }
.ai-lock { margin-left: 8px; font-weight: 400; color: var(--faint); }
.ai-vals { display: flex; flex-wrap: wrap; gap: 6px; }
.ai-vals.dim { opacity: 0.45; }
.ai-err { color: var(--danger); font-size: 14px; }
.small-note { font-size: 12px; margin: 4px 0 12px; }
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
.sheet-sub { margin: 18px 0 10px; font-size: 14px; font-weight: 600; color: var(--muted); }
.sheet-sub:first-child { margin-top: 4px; }
</style>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { App as CapApp } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { enqueue, index, indexVersion, refreshDate, repo, today } from '../../app'
import { syncAfterEdit } from '../../syncService'
import { bodyFor, openSession, type EditSession } from '../../core/session'
import { hasContent, setListFieldManually } from '../../core/entryFile'
import { isValidYmd, parseYmd, weekday } from '../../core/time'
import { moonOnDate } from '../../core/astro'
import MoonIcon from '../components/MoonIcon.vue'
import type { ListField } from '../../core/types'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import ListEditor from '../components/ListEditor.vue'
import MoodSlider from '../components/MoodSlider.vue'
import LocationSheet from '../components/LocationSheet.vue'
import { autoFill, fetchWeather, getPosition } from '../../placeService'
import { compress, pickImage, resolveImages, saveImage } from '../../imageService'
import { prefs } from '../../prefs'
import type { Location } from '../../core/types'
import { ensureConsent, extractPreview, profileFor } from '../../aiService'
import { applyExtraction, type Extraction } from '../../core/llm/extract'
import { diaryChanged } from '../../app'

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


const meta = computed(() => session.value?.doc.meta)
const readOnly = computed(() => !!session.value?.error)
const isToday = computed(() => date === today())
const title = computed(() => {
  const d = parseYmd(date)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
})
const subtitle = computed(() => {
  const y = date.slice(0, 4)
  const parts = [`${y} 年`, weekday(date), moonOnDate(date).name]
  if (!isToday.value && !session.value?.existed) parts.push('补写')
  return parts.join('，')
})
const renderedRaw = computed(() =>
  session.value ? DOMPurify.sanitize(marked.parse(bodyFor(session.value, text.value), { async: false, gfm: true }) as string) : '',
)
// 阅读视图：把相对路径的图片换成本地文件内容
const rendered = ref('')
watch([renderedRaw, mode], async ([html, m]) => {
  if (m !== 'read') return
  rendered.value = html
  rendered.value = await resolveImages(html)
})
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
  if (!s || s.error) return Promise.resolve()
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
  if (document.visibilityState === 'hidden') void flush().then(syncAfterEdit)
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
  if (Capacitor.isNativePlatform()) {
    pauseHandle = await CapApp.addListener('pause', () => void flush())
  }
  await nextTick()
  autosize()
  if (!s.error && (!s.existed || s.appended)) focusEnd()
  if (!s.error && isToday.value) void fillPlace()
})

// ---------- 位置与天气 ----------

const placeNote = ref('')
const skipKey = `nolocate:${date}`

/** 当天第一次打开：自动记位置和天气（规格 5.3、5.4）。补写往日日记不自动获取。 */
async function fillPlace() {
  const m = meta.value
  if (!m || (m.location && m.weather)) return
  const r = await autoFill(m, { skipLocation: prefs.seen.includes(skipKey) })
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

const weatherBusy = ref(false)
async function refreshWeather() {
  const m = meta.value
  if (!m || !isToday.value || weatherBusy.value) return
  weatherBusy.value = true
  try {
    const at = m.location?.lat != null ? { lat: m.location.lat, lng: m.location.lng! } : await getPosition().catch(() => prefs.place.defaultCity)
    if (!at) throw new Error('没有位置，也没有设置默认城市')
    m.weather = await fetchWeather(at.lat, at.lng)
    metaDirty = true
    void flush()
  } catch (e) {
    placeNote.value = (e as Error).message
  } finally {
    weatherBusy.value = false
  }
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
const FIELD_NAMES = { places: '去过的地方', people: '提到的人', tags: '标签' } as const

// ---------- 插图 ----------

const imgBusy = ref(false)
async function insertImage() {
  if (readOnly.value || imgBusy.value) return
  const file = await pickImage()
  if (!file) return
  imgBusy.value = true
  try {
    const md = await saveImage(date, await compress(file))
    const el = textarea.value
    const pos = el ? el.selectionStart : text.value.length
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
  document.removeEventListener('visibilitychange', onHidden)
  window.removeEventListener('pagehide', onHidden)
  pauseHandle?.remove()
  if (!left) void flush()
})

onBeforeRouteLeave(async () => {
  left = true
  const s = session.value
  if (!s || s.error) return true
  if (timer) clearTimeout(timer)
  const body = bodyFor(s, text.value)
  if (!hasContent(body) && s.existed) {
    if (window.confirm('正文已清空。要删除这一天的日记吗？')) {
      await enqueue(async () => {
        await repo.deleteEntry(date)
        await refreshDate(date)
      })
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

function toggleMode() {
  if (mode.value === 'write') {
    void flush()
    mode.value = 'read'
  } else {
    mode.value = 'write'
    nextTick(() => {
      autosize()
      textarea.value?.focus()
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
        <h1><MoonIcon :phase="moonOnDate(date).phase" :size="16" class="moon" />{{ title }}</h1>
        <span class="sub">{{ subtitle }}</span>
      </div>
      <span class="status" aria-live="polite">{{ statusText }}</span>
      <button class="icon-btn" :aria-label="mode === 'write' ? '阅读视图' : '编辑'" :disabled="!session"
        @click="toggleMode">
        <Icon :name="mode === 'write' ? 'read' : 'pen'" />
      </button>
    </header>

    <template v-if="session && meta">
      <p v-if="session.error" class="banner">
        这个文件的格式有误（{{ session.error }}）。为避免损坏数据，app 不会改写它，请在其他编辑器里修正后再打开。
      </p>
      <p v-if="status === 'error'" class="banner">保存失败：{{ saveError }}。内容还在编辑框里，请稍后再试。</p>

      <MoodSlider v-if="!readOnly" v-model="mood" :title="isToday ? '今天的心情' : '这天的心情'" />

      <div v-if="!readOnly" class="chips" role="toolbar" aria-label="标签、人物和地点">
        <button v-for="t in meta.tags ?? []" :key="'t' + t" class="chip on" @click="openSheet('tags')">#{{ t }}</button>
        <button class="chip add" @click="openSheet('tags')">{{ meta.tags?.length ? '改标签' : '+ 标签' }}</button>
        <button v-for="t in [...(meta.people ?? []), ...(meta.places ?? [])]" :key="'p' + t" class="chip"
          @click="openSheet('more')">{{ t }}</button>
        <button class="chip add" @click="openSheet('more')">{{ meta.people?.length || meta.places?.length ? '改人物和地点' : '+ 人物和地点' }}</button>
        <button v-if="canExtract" class="chip add" @click="runExtract"><Icon name="sparkle" class="ci" />AI 标注</button>
      </div>
      <div v-if="!readOnly" class="chips" role="toolbar" aria-label="位置、天气和插图">
        <button class="chip" :class="{ add: !locLabel }" @click="locOpen = true">
          <Icon name="pin" class="ci" />{{ locLabel || '位置' }}
        </button>
        <button v-if="weatherText || isToday" class="chip" :class="{ add: !weatherText }" :disabled="!isToday"
          :aria-label="isToday ? '重新获取天气' : '天气'" @click="refreshWeather">
          {{ weatherBusy ? '获取中' : weatherText || '天气' }}
        </button>
        <button class="chip add" :disabled="imgBusy" @click="insertImage">
          <Icon name="image" class="ci" />{{ imgBusy ? '处理中' : '插图' }}
        </button>
      </div>
      <p v-if="placeNote" class="place-note">{{ placeNote }}</p>

      <main class="paper">
        <textarea v-show="mode === 'write'" ref="textarea" v-model="text" class="input prose" :readonly="readOnly"
          :placeholder="isToday ? '今天过得怎么样？' : '这一天发生了什么？'" aria-label="日记正文" @input="autosize" />
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-if="mode === 'read'" class="prose reading" v-html="rendered" />
      </main>
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
.chips {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 0 16px 12px;
  scrollbar-width: none;
}
.chips::-webkit-scrollbar { display: none; }
.chips .chip { max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
.chips + .chips { margin-top: -4px; }
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

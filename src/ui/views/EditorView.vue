<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { App as CapApp } from '@capacitor/app'
import { Capacitor, type PluginListenerHandle } from '@capacitor/core'
import { Keyboard } from '@capacitor/keyboard'
import { enqueue, index, indexVersion, refreshDate, repo, today } from '../../app'
import { bodyFor, openSession, type EditSession } from '../../core/session'
import { hasContent, setListFieldManually } from '../../core/entryFile'
import { isValidYmd, parseYmd, weekday } from '../../core/time'
import type { ListField } from '../../core/types'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import ListEditor from '../components/ListEditor.vue'

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

const MOODS = [
  { v: 1, face: '😞', label: '很差' },
  { v: 2, face: '🙁', label: '不好' },
  { v: 3, face: '😐', label: '一般' },
  { v: 4, face: '🙂', label: '不错' },
  { v: 5, face: '😄', label: '很好' },
]

const meta = computed(() => session.value?.doc.meta)
const readOnly = computed(() => !!session.value?.error)
const isToday = computed(() => date === today())
const title = computed(() => {
  const d = parseYmd(date)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
})
const subtitle = computed(() => {
  const y = date.slice(0, 4)
  const parts = [`${y} 年`, weekday(date)]
  if (!isToday.value && !session.value?.existed) parts.push('补写')
  return parts.join('，')
})
const rendered = computed(() =>
  DOMPurify.sanitize(marked.parse(bodyFor(session.value!, text.value), { async: false, gfm: true }) as string),
)
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
  if (document.visibilityState === 'hidden') void flush()
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
})

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
    }
    return true
  }
  await flush()
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

const moodOpen = ref(false)
function setMood(v: number) {
  const m = meta.value
  if (!m) return
  if (m.mood === v) delete m.mood
  else m.mood = v
  metaDirty = true
  moodOpen.value = false
  void flush()
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

const moodItem = computed(() => MOODS.find((x) => x.v === meta.value?.mood))
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
        <h1>{{ title }}</h1>
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

      <div v-if="!readOnly" class="chips" role="toolbar" aria-label="日记信息">
        <button class="chip" :class="{ on: !!moodItem, placeholder: !moodItem }" :aria-expanded="moodOpen"
          @click="moodOpen = !moodOpen">
          <template v-if="moodItem">{{ moodItem.face }} {{ moodItem.label }}</template>
          <template v-else>心情</template>
        </button>
        <button class="chip" :class="{ on: !!meta.tags?.length, placeholder: !meta.tags?.length }"
          @click="openSheet('tags')">
          {{ meta.tags?.length ? meta.tags.map((t) => '#' + t).join(' ') : '标签' }}
        </button>
        <button class="chip" :class="{ on: !!(meta.people?.length || meta.places?.length), placeholder: !(meta.people?.length || meta.places?.length) }"
          @click="openSheet('more')">
          {{ [...(meta.people ?? []), ...(meta.places ?? [])].join('、') || '人物和地点' }}
        </button>
        <span v-if="weatherText" class="chip">{{ weatherText }}</span>
        <span v-if="meta.location?.name" class="chip">{{ meta.location.name }}</span>
      </div>

      <div v-if="moodOpen" class="moods" role="group" aria-label="选择心情">
        <button v-for="m in MOODS" :key="m.v" class="mood" :class="{ on: meta.mood === m.v }"
          :aria-pressed="meta.mood === m.v" @click="setMood(m.v)">
          <span class="face">{{ m.face }}</span>
          <span>{{ m.label }}</span>
        </button>
      </div>

      <main class="paper">
        <textarea v-show="mode === 'write'" ref="textarea" v-model="text" class="input prose" :readonly="readOnly"
          :placeholder="isToday ? '今天过得怎么样？' : '这一天发生了什么？'" aria-label="日记正文" @input="autosize" />
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-if="mode === 'read'" class="prose reading" v-html="rendered" />
      </main>
    </template>

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
.editor { min-height: 100vh; background: var(--paper); }
.titles { flex: 1; display: flex; flex-direction: column; margin-left: 4px; min-width: 0; }
.titles h1 { margin: 0; font-family: var(--serif); font-size: 19px; font-weight: 600; line-height: 1.25; }
.sub { font-size: 12px; color: var(--muted); }
.status { font-size: 12px; color: var(--faint); white-space: nowrap; }
.banner {
  margin: 4px 16px 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--surface);
  border-left: 3px solid var(--danger);
  font-size: 14px;
}
.chips {
  display: flex;
  gap: 8px;
  overflow-x: auto;
  padding: 4px 16px 10px;
  scrollbar-width: none;
}
.chips::-webkit-scrollbar { display: none; }
.chips .chip { max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
.moods { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; padding: 0 16px 12px; }
.mood {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 8px 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  font-size: 12px;
  color: var(--muted);
}
.mood .face { font-size: 24px; line-height: 1.2; }
.mood.on { border-color: var(--blue); background: var(--blue-soft); color: var(--blue); }
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

<script setup lang="ts">
/** 一份总结（规格 7.5、4.6）：查看、生成、手动编辑（编辑后自动锁定）、解锁后重新生成。 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { renderMarkdown } from '../markdown'
import { diaryChanged, index, repo, store } from '../../app'
import { summarize, summarizing } from '../../aiService'
import { isoLocal } from '../../core/time'
import { kindOf, readSummary, summaryStatus, writeSummary, type SummaryDoc, type SummaryStatus } from '../../core/summaries'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const period = String(route.params.period)
const isYear = kindOf(period) === 'yearly'
const title = isYear ? `${period} 年` : `${period.slice(0, 4)} 年 ${Number(period.slice(5))} 月`

const doc = ref<SummaryDoc | null>(null)
const status = ref<SummaryStatus>('missing')
const editing = ref(false)
const draft = ref('')
const err = ref('')

async function load() {
  doc.value = await readSummary(store, period)
  status.value = await summaryStatus(store, index, period)
}
onMounted(async () => {
  await load()
  if (route.query.generate === '1' && !doc.value) void gen()
})

const html = computed(() => (doc.value ? renderMarkdown(doc.value.body) : ''))
const busy = computed(() => summarizing.period === period)
const locked = computed(() => !!doc.value?.meta.locked)

async function gen() {
  err.value = ''
  try {
    await summarize(period)
  } catch (e) {
    err.value = (e as Error).message
  }
  await load()
}

function edit() {
  draft.value = doc.value?.body ?? ''
  editing.value = true
}

async function saveEdit() {
  const d: SummaryDoc = doc.value ?? { meta: { type: isYear ? 'yearly-summary' : 'monthly-summary', period }, body: '', extra: [] }
  d.body = draft.value
  d.meta.locked = true
  d.meta.edited_at = isoLocal(new Date())
  await writeSummary(repo, d)
  editing.value = false
  diaryChanged()
  await load()
}

async function setLocked(v: boolean) {
  if (!doc.value) return
  doc.value.meta.locked = v
  await writeSummary(repo, doc.value)
  diaryChanged()
  await load()
}

const STATUS: Record<SummaryStatus, string> = {
  missing: '还没有总结',
  fresh: '写好了',
  stale: '写好之后日记又改过，可以重写',
  locked: '已定稿：你改过它，不会被重写',
  'locked-stale': '已定稿。之后日记又改过；想重写，先点右上角的锁',
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>{{ title }}总结</h1>
      <button v-if="doc && !editing" class="icon-btn" :aria-label="locked ? '取消定稿' : '定稿'" @click="setLocked(!locked)">
        <Icon :name="locked ? 'lock' : 'unlock'" />
      </button>
    </header>

    <div class="body">
      <p class="status" :class="status">{{ doc && status === 'missing' ? '上次写出来是空的，再写一次吧' : STATUS[status] }}</p>
      <p v-if="doc?.meta.generated_at" class="meta">
        {{ doc.meta.model }} 写于 {{ doc.meta.generated_at.slice(0, 16).replace('T', ' ') }}，读了 {{ doc.meta.source_count }} {{ isYear ? '份月度总结' : '篇日记' }}
      </p>

      <template v-if="editing">
        <textarea v-model="draft" class="field ed prose" aria-label="总结内容" />
        <div class="row">
          <button class="solid-btn" @click="saveEdit">保存</button>
          <button class="text-btn" @click="editing = false">取消</button>
        </div>
        <p class="hint">保存后就算定稿，不会再被重写。</p>
      </template>
      <template v-else>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <article v-if="doc" class="prose" v-html="html" />
        <p v-if="busy" class="muted">{{ summarizing.message }}……</p>
        <p v-if="err" class="err">{{ err }}</p>
        <div class="row">
          <button v-if="!locked" class="solid-btn" :disabled="busy" @click="gen">{{ doc ? '重写' : '写总结' }}</button>
          <button class="text-btn" :disabled="busy" @click="edit">{{ doc ? '手动修改' : '自己写' }}</button>
        </div>
        <p v-if="locked" class="hint">想重写，先点右上角的锁取消定稿。</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.body { padding: 0 20px; }
.status { margin: 0 0 4px; font-size: 14px; font-weight: 700; color: var(--muted); }
.status.fresh { color: var(--m4); }
.status.stale, .status.locked-stale { color: var(--accent); }
.meta { margin: 0 0 16px; font-size: 12px; color: var(--faint); }
.ed { min-height: 55vh; padding: 12px; resize: vertical; line-height: 1.8; }
.row { display: flex; gap: 8px; margin-top: 16px; }
.hint { font-size: 12px; color: var(--faint); margin-top: 8px; }
.err { color: var(--danger); font-size: 14px; }
</style>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { renderMarkdown } from '../markdown'
import { index, indexVersion, store } from '../../app'
import { prefs } from '../../prefs'
import {
  asking, askQuestion, batch, chats, current, deleteConversation, ensureConsent, loadChats, merge, newConversation,
  pauseBatch, profileFor, startBatch, type ChatTurn,
} from '../../aiService'
import { summaryStatus, type SummaryStatus } from '../../core/summaries'
import type { ListField } from '../../core/types'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'

defineOptions({ name: 'AiView' })

const route = useRoute()
const router = useRouter()
type Tab = 'ask' | 'summary' | 'tidy'
const tab = computed<Tab>(() => (['ask', 'summary', 'tidy'].includes(route.query.tab as string) ? (route.query.tab as Tab) : 'ask'))
const setTab = (t: Tab) => router.replace({ query: { tab: t } })

const hasProfile = computed(() => prefs.ai.profiles.length > 0)
const stats = computed(() => {
  void indexVersion.value
  const all = index.all()
  return { count: all.length, first: all[all.length - 1]?.date, last: all[0]?.date }
})

// ---------- 问答 ----------

onMounted(() => void loadChats())
const conv = computed(() => current())
const q = ref('')
const input = ref<HTMLTextAreaElement | null>(null)
const log = ref<HTMLElement | null>(null)
const showHistory = ref(false)

const SUGGEST = ['过去一年我去过几次健身房？', '我最近一个月心情怎么样？', '这一年我和谁见面最多？', '帮我回顾一下上个月']

function render(md: string): string {
  const html = renderMarkdown(md)
  // 把日期变成可点开对应日记的链接
  return html.replace(/(^|[^\w/#-])(\d{4}-\d{2}-\d{2})(?![\w-])/g, (_, pre: string, d: string) =>
    index.get(d) ? `${pre}<a href="#/entry/${d}" class="dl">${d}</a>` : `${pre}${d}`,
  )
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
function usageText(t: ChatTurn): string {
  const u = t.usage
  const parts: string[] = []
  if (u?.input) parts.push(`调用模型 ${u.calls} 次，输入 ${k(u.input)}，输出 ${k(u.output)} tokens`)
  if (t.compacted) parts.push('内容太多，省略了部分较早的查询结果')
  return parts.join('；')
}

async function send(text = q.value) {
  if (!text.trim() || asking.busy) return
  q.value = ''
  const p = askQuestion(text)
  await nextTick()
  scrollDown()
  await p
  await nextTick()
  scrollDown()
}
function scrollDown() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
}
watch(() => asking.steps.length, () => nextTick(scrollDown))

function autosize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`
}

function openConv(id: string) {
  chats.currentId = id
  showHistory.value = false
}

// ---------- 总结 ----------

interface Row { period: string; label: string; status: SummaryStatus | '…' }
const years = ref<{ year: string; yearly: Row; months: Row[] }[]>([])
const STATUS: Record<string, string> = { missing: '还没有', fresh: '最新', stale: '源内容已变', locked: '已锁定', 'locked-stale': '已锁定，源内容已变', '…': '' }

async function loadSummaries() {
  const all = index.all()
  const byYear = new Map<string, Set<string>>()
  for (const r of all) {
    const y = r.date.slice(0, 4)
    if (!byYear.has(y)) byYear.set(y, new Set())
    byYear.get(y)!.add(r.date.slice(0, 7))
  }
  const out = [...byYear].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([year, ms]) => ({
    year,
    yearly: { period: year, label: `${year} 年全年`, status: '…' as Row['status'] },
    months: [...ms].sort().reverse().map((p) => ({ period: p, label: `${Number(p.slice(5))} 月`, status: '…' as Row['status'] })),
  }))
  years.value = out
  // 必须通过响应式代理修改，界面才会更新
  for (const y of years.value) {
    y.yearly.status = await summaryStatus(store, index, y.year)
    for (const m of y.months) m.status = await summaryStatus(store, index, m.period)
  }
}
watch([tab, indexVersion], ([t]) => t === 'summary' && void loadSummaries(), { immediate: true })

// ---------- 整理 ----------

const pending = computed(() => {
  void indexVersion.value
  return index.needsExtraction().length
})
async function runBatch() {
  if (!ensureConsent('extract')) return
  await startBatch()
}

const field = ref<ListField>('places')
const FIELD_LABEL: Record<ListField, string> = { places: '地点', people: '人物', tags: '标签' }
const selected = ref<string[]>([])
const values = computed(() => {
  void indexVersion.value
  return index.values(field.value)
})
watch(field, () => (selected.value = []))
const mergeMsg = ref('')
async function doMerge() {
  if (!selected.value.length) return
  const to = window.prompt(
    selected.value.length > 1 ? `把这 ${selected.value.length} 个写法合并成：` : `把“${selected.value[0]}”改名为：`,
    selected.value[0],
  )
  if (!to?.trim()) return
  const n = await merge(field.value, selected.value, to.trim())
  mergeMsg.value = `已改写 ${n} 篇日记`
  selected.value = []
}
function toggleSel(v: string) {
  const i = selected.value.indexOf(v)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(v)
}
</script>

<template>
  <div class="page ai" :class="{ asking: tab === 'ask' && hasProfile }">
    <header class="topbar">
      <h1>AI</h1>
      <template v-if="tab === 'ask' && hasProfile">
        <button class="icon-btn" aria-label="以前的对话" @click="showHistory = true"><Icon name="list" /></button>
        <button class="icon-btn" aria-label="新对话" :disabled="!conv" @click="newConversation"><Icon name="plus" /></button>
      </template>
    </header>

    <div v-if="hasProfile" class="tabs" role="tablist">
      <button v-for="t in ([['ask', '问答'], ['summary', '总结'], ['tidy', '整理']] as const)" :key="t[0]" role="tab"
        :aria-selected="tab === t[0]" :class="{ on: tab === t[0] }" @click="setTab(t[0])">{{ t[1] }}</button>
    </div>

    <!-- 还没配置 -->
    <div v-if="!hasProfile" class="wrap">
      <div class="orrery" aria-hidden="true">
        <span class="core"></span>
        <span class="ring r1"><i></i></span>
        <span class="ring r2"><i></i></span>
      </div>
      <p class="lead">先接上一个 AI 服务</p>
      <p class="muted center">
        之后可以直接问“过去一年去过几次某家饭店”“这几年都发生了什么”，也能让它帮你标注人物和地点、写月度和年度总结。
      </p>
      <div class="center"><router-link to="/settings/ai/new" class="solid-btn link-btn">添加 AI 服务</router-link></div>
      <p v-if="stats.count" class="muted small center">
        目前有 <span class="num">{{ stats.count }}</span> 篇日记，从 <span class="num">{{ stats.first }}</span> 到
        <span class="num">{{ stats.last }}</span>。
      </p>
    </div>

    <!-- 问答 -->
    <section v-else-if="tab === 'ask'" ref="log" class="chat">
      <div v-if="!conv && !asking.busy" class="hello">
        <p class="muted">用 {{ profileFor('chat')?.name }} 回答，查的是你手机上全部 {{ stats.count }} 篇日记。可以这样问：</p>
        <button v-for="s in SUGGEST" :key="s" class="chip sug" @click="send(s)">{{ s }}</button>
      </div>
      <article v-for="(t, i) in conv?.turns ?? []" :key="i" class="turn">
        <p class="q">{{ t.q }}</p>
        <ul v-if="t.steps.length" class="steps">
          <li v-for="(s, j) in t.steps" :key="j">{{ s.summary }}</li>
        </ul>
        <p v-if="t.error" class="err">没有回答成功：{{ t.error }}</p>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else class="prose a" v-html="render(t.a)" />
        <p v-if="usageText(t)" class="usage">{{ usageText(t) }}</p>
      </article>
      <article v-if="asking.busy" class="turn">
        <p class="q">{{ asking.question }}</p>
        <ul class="steps">
          <li v-for="(s, j) in asking.steps" :key="j">{{ s.summary }}</li>
          <li class="thinking">正在翻日记……</li>
        </ul>
      </article>
    </section>

    <!-- 总结 -->
    <section v-else-if="tab === 'summary'" class="sums">
      <p v-if="!years.length" class="muted pad">写了日记以后，这里会按月列出总结。</p>
      <div v-for="y in years" :key="y.year" class="year">
        <h2 class="num">{{ y.year }}</h2>
        <router-link :to="`/ai/summary/${y.year}`" class="srow yearly">
          <span>{{ y.yearly.label }}</span>
          <span class="st" :class="y.yearly.status">{{ STATUS[y.yearly.status] }}</span>
        </router-link>
        <router-link v-for="m in y.months" :key="m.period" :to="`/ai/summary/${m.period}`" class="srow">
          <span>{{ m.label }}</span>
          <span class="st" :class="m.status">{{ STATUS[m.status] }}</span>
        </router-link>
      </div>
    </section>

    <!-- 整理 -->
    <section v-else class="tidy">
      <div class="card">
        <h2>标注人物、地点和标签</h2>
        <p class="muted">
          AI 会读每篇日记，把去过的地方、提到的人和主题写进元数据，让“去过几次”这类问题数得更准。你手动改过的字段不会被覆盖。
        </p>
        <p v-if="batch.running" class="num-line">
          正在标注 <span class="num big">{{ batch.done }}</span> / <span class="num">{{ batch.total }}</span>
          <span v-if="batch.paused" class="muted">，正在停下</span>
        </p>
        <template v-else>
          <p class="num-line"><span class="num big">{{ pending }}</span> 篇还没标注，或标注后又改过</p>
          <p v-if="batch.done && !batch.paused" class="muted small">刚才标注了 {{ batch.done - batch.failed.length }} 篇。</p>
        </template>
        <div class="row">
          <button v-if="!batch.running" class="solid-btn" :disabled="!pending" @click="runBatch">开始标注</button>
          <button v-else class="text-btn" :disabled="batch.paused" @click="pauseBatch">暂停</button>
        </div>
        <p v-if="batch.paused && !batch.running && batch.done < batch.total" class="muted small">已暂停。随时可以继续，会从没做完的接着做。</p>
        <ul v-if="batch.failed.length" class="fails">
          <li v-for="f in batch.failed.slice(0, 5)" :key="f.date"><router-link :to="`/entry/${f.date}`" class="num">{{ f.date }}</router-link>：{{ f.error }}</li>
        </ul>
      </div>

      <div class="card">
        <h2>词表</h2>
        <p class="muted">同一个地方或人有几种写法时，选中它们合并成一个。只选一个可以改名。</p>
        <div class="seg">
          <button v-for="f in (['places', 'people', 'tags'] as ListField[])" :key="f" :class="{ on: field === f }" @click="field = f">{{ FIELD_LABEL[f] }}</button>
        </div>
        <p v-if="!values.length" class="muted small">还没有{{ FIELD_LABEL[field] }}。</p>
        <div class="vals">
          <button v-for="v in values" :key="v.value" class="chip" :class="{ on: selected.includes(v.value) }"
            :aria-pressed="selected.includes(v.value)" @click="toggleSel(v.value)">
            {{ v.value }}<span class="num cnt">{{ v.count }}</span>
          </button>
        </div>
        <div v-if="selected.length" class="row">
          <button class="solid-btn" @click="doMerge">{{ selected.length > 1 ? `合并这 ${selected.length} 个` : '改名' }}</button>
          <button class="text-btn" @click="selected = []">取消选择</button>
        </div>
        <p v-if="mergeMsg" class="small ok">{{ mergeMsg }}</p>
      </div>
    </section>

    <!-- 输入框 -->
    <form v-if="tab === 'ask' && hasProfile" class="composer" @submit.prevent="send()">
      <textarea ref="input" v-model="q" rows="1" placeholder="问问你的日记" aria-label="问题" enterkeyhint="send"
        @input="autosize" @keydown.enter.exact.prevent="send()" />
      <button class="icon-btn sendb" type="submit" aria-label="发送" :disabled="!q.trim() || asking.busy"><Icon name="send" /></button>
    </form>

    <Sheet :open="showHistory" title="以前的对话" @close="showHistory = false">
      <p v-if="!chats.list.length" class="muted">还没有对话。</p>
      <div v-for="c in chats.list" :key="c.id" class="hist">
        <button class="hist-open" @click="openConv(c.id)">
          <span>{{ c.title }}</span>
          <span class="muted small">{{ new Date(c.updatedAt).toLocaleDateString('zh-CN') }}，{{ c.turns.length }} 个问题</span>
        </button>
        <button class="icon-btn" aria-label="删除这个对话" @click="deleteConversation(c.id)"><Icon name="trash" /></button>
      </div>
    </Sheet>
  </div>
</template>

<style scoped>
.ai.asking { padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + 90px); }
.tabs { display: flex; gap: 6px; padding: 0 16px 10px; }
.tabs button, .seg button {
  min-height: 34px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 17px;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
}
.tabs button.on, .seg button.on { background: var(--ink); border-color: var(--ink); color: var(--bg); font-weight: 700; }
.wrap { padding: 8px 24px; }
.center { text-align: center; }
.orrery { position: relative; width: 150px; height: 150px; margin: 8px auto 20px; }
.core { position: absolute; left: 50%; top: 50%; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; background: var(--m3); box-shadow: 0 0 24px var(--m3); }
.ring { position: absolute; inset: 0; border: 1px dashed var(--faint); border-radius: 50%; animation: spin 18s linear infinite; }
.ring.r1 { inset: 34px; animation-duration: 9s; }
.ring i { position: absolute; top: -5px; left: 50%; width: 10px; height: 10px; margin-left: -5px; border-radius: 50%; background: var(--m5); box-shadow: 0 0 10px var(--m5); }
.ring.r1 i { width: 7px; height: 7px; top: -3.5px; margin-left: -3.5px; background: var(--m1); box-shadow: 0 0 8px var(--m1); }
@keyframes spin { to { transform: rotate(360deg); } }
.lead { font-size: 20px; font-weight: 800; margin: 0 0 8px; text-align: center; }
.link-btn { display: inline-flex; align-items: center; margin: 16px 0; text-decoration: none; }
.small { font-size: 13px; }
.chat { padding: 4px 20px 0; }
.hello { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.hello p { margin: 4px 0 6px; font-size: 14px; }
.sug { white-space: normal; text-align: left; height: auto; padding: 6px 14px; }
.turn { padding: 12px 0 8px; border-bottom: 1px solid var(--line); }
.q { margin: 0 0 8px; font-size: 17px; font-weight: 800; }
.steps { list-style: none; margin: 0 0 8px; padding: 0; font-size: 13px; color: var(--muted); }
.steps li { position: relative; padding-left: 16px; line-height: 1.7; }
.steps li::before { content: ''; position: absolute; left: 3px; top: 0.7em; width: 6px; height: 6px; border-radius: 50%; border: 1.2px solid var(--m2); }
.thinking { animation: blink 1.4s ease-in-out infinite; }
/* 查日记的每一步滑进来，回答浮上来 */
.steps li { animation: step-in 0.35s var(--ease-out) backwards; }
@keyframes step-in { from { opacity: 0; transform: translateX(-12px); } }
.turn .a, .turn .usage { animation: rise-in 0.45s var(--ease-out) backwards; }
.q { animation: rise-in 0.3s var(--ease-out) backwards; }
.hello .sug { animation: rise-in 0.4s var(--ease-out) backwards; }
.hello .sug:nth-of-type(2) { animation-delay: 0.05s; }
.hello .sug:nth-of-type(3) { animation-delay: 0.1s; }
.hello .sug:nth-of-type(4) { animation-delay: 0.15s; }
.sendb:not(:disabled) { animation: pop-in 0.3s var(--spring); }
@keyframes blink { 50% { opacity: 0.4; } }
.a { font-size: 16px; }
.a :deep(a.dl) { font-family: var(--num); font-size: 1.05em; font-weight: 600; text-decoration: none; padding: 0 3px; border-radius: 4px; background: var(--surface); border: 1px solid var(--line); color: var(--ink); }
.err { color: var(--danger); font-size: 14px; }
.usage { margin: 6px 0 0; font-size: 12px; color: var(--faint); }
.composer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--nav-h) + var(--safe-bottom));
  z-index: 25;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px 10px 8px 16px;
  background-color: var(--bg);
  background-image: var(--stars, none);
  background-attachment: fixed;
  border-top: 1px solid var(--line);
}
.composer textarea {
  flex: 1;
  min-height: 44px;
  max-height: 140px;
  padding: 10px 14px;
  border: 1.5px solid var(--line);
  border-radius: 22px;
  background: var(--surface);
  resize: none;
  font-size: 16px;
  line-height: 1.5;
}
.composer textarea:focus { outline: none; border-color: var(--m5); }
.sendb { background: var(--ink); color: var(--bg); }
.sendb:disabled { background: var(--line); color: var(--faint); }
.sums { padding: 0 0 20px; }
.pad { padding: 0 20px; }
.year h2 { margin: 14px 20px 4px; font-size: 26px; font-weight: 600; }
.srow { display: flex; justify-content: space-between; align-items: center; min-height: 50px; padding: 0 20px; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; }
.srow.yearly span:first-child { font-weight: 700; }
.st { font-size: 13px; color: var(--faint); }
.st.fresh { color: var(--m5); }
.st.stale, .st.locked-stale { color: var(--m2); }
.st.locked { color: var(--muted); }
.tidy { padding: 0 16px 20px; }
.card { margin-bottom: 14px; padding: 16px; border-radius: 20px; border: 1px solid var(--line); background: var(--surface); }
.card h2 { margin: 0 0 6px; font-size: 17px; font-weight: 800; }
.card .muted { margin: 0 0 10px; font-size: 14px; line-height: 1.6; }
.num-line { margin: 6px 0 12px; }
.num.big { font-size: 30px; font-weight: 600; }
.row { display: flex; gap: 8px; align-items: center; }
.fails { margin: 10px 0 0; padding-left: 18px; font-size: 13px; color: var(--danger); }
.fails a { color: inherit; }
.seg { display: flex; gap: 6px; margin-bottom: 12px; }
.vals { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; max-height: 40vh; overflow-y: auto; }
.cnt { margin-left: 2px; font-size: 13px; opacity: 0.6; }
.ok { color: var(--m5); font-weight: 600; }
.hist { display: flex; align-items: center; border-bottom: 1px solid var(--line); }
.hist-open { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 0; border: 0; background: transparent; text-align: left; }
</style>

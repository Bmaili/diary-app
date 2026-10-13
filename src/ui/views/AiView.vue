<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { renderMarkdown } from '../markdown'
import { index, indexVersion, store } from '../../app'
import { prefs } from '../../prefs'
import {
  asking, askQuestion, batch, chats, current, deleteConversation, ensureConsent, loadChats, merge, newConversation,
  pauseBatch, profileFor, startBatch, stopAsking, type ChatTurn,
} from '../../aiService'
import { summaryStatus, type SummaryStatus } from '../../core/summaries'
import type { ListField } from '../../core/types'
import Icon from '../components/Icon.vue'
import Sheet from '../components/Sheet.vue'
import AnswerChart from '../components/AnswerChart.vue'
import { splitAnswer, type GroupsChart } from '../../core/llm/charts'
import { Capacitor } from '@capacitor/core'
import { promptText } from '../dialog'

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
const showHistory = ref(false)

/** 还没接 AI 服务时的示例：每月和小雨出门的天数（虚构） */
const SAMPLE_CHART: GroupsChart = {
  type: 'groups', title: '今年和小雨出门的天数', group_by: 'month',
  series: [{
    label: '',
    groups: [1, 1, 0, 2, 1, 1, 2, 1, 4, 1].map((days, i) => ({ key: `2026-${String(i + 1).padStart(2, '0')}`, label: `${i + 1}月`, days, avg_mood: days ? 4 : null })),
  }],
}

/** 外部链接交给系统浏览器 */
function openLink(url: string) {
  if (Capacitor.isNativePlatform()) window.location.href = url
  else window.open(url, '_blank', 'noopener')
}

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
// 流式输出时跟着往下滚（已经在底部附近才跟，用户往上翻着看时不打扰）
watch(() => asking.partial.length, () => {
  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 160) nextTick(() => window.scrollTo({ top: document.body.scrollHeight }))
})

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
  if (!(await ensureConsent('extract'))) return
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
  const to = await promptText({
    title: selected.value.length > 1 ? `把这 ${selected.value.length} 个写法合并成` : `把“${selected.value[0]}”改名为`,
    value: selected.value[0],
    label: '新的写法',
  })
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

    <!-- 还没配置：一段示例问答，加上接 DeepSeek 的三步 -->
    <div v-if="!hasProfile" class="wrap">
      <section class="sample" aria-label="示例对话">
        <span class="sample-tag">示例</span>
        <p class="s-q">今年和小雨出去了几次？哪次最开心？</p>
        <div class="s-a">
          <p>今年有 <b class="num">14</b> 天写到和小雨一起出门，九月最多。心情最好的是 <span class="s-date">9 月 8 日</span>，你们去海边看了日出。</p>
          <AnswerChart :data="SAMPLE_CHART" kind="bar" class="s-chart" />
          <p class="s-note">次数由 app 在手机上数，不靠模型估。</p>
        </div>
      </section>

      <p class="lead">接上一个 AI 服务，就能这样问你的日记</p>
      <p class="muted center">还能标注人物和地点、写月度和年度总结。以 DeepSeek 为例，三步：</p>
      <ol class="steps3">
        <li><span class="sn num">1</span><span>在 <a href="#" @click.prevent="openLink('https://platform.deepseek.com')">DeepSeek 开放平台</a> 注册，先充一点钱（按用量付费）。</span></li>
        <li><span class="sn num">2</span><span>在“API Keys”里新建一个，复制下来。</span></li>
        <li><span class="sn num">3</span><span>点下面的按钮，粘贴 API Key，模型名照 DeepSeek 文档里写的填，点“测试”。</span></li>
      </ol>
      <div class="center"><router-link :to="{ path: '/settings/ai/new', query: { preset: 'DeepSeek' } }" class="solid-btn link-btn">添加 AI 服务</router-link></div>
      <p class="muted small center">也可以用通义千问、Kimi、智谱等。第一次把日记发给某个服务前会先问你。</p>
      <p v-if="stats.count" class="muted small center">
        目前有 <span class="num">{{ stats.count }}</span> 篇日记，从 <span class="num">{{ stats.first }}</span> 到
        <span class="num">{{ stats.last }}</span>。
      </p>
    </div>

    <!-- 问答 -->
    <section v-else-if="tab === 'ask'" class="chat">
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
        <div v-else-if="t.a" class="a">
          <template v-for="(p, k) in splitAnswer(t.a)" :key="k">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="'md' in p" class="prose" v-html="render(p.md)" />
            <AnswerChart v-else-if="t.charts?.[p.chart]" :data="t.charts[p.chart]" :kind="p.kind" />
          </template>
        </div>
        <p v-if="t.stopped" class="usage">你停止了这次回答</p>
        <p v-if="usageText(t)" class="usage">{{ usageText(t) }}</p>
      </article>
      <article v-if="asking.busy" class="turn">
        <p class="q">{{ asking.question }}</p>
        <ul class="steps">
          <li v-for="(s, j) in asking.steps" :key="j">{{ s.summary }}</li>
          <li v-if="!asking.partial" class="thinking">正在翻日记……</li>
        </ul>
        <div v-if="asking.partial" class="a live">
          <template v-for="(p, k) in splitAnswer(asking.partial)" :key="k">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="'md' in p" class="prose" v-html="render(k === splitAnswer(asking.partial).length - 1 ? p.md + '<span class=&quot;caret&quot;></span>' : p.md)" />
            <AnswerChart v-else-if="asking.charts[p.chart]" :data="asking.charts[p.chart]" :kind="p.kind" />
          </template>
        </div>
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
      <button v-if="asking.busy" class="icon-btn sendb stop" type="button" aria-label="停止" @click="stopAsking"><span class="sq"></span></button>
      <button v-else class="icon-btn sendb" type="submit" aria-label="发送" :disabled="!q.trim()"><Icon name="send" /></button>
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
.sample { position: relative; margin: 4px 0 22px; padding: 14px; border: 1px dashed var(--faint); border-radius: 16px; }
.sample-tag { display: inline-block; padding: 0 6px; border: 1px solid var(--faint); border-radius: 4px; font-size: 12px; color: var(--muted); }
.s-q { margin: 10px 0 0 36px; padding: 10px 14px; border-radius: 16px 16px 4px 16px; background: var(--ink); color: var(--bg); line-height: 1.6; }
.s-a { margin-top: 10px; line-height: 1.7; }
.s-a p { margin: 0; }
.s-date { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.s-chart { margin-top: 8px; pointer-events: none; }
/* 示例图表不能点：去掉“点柱子看数值”和“看数据” */
.s-chart :deep(.data), .s-chart :deep(.info) { display: none; }
.s-note { margin-top: 4px !important; font-size: 12px; color: var(--muted); }
.steps3 { list-style: none; margin: 14px 0 18px; padding: 0; display: flex; flex-direction: column; gap: 12px; line-height: 1.6; }
.steps3 li { display: flex; gap: 12px; align-items: flex-start; }
.steps3 .sn { flex: none; display: grid; place-items: center; width: 24px; height: 24px; margin-top: 1px; border: 1px solid var(--accent); border-radius: 50%; color: var(--accent); font-size: 13px; }
.steps3 a { color: var(--accent); }
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
.steps li::before { content: ''; position: absolute; left: 3px; top: 0.7em; width: 6px; height: 6px; border-radius: 50%; border: 1.2px solid var(--accent); }
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
/* 流式输出时末尾一个闪烁的光标 */
.a.live :deep(.caret) { display: inline-block; width: 7px; height: 1em; margin-left: 2px; vertical-align: -2px; border-radius: 2px; background: var(--accent); animation: blink 1s steps(2) infinite; }
.sendb.stop { background: var(--ink); color: var(--bg); animation: pop-in 0.3s var(--spring); }
.sq { width: 14px; height: 14px; border-radius: 3px; background: currentColor; }
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
  background-image: var(--paper, none);
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
.composer textarea:focus { outline: none; border-color: var(--accent); }
.sendb { background: var(--ink); color: var(--bg); }
.sendb:disabled { background: var(--line); color: var(--faint); }
.sums { padding: 0 0 20px; }
.pad { padding: 0 20px; }
.year h2 { margin: 14px 20px 4px; font-size: 26px; font-weight: 600; }
.srow { display: flex; justify-content: space-between; align-items: center; min-height: 50px; padding: 0 20px; border-bottom: 1px solid var(--line); color: inherit; text-decoration: none; }
.srow.yearly span:first-child { font-weight: 700; }
.st { font-size: 13px; color: var(--faint); }
.st.fresh { color: var(--m4); }
.st.stale, .st.locked-stale { color: var(--accent); }
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
.ok { color: var(--m4); font-weight: 600; }
.hist { display: flex; align-items: center; border-bottom: 1px solid var(--line); }
.hist-open { flex: 1; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 0; border: 0; background: transparent; text-align: left; }
</style>

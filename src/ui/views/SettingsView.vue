<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  diaryChanged, enqueue, index, indexProgress, indexVersion, reloadIndex, repo, setCutoffHour, setDevMode, settings, store, today,
} from '../../app'
import { listTrash } from '../../core/trash'
import { exportDiaryZip, zipFileName } from '../../core/exportZip'
import { generateTestEntries } from '../../core/testData'
import { README_MD } from '../../core/readme'
import { openExport } from '../../platform/exportShare'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import { prefs } from '../../prefs'
import { enabled, syncState, BACKENDS } from '../../syncService'
import { expectExternal } from '../../lockService'
import { SLOGAN } from '../../appInfo'
import { holidaySourceChanged, holidayStatus, refreshHolidays } from '../../holidayService'

const router = useRouter()
const busy = ref('')
const msg = ref<Record<string, string>>({})
const showReadme = ref(false)
const readmeHtml = computed(() => DOMPurify.sanitize(marked.parse(README_MD, { async: false }) as string))

const trashCount = ref(0)
onMounted(async () => (trashCount.value = (await listTrash(store)).length))

const stats = computed(() => {
  void indexVersion.value
  return { total: index.size, test: index.testRows().length, broken: index.brokenRows() }
})

async function run(key: string, fn: () => Promise<string>) {
  if (busy.value) return
  busy.value = key
  msg.value[key] = ''
  try {
    msg.value[key] = await fn()
  } catch (e) {
    msg.value[key] = `失败：${(e as Error).message}`
  } finally {
    busy.value = ''
  }
}

/** 导出进度：已打包的文件数 / 总数 */
const exportProgress = ref({ done: 0, total: 0 })
const doExport = () =>
  run('export', async () => {
    exportProgress.value = { done: 0, total: 0 }
    const target = await openExport(zipFileName())
    const r = await exportDiaryZip(repo, target.sink, (done, total) => (exportProgress.value = { done, total }))
    const done = expectExternal()
    try {
      await target.finish()
    } finally {
      done()
    }
    const size = r.bytes >= 1 << 20 ? `${(r.bytes / (1 << 20)).toFixed(1)} MB` : `${(r.bytes / 1024).toFixed(0)} KB`
    return `已打包 ${index.size} 篇日记、共 ${r.files} 个文件（${size}）`
  })

const doRebuild = () =>
  run('rebuild', async () => {
    const t0 = performance.now()
    await enqueue(() => reloadIndex(true))
    return `已从文件重建索引：${index.size} 篇，用时 ${Math.round(performance.now() - t0)} 毫秒`
  })

const genCount = ref(365)
const doGenerate = () =>
  run('gen', async () => {
    const n = await enqueue(() =>
      generateTestEntries(repo, { count: genCount.value, endDate: today(), seed: Date.now() % 100000 }),
    )
    await reloadIndex()
    return `生成了 ${n} 篇测试日记（已有日记的日子会跳过）`
  })

const doClearTest = () =>
  run('clear', async () => {
    const rows = index.testRows()
    if (!rows.length) return '没有测试日记'
    if (!window.confirm(`删除 ${rows.length} 篇测试日记？真实日记不受影响。`)) return ''
    await enqueue(async () => {
      for (const r of rows) await repo.deleteEntry(r.date)
    })
    await reloadIndex()
    diaryChanged()
    return `已删除 ${rows.length} 篇测试日记`
  })

let taps = 0
let tapTimer: ReturnType<typeof setTimeout> | undefined
function tapVersion() {
  taps++
  clearTimeout(tapTimer)
  tapTimer = setTimeout(() => (taps = 0), 1500)
  if (taps >= 5) {
    taps = 0
    void setDevMode(!settings.devMode)
  }
}

const hours = [0, 1, 2, 3, 4, 5, 6]
const DAILY_DESC = {
  local: '首页显示一句古诗词，按节日、节气和季节挑选，不联网。',
  online: '用“今日诗词”接口，按时间、天气推荐，内容更多。每天联网一次，会让对方知道你的大致位置（IP）；失败时用内置的。',
  off: '首页不显示诗词。',
} as const
const appVersion = __APP_VERSION__
const holidayDesc = computed(() => {
  const h = holidayStatus.value
  if (!prefs.calendar.holidayOnline) return '只用应用内置的放假安排（到 2026 年）。'
  if (h.busy) return '正在更新…'
  if (h.error) return `更新失败：${h.error}。先用${h.years.length ? '上次取到的' : '内置的'}数据。`
  if (!h.checkedAt) return '国务院公布新一年的放假安排后自动更新（数据来自开源项目 holiday-cn）。'
  const d = new Date(h.checkedAt)
  return `已有 ${h.years.join('、')} 年的安排，${d.getMonth() + 1} 月 ${d.getDate()} 日检查过。每隔几天自动检查一次。`
})
function toggleHoliday(v: boolean) {
  prefs.calendar.holidayOnline = v
  holidaySourceChanged()
}

const syncOn = computed(() => prefs.sync.oss.enabled || prefs.sync.github.enabled)
const syncLine = computed(() => {
  const on = enabled()
  if (!on.length) return '未开启'
  const names = BACKENDS.filter((b) => on.includes(b.id)).map((b) => b.label).join('、')
  const err = on.some((id) => syncState[id].status === 'error')
  return `${names}${err ? '，上次同步失败' : ''}`
})
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>设置</h1>
    </header>

    <p v-if="!syncOn" class="note warn">
      <strong>日记目前只存在这台手机上。</strong>
      卸载 app 或清除 app 数据会删掉全部日记。建议在下面的“同步与备份”里开启 OSS 或 GitHub。
    </p>

    <section>
      <h2>连接</h2>
      <router-link to="/settings/sync" class="item link">
        <div>
          <div>同步与备份</div>
          <div class="desc">{{ syncLine }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
      <router-link to="/settings/place" class="item link">
        <div>
          <div>位置与天气</div>
          <div class="desc">{{ prefs.place.autoLocate ? '写日记时自动记录位置和天气' : '自动定位已关闭' }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
      <router-link to="/settings/ai" class="item link">
        <div>
          <div>AI 服务</div>
          <div class="desc">{{ prefs.ai.profiles.length ? `已添加 ${prefs.ai.profiles.length} 个服务` : '还没有添加，问答、抽取和总结需要它' }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
    </section>

    <section>
      <h2>习惯与隐私</h2>
      <router-link to="/settings/reminder" class="item link">
        <div>
          <div>写日记提醒</div>
          <div class="desc">{{ prefs.reminder.enabled ? `每天 ${prefs.reminder.time}${prefs.reminder.skipWritten ? '，写过就跳过' : ''}` : '未开启' }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
      <router-link to="/settings/lock" class="item link">
        <div>
          <div>应用锁</div>
          <div class="desc">{{ prefs.lock.enabled ? 'PIN 已启用' : '未开启' }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
    </section>

    <section>
      <h2>日记</h2>
      <label class="item">
        <div>
          <div>一天从几点开始</div>
          <div class="desc">在这个时间之前写的，算作前一天的日记。</div>
        </div>
        <select class="field select" :value="settings.cutoffHour"
          @change="setCutoffHour(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="h in hours" :key="h" :value="h">凌晨 {{ h }}:00</option>
        </select>
      </label>
      <label class="item">
        <div>
          <div>每日诗词</div>
          <div class="desc">{{ DAILY_DESC[prefs.daily.mode] }}</div>
        </div>
        <select v-model="prefs.daily.mode" class="field select">
          <option value="local">内置诗词</option>
          <option value="online">今日诗词（联网）</option>
          <option value="off">不显示</option>
        </select>
      </label>
      <div class="item">
        <div>
          <div>节假日联网更新</div>
          <div class="desc">{{ holidayDesc }}<button v-if="prefs.calendar.holidayOnline && !holidayStatus.busy" class="link" @click="refreshHolidays(true)">现在更新</button></div>
        </div>
        <Switch :model-value="prefs.calendar.holidayOnline" label="节假日联网更新" @update:model-value="toggleHoliday" />
      </div>
      <div class="item">
        <div>
          <div>动态效果</div>
          <div class="desc">页面切换、列表浮现、日历跟手滑动、梅枝开花、飘落的花瓣。手机系统开了“减少动画”时会自动关掉。</div>
        </div>
        <Switch v-model="prefs.ui.motion" label="动态效果" />
      </div>
    </section>

    <section>
      <h2>数据</h2>
      <div class="item">
        <div>
          <div>导出为 zip</div>
          <div class="desc">整个日记文件夹，可以用 Obsidian、Typora 或任何文本编辑器打开。</div>
          <div v-if="msg.export" class="result">{{ msg.export }}</div>
        </div>
        <button class="text-btn" :disabled="!!busy" @click="doExport">
          {{ busy === 'export' ? (exportProgress.total ? `${exportProgress.done}/${exportProgress.total}` : '打包中') : '导出' }}
        </button>
      </div>
      <div class="item">
        <div>
          <div>重建索引</div>
          <div class="desc">列表、日历或搜索结果和文件对不上时使用。日记文件不会被改动。</div>
          <div v-if="msg.rebuild" class="result">{{ msg.rebuild }}</div>
        </div>
        <button class="text-btn" :disabled="!!busy" @click="doRebuild">
          {{ busy === 'rebuild' ? (indexProgress.total ? `${indexProgress.done}/${indexProgress.total}` : '重建中') : '重建' }}
        </button>
      </div>
      <router-link to="/settings/trash" class="item link">
        <div>
          <div>最近删除</div>
          <div class="desc">{{ trashCount ? `${trashCount} 篇，保留 30 天后彻底删除` : '删掉的日记会在这里保留 30 天' }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
      <button class="item link" :aria-expanded="showReadme" @click="showReadme = !showReadme">
        <div>
          <div>数据格式说明</div>
          <div class="desc">日记文件夹里 README.md 的内容。</div>
        </div>
        <Icon :name="showReadme ? 'close' : 'right'" class="chev" />
      </button>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="showReadme" class="prose readme" v-html="readmeHtml" />
      <div v-if="stats.broken.length" class="item broken">
        <div>
          <div>格式有误的文件</div>
          <div class="desc">这些文件的开头部分无法解析，app 只读不写。请用其他编辑器修正。</div>
          <ul>
            <li v-for="b in stats.broken" :key="b.date">
              <router-link :to="`/entry/${b.date}`">{{ b.path.replace(/^diary\//, '') }}</router-link>：{{ b.error }}
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section>
      <h2>后台运行</h2>
      <p class="desc pad">
        OPPO、vivo、一加的系统会清理后台的 app。这个 app 在你打开它、离开编辑页时同步，所以不开自启动也能正常备份。
        如果想让失败的同步在后台多重试几次，可以在系统设置的“应用管理 → 浮生记 → 耗电管理”里允许后台运行。
      </p>
    </section>

    <section v-if="settings.devMode">
      <h2>开发者选项</h2>
      <div class="item">
        <div>
          <div>生成测试日记</div>
          <div class="desc">从今天往前逐日生成，带 test_data 标记，可一键清除。开着同步时，测试日记也会被同步上去。</div>
          <div v-if="msg.gen" class="result">{{ msg.gen }}</div>
        </div>
        <div class="gen">
          <input v-model.number="genCount" type="number" min="1" max="5000" class="field num-in" aria-label="篇数" />
          <button class="text-btn" :disabled="!!busy" @click="doGenerate">{{ busy === 'gen' ? '生成中' : '生成' }}</button>
        </div>
      </div>
      <div class="item">
        <div>
          <div>清除测试日记</div>
          <div class="desc">目前有 {{ stats.test }} 篇。</div>
          <div v-if="msg.clear" class="result">{{ msg.clear }}</div>
        </div>
        <button class="text-btn danger" :disabled="!!busy || !stats.test" @click="doClearTest">清除</button>
      </div>
    </section>

    <section>
      <router-link to="/settings/about" class="item link">
        <div>
          <div>关于浮生记</div>
          <div class="desc">{{ SLOGAN }} · 版本 {{ appVersion }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
    </section>

    <p class="version" @click="tapVersion">浮生记 {{ appVersion }}，共 {{ stats.total }} 篇</p>
  </div>
</template>

<style scoped>
.select { width: auto; min-height: 38px; padding: 0 8px; }
.readme { margin: 0 20px; padding: 4px 0 12px; font-size: 14px; line-height: 1.7; }
.readme :deep(h1) { font-size: 16px; margin-top: 8px; }
.readme :deep(h2) { font-size: 15px; margin: 1.2em 0 0.4em; color: var(--ink); }
.broken ul { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.broken a { color: inherit; }
.gen { display: flex; align-items: center; gap: 4px; }
.num-in { width: 76px; min-height: 38px; padding: 0 8px; }
.danger { color: var(--danger); }
.version { margin: 32px 16px 0; text-align: center; font-size: 12px; color: var(--faint); user-select: none; }
</style>

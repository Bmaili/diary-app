<script setup lang="ts">
/** 从云端恢复（规格 6.6）：选来源 → 看看云端有什么 → 确认 → 下载 → 结果 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { indexProgress } from '../../app'
import { BACKENDS, canDecrypt, preview, restore, restoreState, type BackendId } from '../../syncService'
import type { RestorePreview } from '../../core/sync/restore'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()

const configured = (id: BackendId) =>
  id === 'oss' ? !!(prefs.sync.oss.endpoint && prefs.sync.oss.bucket) : !!(prefs.sync.github.owner && prefs.sync.github.repo)
const sources = computed(() => BACKENDS.filter((b) => configured(b.id)))
const from = ref<BackendId | ''>((route.query.from as BackendId) || '')
const pv = ref<RestorePreview | null>(null)
const pvError = ref('')
const loading = ref(false)
/** 云端加密且本机没有对应密钥时，需要输密码 */
const needPass = ref(false)
const pass = ref('')

async function choose(id: BackendId) {
  from.value = id
  pv.value = null
  pvError.value = ''
  loading.value = true
  try {
    pv.value = await preview(id)
    needPass.value = pv.value.encrypted && !(await canDecrypt(pv.value))
  } catch (e) {
    pvError.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
if (from.value) void choose(from.value)

async function go() {
  if (!from.value) return
  const r = await restore(from.value, needPass.value ? pass.value : undefined)
  if (r && !prefs.sync[from.value].enabled) prefs.sync[from.value].enabled = true
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>从云端恢复</h1>
    </header>

    <p class="note">
      本地还没有日记时，云端的内容会整体恢复过来。本地已有日记时，只补回本地没有的；同一天两边都有、内容不同的，保留手机上的，并在下面列出来。
    </p>

    <section v-if="!sources.length">
      <p class="desc pad">还没有设置 OSS 或 GitHub。先去“同步与备份”里填好连接信息。</p>
    </section>

    <section v-else>
      <h2>从哪里恢复</h2>
      <button v-for="b in sources" :key="b.id" class="item link" :disabled="restoreState.running" @click="choose(b.id)">
        <div>{{ b.label }}</div>
        <span v-if="from === b.id" class="state ok">已选</span>
      </button>
    </section>

    <section v-if="from">
      <p v-if="loading" class="desc pad">正在查看云端……</p>
      <p v-if="pvError" class="result bad pad">{{ pvError }}</p>
      <div v-if="pv" class="pad">
        <p v-if="!pv.hasFormat" class="result bad">云端没有 format.json，看起来不是这个 app 的日记文件夹，不能恢复。</p>
        <template v-else>
          <p>
            云端有 <strong class="num big">{{ pv.entries }}</strong> 篇日记<template v-if="pv.latest">，最新一篇是
              <strong class="num">{{ pv.latest }}</strong></template>，共 {{ pv.files }} 个文件。
          </p>
          <template v-if="pv.encrypted">
            <p class="desc">云端是加密的。{{ needPass ? '输入当时设置的同步加密密码才能恢复。' : '这台手机上已有对应的密钥。' }}</p>
            <input v-if="needPass" v-model="pass" class="field pass" type="password" autocomplete="off" aria-label="同步加密密码" placeholder="同步加密密码" />
          </template>
          <button v-if="!restoreState.result" class="solid-btn" :disabled="restoreState.running || (needPass && !pass)" @click="go">
            {{ restoreState.running ? (indexProgress.total ? `整理索引 ${indexProgress.done}/${indexProgress.total}` : restoreState.total ? `下载中 ${restoreState.done}/${restoreState.total}` : needPass ? '正在解开密钥…' : '连接中…') : '开始恢复' }}
          </button>
        </template>
      </div>
    </section>

    <section v-if="restoreState.error" class="pad">
      <p class="result bad">恢复失败：{{ restoreState.error }}。手机上的日记没有改动，可以稍后再试。</p>
    </section>

    <section v-if="restoreState.result" class="pad">
      <p class="result">
        恢复完成：补回 {{ restoreState.result.restored.length }} 个文件，{{ restoreState.result.identical }} 个本来就一样。
      </p>
      <template v-if="restoreState.result.skipped.length">
        <p class="desc">下面这些日期两边都有、内容不同，保留了手机上的版本（下次同步会覆盖云端）：</p>
        <ul class="skipped">
          <li v-for="p in restoreState.result.skipped" :key="p" class="num">{{ p.replace(/^entries\/\d{4}\//, '').replace(/\.md$/, '') }}</li>
        </ul>
      </template>
      <button class="solid-btn" style="margin-top: 12px" @click="router.replace('/')">回到日记</button>
    </section>
  </div>
</template>

<style scoped>
.big { font-size: 26px; }
.pass { margin: 4px 0 12px; }
.skipped { columns: 3; margin: 8px 0; padding-left: 18px; font-size: 15px; }
.pad p { line-height: 1.7; }
</style>

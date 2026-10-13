<script setup lang="ts">
/** 导入日记（规格 5.12）：浮生记导出的 zip，或者 Markdown / 纯文本文件 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { expectExternal } from '../../lockService'
import { chooseFiles, importState as st, resetImport, runImport } from '../../importService'

const router = useRouter()
const input = ref<HTMLInputElement | null>(null)

function pick() {
  if (st.phase === 'running' || st.phase === 'reading') return
  const done = expectExternal()
  const el = input.value
  if (!el) return
  el.value = ''
  el.onchange = () => {
    done()
    void chooseFiles(Array.from(el.files ?? []))
  }
  el.addEventListener('cancel', done, { once: true })
  el.click()
}

const plan = computed(() => st.plan)
const counts = computed(() => {
  const p = plan.value
  if (!p) return null
  const fresh = p.entries.filter((e) => e.local === 'none').length
  const differ = p.entries.filter((e) => e.local === 'differ').length
  const same = p.entries.filter((e) => e.local === 'same').length
  const dates = p.entries.map((e) => e.date)
  return {
    total: p.entries.length, fresh, differ, same,
    from: dates[0] ?? '', to: dates[dates.length - 1] ?? '',
    willWrite: fresh + (st.mode === 'append' ? differ : 0),
  }
})
const showUnrecognized = ref(false)

const size = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const dot = (d: string) => d.replace(/-0?/g, '.')
const kindLabel = computed(() => (plan.value?.kind === 'fusheng' ? '浮生记导出的日记' : 'Markdown / 文本文件'))
</script>

<template>
  <div class="settings import">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>导入日记</h1>
    </header>

    <p class="note">
      可以导入浮生记导出的 zip，也可以导入一个 Markdown 文件夹：先在手机的文件管理里把文件夹压缩成 zip；
      也可以直接多选 .md 或 .txt 文件（这样带不上图片）。日期从文件开头的 date、文件名或第一行标题里找。
    </p>

    <input ref="input" type="file" multiple class="hidden-input" aria-hidden="true" tabindex="-1" />

    <section v-if="st.phase === 'idle' || st.phase === 'reading'" class="pad">
      <button class="solid-btn wide" :disabled="st.phase === 'reading'" @click="pick">
        {{ st.phase === 'reading' ? '正在读取…' : '选择文件' }}
      </button>
      <p v-if="st.error" class="result bad">{{ st.error }}</p>
    </section>

    <template v-if="plan && counts && (st.phase === 'ready' || st.phase === 'running')">
      <section>
        <div class="item file">
          <Icon name="import" class="fi" />
          <div>
            <div class="fname">{{ st.fileLabel }}</div>
            <div class="desc"><span class="num">{{ size(st.fileSize) }}</span> · {{ kindLabel }}</div>
          </div>
          <button class="text-btn" :disabled="st.phase === 'running'" @click="resetImport(); pick()">换一个</button>
        </div>
      </section>

      <section>
        <h2>里面有</h2>
        <div class="item"><div>日记</div><span><span class="num">{{ counts.total }}</span> 篇</span></div>
        <div v-if="counts.total" class="item"><div>时间</div><span class="num">{{ dot(counts.from) }} – {{ dot(counts.to) }}</span></div>
        <div class="item">
          <div>图片<div v-if="plan.missingImages" class="desc">另有 {{ plan.missingImages }} 张找不到或格式不支持，链接原样保留</div></div>
          <span><span class="num">{{ plan.imageCount }}</span> 张</span>
        </div>
        <div v-if="counts.same" class="item"><div>和手机上一模一样</div><span><span class="num">{{ counts.same }}</span> 天，跳过</span></div>
        <div v-if="counts.differ" class="item"><div>手机上也有、内容不同</div><span><span class="num">{{ counts.differ }}</span> 天</span></div>
        <button v-if="plan.unrecognized.length" class="item link" :aria-expanded="showUnrecognized" @click="showUnrecognized = !showUnrecognized">
          <div>认不出日期的文件</div>
          <span><span class="num">{{ plan.unrecognized.length }}</span> 个，跳过</span>
          <Icon :name="showUnrecognized ? 'close' : 'right'" class="chev" />
        </button>
        <ul v-if="showUnrecognized" class="names">
          <li v-for="n in plan.unrecognized.slice(0, 50)" :key="n">{{ n }}</li>
          <li v-if="plan.unrecognized.length > 50" class="muted">……还有 {{ plan.unrecognized.length - 50 }} 个</li>
        </ul>
        <div v-if="plan.empty.length" class="item"><div>空白的文件</div><span><span class="num">{{ plan.empty.length }}</span> 个，跳过</span></div>
      </section>

      <section v-if="counts.differ">
        <h2>同一天两边都有时</h2>
        <label class="item opt">
          <input v-model="st.mode" type="radio" value="keep" :disabled="st.phase === 'running'" />
          <div>保留手机上的，导入的不要<div class="desc">导入完会列出是哪几天</div></div>
        </label>
        <label class="item opt">
          <input v-model="st.mode" type="radio" value="append" :disabled="st.phase === 'running'" />
          <div>把导入的内容接在后面<div class="desc">加一个“导入”小标题，原来的内容不动</div></div>
        </label>
      </section>

      <section class="pad">
        <p class="desc center">导入不会改动、覆盖手机上已有的日记。</p>
        <button class="solid-btn wide" :disabled="st.phase === 'running' || !counts.willWrite" @click="runImport">
          <template v-if="st.phase === 'running'">导入中 <span class="num">{{ st.done }}/{{ st.total }}</span></template>
          <template v-else-if="counts.willWrite">导入 <span class="num">{{ counts.willWrite }}</span> 篇</template>
          <template v-else>没有需要导入的</template>
        </button>
        <p v-if="st.error" class="result bad">导入中断：{{ st.error }}。已经导进去的日记都在，再点一次会接着导剩下的。</p>
      </section>
    </template>

    <section v-if="st.phase === 'done' && st.result" class="pad">
      <p class="result">
        导入完成：新增 <span class="num">{{ st.result.imported.length }}</span> 篇<template v-if="st.result.appended.length">，接在后面
          <span class="num">{{ st.result.appended.length }}</span> 篇</template><template v-if="st.result.images">，图片
          <span class="num">{{ st.result.images }}</span> 张</template>。
      </p>
      <template v-if="st.result.kept.length">
        <p class="desc">下面这些日子两边都有、内容不同，保留了手机上的：</p>
        <ul class="days">
          <li v-for="d in st.result.kept" :key="d"><router-link :to="`/entry/${d}`" class="num">{{ d }}</router-link></li>
        </ul>
      </template>
      <div class="acts">
        <button class="solid-btn" @click="resetImport(); router.replace('/')">回到日记</button>
        <button class="text-btn" @click="resetImport()">再导一个</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.hidden-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.wide { width: 100%; }
.file { gap: 12px; }
.fi { width: 26px; height: 26px; color: var(--muted); flex: none; }
.file > div { flex: 1; min-width: 0; }
.fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt { justify-content: flex-start; gap: 12px; }
.opt input { flex: none; width: 18px; height: 18px; margin: 3px 0 0; accent-color: var(--ink); align-self: flex-start; }
.names { margin: 0 20px 8px; padding-left: 18px; font-size: 14px; color: var(--muted); word-break: break-all; }
.days { columns: 3; margin: 8px 0; padding-left: 18px; font-size: 15px; }
.days a { color: var(--ink); text-underline-offset: 3px; }
.center { margin: 8px 0 12px; }
.center { text-align: center; }
.acts { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.pad .result { margin-top: 10px; }
</style>

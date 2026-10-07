<script setup lang="ts">
/**
 * 编辑一段系统提示词（2026-10-07 加入）。改动即时保存；和默认一样或清空就等于没改。
 * 程序依赖的部分（输出格式、今天的日期等）由代码接在后面，这里只读显示，改不坏功能。
 */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import { overrideFor, promptHash, PROMPTS, promptState, type PromptId } from '../../core/llm/prompts'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const id = String(route.params.pid) as PromptId
const def = PROMPTS[id]
if (!def) router.replace('/settings/ai')

const draft = ref(prefs.ai.prompts[id]?.text || def?.text || '')
const state = computed(() => promptState(id, prefs.ai.prompts))
const showDefault = ref(false)

function onInput() {
  prefs.ai.prompts[id] = overrideFor(id, draft.value, prefs.ai.prompts[id]?.base)
}

function reset() {
  if (state.value === 'default') return
  if (!window.confirm('恢复成默认的提示词？你改过的内容会丢掉。')) return
  prefs.ai.prompts[id] = null
  draft.value = def.text
  showDefault.value = false
}

/** 看过新的默认版本、决定保留自己的 */
function keepMine() {
  const o = prefs.ai.prompts[id]
  if (o) prefs.ai.prompts[id] = { ...o, base: promptHash(def.text) }
  showDefault.value = false
}
</script>

<template>
  <div v-if="def" class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>{{ def.label }}</h1>
      <button class="text-btn" :disabled="state === 'default'" @click="reset">恢复默认</button>
    </header>

    <p class="note">
      {{ def.desc }}这是发给 AI 的系统提示词，可以整段改：增删规则、换语气、调整字数。
      <strong class="st" :class="state">{{ state === 'default' ? '现在用的是默认版本。' : '你改过这段。' }}</strong>
    </p>

    <div v-if="state === 'custom-outdated'" class="outdated">
      <p>app 更新了这段的默认版本。你改过的版本不会自动变。</p>
      <div class="row">
        <button class="chip" @click="showDefault = !showDefault">{{ showDefault ? '收起新默认' : '看看新默认' }}</button>
        <button class="chip" @click="keepMine">保留我的</button>
      </div>
      <pre v-if="showDefault" class="fixed">{{ def.text }}</pre>
    </div>

    <div class="form">
      <textarea v-model="draft" class="field prompt" spellcheck="false" aria-label="系统提示词" @input="onInput" />
      <p class="hint">改动即时保存。清空或改回和默认一样，就等于用默认。</p>
    </div>

    <section>
      <h2>app 会自动接在后面（不能改）</h2>
      <div class="form">
        <pre class="fixed">{{ def.fixed }}</pre>
        <p class="hint">这部分是程序要用的（输出格式、今天的日期等），所以不放在上面，免得改坏功能。“给 AI 的补充说明”会接在最后。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.prompt { min-height: 46vh; padding: 12px; resize: vertical; font-size: 15px; line-height: 1.7; }
.fixed {
  margin: 0;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--line);
  color: var(--muted);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.st { display: inline; font-weight: 600; }
.st.custom, .st.custom-outdated { color: var(--accent); }
.outdated { margin: 0 16px 12px; padding: 10px 12px; border-radius: 14px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); font-size: 14px; }
.outdated p { margin: 0 0 8px; }
.outdated .row { display: flex; gap: 8px; margin-bottom: 8px; }
.hint { font-size: 12px; color: var(--faint); line-height: 1.5; }
</style>

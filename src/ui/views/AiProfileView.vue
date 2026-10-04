<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefs, savePrefsNow } from '../../prefs'
import { getSecret, setSecret } from '../../platform/secrets'
import { PRESETS, testConfig } from '../../core/llm/client'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const isNew = route.params.id === 'new'
const existing = prefs.ai.profiles.find((p) => p.id === route.params.id)

const f = reactive({
  id: existing?.id ?? `p${Date.now()}`,
  name: existing?.name ?? '',
  protocol: existing?.protocol ?? ('openai' as 'openai' | 'anthropic'),
  baseUrl: existing?.baseUrl ?? '',
  model: existing?.model ?? '',
  key: '',
})
const preset = ref('')
const hint = ref('')
const msg = ref('')
const bad = ref(false)
const testing = ref(false)

onMounted(async () => {
  if (existing) f.key = await getSecret(`llm.${existing.id}`)
})

function applyPreset() {
  const p = PRESETS.find((x) => x.name === preset.value)
  if (!p) return
  f.protocol = p.protocol
  f.baseUrl = p.baseUrl
  if (!f.name || PRESETS.some((x) => x.name === f.name)) f.name = p.name
  hint.value = p.hint
}

async function test() {
  testing.value = true
  msg.value = ''
  try {
    const r = await testConfig({ protocol: f.protocol, baseUrl: f.baseUrl.trim(), model: f.model.trim(), apiKey: f.key.trim() })
    bad.value = !r.toolCalling
    msg.value = r.toolCalling
      ? '连接成功，这个模型支持工具调用，可以用于问答、抽取和总结。'
      : '连上了，但这个模型没有调用工具，不能用于问答；抽取和总结仍可以用。'
  } catch (e) {
    bad.value = true
    msg.value = (e as Error).message
  } finally {
    testing.value = false
  }
}

async function save() {
  if (!f.name.trim() || !f.baseUrl.trim() || !f.model.trim()) {
    bad.value = true
    msg.value = '名称、接口地址和模型名都要填'
    return
  }
  const profile = { id: f.id, name: f.name.trim(), protocol: f.protocol, baseUrl: f.baseUrl.trim(), model: f.model.trim() }
  const i = prefs.ai.profiles.findIndex((p) => p.id === f.id)
  if (i >= 0) {
    // 换了服务地址，需要重新确认是否可以发送日记
    if (prefs.ai.profiles[i].baseUrl !== profile.baseUrl) prefs.ai.consented = prefs.ai.consented.filter((c) => c !== f.id)
    prefs.ai.profiles[i] = profile
  } else prefs.ai.profiles.push(profile)
  await setSecret(`llm.${f.id}`, f.key.trim())
  await savePrefsNow()
  if (window.history.state?.back) router.back()
  else router.replace('/settings/ai')
}

async function remove() {
  if (!window.confirm(`删除「${f.name}」？`)) return
  prefs.ai.profiles = prefs.ai.profiles.filter((p) => p.id !== f.id)
  for (const t of ['chat', 'extract', 'summary'] as const) if (prefs.ai.use[t] === f.id) prefs.ai.use[t] = ''
  await setSecret(`llm.${f.id}`, '')
  router.back()
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>{{ isNew ? '添加 AI 服务' : f.name }}</h1>
    </header>
    <div class="form">
      <label v-if="isNew">
        <span>从模板开始</span>
        <select v-model="preset" class="field" @change="applyPreset">
          <option value="">选择服务商……</option>
          <option v-for="p in PRESETS" :key="p.name" :value="p.name">{{ p.name }}</option>
        </select>
      </label>
      <label><span>名称</span><input v-model="f.name" class="field" placeholder="比如 DeepSeek" /></label>
      <label>
        <span>协议</span>
        <select v-model="f.protocol" class="field">
          <option value="openai">OpenAI 兼容</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </label>
      <label><span>接口地址</span><input v-model="f.baseUrl" class="field" placeholder="https://…/v1" autocapitalize="off" /></label>
      <label><span>模型名</span><input v-model="f.model" class="field" autocapitalize="off" /></label>
      <p v-if="hint" class="hint">{{ hint }}</p>
      <label><span>API Key</span><input v-model="f.key" class="field" type="password" autocomplete="off" /></label>
      <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
      <div class="row">
        <button class="text-btn" :disabled="testing" @click="test">{{ testing ? '测试中' : '测试' }}</button>
        <button class="solid-btn" @click="save">保存</button>
        <button v-if="!isNew" class="text-btn" style="color: var(--danger); margin-left: auto" @click="remove">删除</button>
      </div>
    </div>
  </div>
</template>

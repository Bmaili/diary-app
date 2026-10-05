<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefs, savePrefsNow, type LlmProfile } from '../../prefs'
import { getSecret, setSecret } from '../../platform/secrets'
import { DEFAULT_CONTEXT_TOKENS, PRESETS, parseExtraBody, testConfig } from '../../core/llm/client'
import { profileConfig } from '../../aiService'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'

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
  contextTokens: existing?.contextTokens != null ? String(existing.contextTokens) : '',
  maxOutput: existing?.maxOutput != null ? String(existing.maxOutput) : '',
  temperature: existing?.temperature != null ? String(existing.temperature) : '',
  timeoutSec: existing?.timeoutSec != null ? String(existing.timeoutSec) : '',
  extraBody: existing?.extraBody ?? '',
  stream: existing?.stream !== false,
})
const showAdv = ref(!!(existing && (existing.contextTokens || existing.maxOutput || existing.temperature != null || existing.timeoutSec || existing.extraBody)))

/** 高级设置：空着就是不设置；乱填的给出提示 */
function advanced(): Pick<LlmProfile, 'contextTokens' | 'maxOutput' | 'temperature' | 'timeoutSec' | 'extraBody'> {
  const num = (v: string, name: string, min: number, max: number, int = true) => {
    const t = v.trim()
    if (!t) return undefined
    const n = Number(t)
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw new Error(`${name}要在 ${min} 到 ${max} 之间`)
    return n
  }
  const out = {
    contextTokens: num(f.contextTokens, '上下文长度', 4000, 2000000),
    maxOutput: num(f.maxOutput, '最大输出', 100, 200000),
    temperature: num(f.temperature, '温度', 0, 2, false),
    timeoutSec: num(f.timeoutSec, '超时', 10, 900),
    extraBody: f.extraBody.trim() || undefined,
  }
  parseExtraBody(out.extraBody)
  return out
}
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
    const p = { id: f.id, name: f.name, protocol: f.protocol, baseUrl: f.baseUrl.trim(), model: f.model.trim(), ...advanced() }
    const r = await testConfig(profileConfig(p, f.key.trim()))
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
  let adv
  try {
    adv = advanced()
  } catch (e) {
    bad.value = true
    showAdv.value = true
    msg.value = (e as Error).message
    return
  }
  const profile: LlmProfile = { id: f.id, name: f.name.trim(), protocol: f.protocol, baseUrl: f.baseUrl.trim(), model: f.model.trim() }
  for (const [k, v] of Object.entries(adv)) if (v !== undefined) (profile as unknown as Record<string, unknown>)[k] = v
  if (!f.stream) profile.stream = false
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
      <button type="button" class="adv-toggle" :aria-expanded="showAdv" @click="showAdv = !showAdv">
        高级设置<span class="muted">（都可以不填）</span><Icon :name="showAdv ? 'close' : 'right'" class="chev" />
      </button>
      <template v-if="showAdv">
        <label>
          <span>上下文长度（tokens）</span>
          <input v-model="f.contextTokens" class="field" inputmode="numeric" :placeholder="`不填按 ${DEFAULT_CONTEXT_TOKENS}`" />
        </label>
        <p class="hint">模型一次能读多少内容，看服务商的模型说明。问答时据此控制发送量：快超出时先省略较早的查询结果。填小了只是查得保守一些，填大了可能报“超出上下文”。</p>
        <label>
          <span>最大输出（tokens）</span>
          <input v-model="f.maxOutput" class="field" inputmode="numeric" placeholder="不填按功能默认" />
        </label>
        <p class="hint">默认问答 2048，抽取 600，总结 2000–3000。用会“思考”的推理模型时，思考过程也算在输出里，回答被截断或抽取失败时把它调大，比如 8000。</p>
        <label>
          <span>温度</span>
          <input v-model="f.temperature" class="field" inputmode="decimal" placeholder="不填按功能默认" />
        </label>
        <p class="hint">默认抽取用 0，问答和总结用服务商的默认值。0 到 2，越低越稳定。有的推理模型只接受固定的温度（比如 1），报参数错误时在这里填上。填了以后三项功能都用这个值。</p>
        <label>
          <span>超时（秒）</span>
          <input v-model="f.timeoutSec" class="field" inputmode="numeric" placeholder="不填：120，总结 180" />
        </label>
        <div class="sw-row">
          <div>
            <div class="sw-title">问答流式输出</div>
            <p class="hint">回答边生成边显示。服务不支持时会自动改用普通方式，一般不用关。</p>
          </div>
          <Switch v-model="f.stream" label="问答流式输出" />
        </div>
        <label>
          <span>额外请求参数（JSON）</span>
          <textarea v-model="f.extraBody" class="field code" rows="3" autocapitalize="off" spellcheck="false"
            placeholder='比如 {"enable_thinking": false}' />
        </label>
        <p class="hint">原样合并进每次请求，用来开关服务商特有的功能，例如通义千问的 enable_thinking。不能覆盖 model、messages 等基本字段。</p>
      </template>
      <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
      <div class="row">
        <button class="text-btn" :disabled="testing" @click="test">{{ testing ? '测试中' : '测试' }}</button>
        <button class="solid-btn" @click="save">保存</button>
        <button v-if="!isNew" class="text-btn" style="color: var(--danger); margin-left: auto" @click="remove">删除</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.adv-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  margin-top: 18px;
  padding: 10px 0;
  border: 0;
  border-top: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
}
.adv-toggle .muted { font-weight: 400; font-size: 13px; }
.adv-toggle .chev { margin-left: auto; }
.sw-row { display: flex; align-items: center; gap: 12px; margin-top: 14px; }
.sw-title { font-size: 13px; font-weight: 600; color: var(--muted); }
.sw-row .hint { margin: 2px 0 0; }
.code { min-height: 64px; padding: 8px 12px; font-family: ui-monospace, monospace; font-size: 14px; resize: vertical; }
</style>

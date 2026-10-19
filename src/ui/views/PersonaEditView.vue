<script setup lang="ts">
/**
 * 添加、修改自己的人物（规格 7.3，2026-10-19 加入）。内置人物不能改，可以照着它新建一份再改。
 * 只填名字和说话的样子；例句可以不填。次数、引文、心情不好时只陪伴这几条由程序附加，怎么写都改不掉。
 */
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefs, savePrefsNow } from '../../prefs'
import { removePersona, savePersona, setPersona } from '../../aiService'
import { EXAMPLE_MAX, NAME_MAX, PERSONAS, sealOf, STYLE_MAX } from '../../core/llm/personas'
import Icon from '../components/Icon.vue'
import Seal from '../components/Seal.vue'
import { ask } from '../dialog'

const route = useRoute()
const router = useRouter()
const existing = prefs.ai.personas.find((p) => p.id === route.params.id)
const isNew = !existing

const f = reactive({
  id: existing?.id ?? `u${Date.now().toString(36)}`,
  name: existing?.name ?? '',
  style: existing?.style ?? '',
  example: existing?.example ?? '',
})
const from = ref('')
const msg = ref('')

/** 照着内置的人物改：把它的设定拿过来，名字前面加“我的” */
function copyFrom(id: string) {
  const p = PERSONAS.find((x) => x.id === id)
  if (!p) return
  from.value = id
  f.style = p.style
  f.example = p.example ?? ''
  if (!f.name.trim() || PERSONAS.some((x) => f.name === `我的${x.name}`)) f.name = `我的${p.name}`.slice(0, NAME_MAX)
}

const left = computed(() => STYLE_MAX - f.style.length)

function back() {
  if (window.history.state?.back) router.back()
  else router.replace('/ai')
}

async function save() {
  const saved = savePersona({ ...f })
  if (!saved) {
    msg.value = '名字和说话的样子都要写上'
    return
  }
  // 新添的人物直接换上
  if (isNew) await setPersona(saved.id)
  await savePrefsNow()
  back()
}

async function remove() {
  if (!(await ask({ title: `删去「${f.name}」？`, message: '以前和它的对话还留着，之后换回老友陪你聊。', ok: '删去', danger: true }))) return
  await removePersona(f.id)
  await savePrefsNow()
  back()
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="back"><Icon name="back" /></button>
      <h1>{{ isNew ? '添加人物' : f.name }}</h1>
    </header>
    <div class="form">
      <template v-if="isNew">
        <span class="lab">照着现成的改<span class="muted">（可以不选）</span></span>
        <div class="from">
          <button v-for="p in PERSONAS" :key="p.id" type="button" class="chip" :class="{ on: from === p.id }" :aria-pressed="from === p.id" @click="copyFrom(p.id)">
            {{ p.name }}
          </button>
        </div>
      </template>
      <label>
        <span>名字</span>
        <input v-model="f.name" class="field" :maxlength="NAME_MAX" placeholder="比如 外婆、学长、老板" />
      </label>
      <label>
        <span>说话的样子</span>
        <textarea v-model="f.style" class="field" rows="7" :maxlength="STYLE_MAX"
          placeholder="他是谁，和你什么关系，说话什么语气，有什么口头禅。比如：你是我外婆，叫我“乖乖”，说话慢，爱念叨我吃没吃饭、穿没穿暖，偶尔说几句老家话。" />
      </label>
      <p class="hint count" :class="{ low: left < 30 }">还能写 {{ left }} 个字</p>
      <label>
        <span>一句例句<span class="muted">（可以不填）</span></span>
        <input v-model="f.example" class="field" :maxlength="EXAMPLE_MAX" placeholder="他会怎么说话，比如：乖乖，今天吃饭了没有？" />
      </label>
      <p class="hint">不管怎么写，这几条都照旧：次数由手机一篇篇数，引用的原话会核对，心情不好的日子只陪着你，不开玩笑、不说教。</p>
      <div v-if="f.name.trim()" class="preview" aria-hidden="true">
        <Seal :text="sealOf(undefined, f.name)" :size="26" />
        <span>{{ f.example.trim() || '……' }}</span>
      </div>
      <p v-if="msg" class="result bad">{{ msg }}</p>
      <div class="row">
        <button class="solid-btn" @click="save">{{ isNew ? '添加并换上' : '保存' }}</button>
        <button v-if="!isNew" class="text-btn" style="color: var(--danger); margin-left: auto" @click="remove">删去</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lab { display: block; margin: 14px 0 8px; font-size: 13px; font-weight: 600; color: var(--muted); }
.from { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.count { text-align: right; margin-top: 4px; }
.count.low { color: var(--accent); }
.preview { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; padding: 12px; border: 1px dashed var(--line); border-radius: 14px; font-family: var(--kai); font-size: 16px; color: var(--muted); }
</style>

<script setup lang="ts">
/** 同步加密密码：第一次设置 / 修改 / 换手机后找回 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefs, savePrefsNow } from '../../prefs'
import {
  BACKENDS, changePassphrase, encState, loadKeys, recoverKeys, refreshPending, setupEncryption, syncNow, type BackendId,
} from '../../syncService'
import { checkPassphrase, generatePassphrase } from '../../core/sync/crypto'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
/** 设置好之后要为哪个后端打开加密 */
const then = route.query.then as BackendId | undefined
const recoverFrom = ref<BackendId | ''>((route.query.recover as BackendId) || '')

const recipient = ref('')
const mode = ref<'setup' | 'recover' | 'change' | 'view'>('setup')
onMounted(async () => {
  const k = await loadKeys()
  recipient.value = k?.recipient ?? ''
  mode.value = k ? 'view' : recoverFrom.value ? 'recover' : 'setup'
})

const pass = ref('')
const pass2 = ref('')
const show = ref(false)
const saved = ref(false)
const busy = ref(false)
const msg = ref('')
const bad = ref(false)

const configured = (id: BackendId) =>
  id === 'oss' ? !!(prefs.sync.oss.endpoint && prefs.sync.oss.bucket) : !!(prefs.sync.github.owner && prefs.sync.github.repo)
const sources = computed(() => BACKENDS.filter((b) => configured(b.id)))

function gen() {
  pass.value = pass2.value = generatePassphrase()
  show.value = true
}

function fail(m: string) {
  bad.value = true
  msg.value = m
}

async function submit() {
  msg.value = ''
  bad.value = false
  if (mode.value === 'recover') {
    if (!recoverFrom.value) return fail('选一个云端')
    busy.value = true
    try {
      await recoverKeys(recoverFrom.value, pass.value)
      prefs.sync[recoverFrom.value].encrypt = true
      await finish('密钥已找回。')
    } catch (e) {
      fail((e as Error).message)
    } finally {
      busy.value = false
    }
    return
  }
  const err = checkPassphrase(pass.value)
  if (err) return fail(err)
  if (pass.value !== pass2.value) return fail('两次输入的密码不一样')
  if (!saved.value) return fail('请先确认已经把密码保存好')
  busy.value = true
  try {
    if (mode.value === 'change') await changePassphrase(pass.value)
    else await setupEncryption(pass.value)
    if (then) prefs.sync[then].encrypt = true
    await finish(mode.value === 'change' ? '密码已修改，下次同步会更新云端的密钥文件。' : '加密密码已设置。')
  } catch (e) {
    fail((e as Error).message)
  } finally {
    busy.value = false
  }
}

async function finish(text: string) {
  await savePrefsNow()
  await refreshPending()
  void syncNow(true)
  recipient.value = (await loadKeys())?.recipient ?? ''
  pass.value = pass2.value = ''
  saved.value = false
  msg.value = text
  mode.value = 'view'
  if (then || route.query.recover) {
    if (window.history.state?.back) router.back()
    else router.replace('/settings/sync')
  }
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>加密密码</h1>
    </header>

    <div class="note">
      开了加密的后端，云端的每个文件都用 <a href="https://age-encryption.org" target="_blank" rel="noopener">age</a> 加密，文件名后面多一个 <code>.age</code>。
      阿里云、GitHub 或拿到你 AccessKey、Token 的人都看不到内容；文件名（日期）和大小仍然可见。
      <br />不用这个 app 也能解开：云端 <code>_encryption/README.md</code> 里写了电脑上怎么解密。
    </div>
    <div class="note warn">
      <strong>忘了密码，云端的备份就打不开了。</strong>
      手机上的日记不受影响，但换手机或重装后无法恢复。请把密码存进密码管理器，或者抄下来放好。
    </div>

    <div v-if="mode === 'view'" class="form">
      <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
      <p class="desc">已设置。公钥：<code class="key">{{ recipient }}</code></p>
      <div class="row">
        <button class="text-btn" @click="mode = 'change'; msg = ''">修改密码</button>
      </div>
      <p class="hint">修改密码不会重新加密日记，只会更新云端的 <code>_encryption/identity.age</code>。旧密码随即失效。</p>
    </div>

    <div v-else class="form">
      <div v-if="mode !== 'change'" class="tabs" role="tablist">
        <button role="tab" :aria-selected="mode === 'setup'" :class="{ on: mode === 'setup' }" @click="mode = 'setup'; msg = ''">第一次设置</button>
        <button role="tab" :aria-selected="mode === 'recover'" :class="{ on: mode === 'recover' }" @click="mode = 'recover'; msg = ''">在别的手机上设置过</button>
      </div>

      <template v-if="mode === 'recover'">
        <p class="hint">输入当时设置的加密密码，从云端取回密钥。</p>
        <label>
          <span>从哪个云端取回</span>
          <select v-model="recoverFrom" class="field">
            <option value="" disabled>选择……</option>
            <option v-for="b in sources" :key="b.id" :value="b.id">{{ b.label }}</option>
          </select>
        </label>
        <label><span>加密密码</span><input v-model="pass" class="field" type="password" autocomplete="off" aria-label="加密密码" /></label>
      </template>

      <template v-else>
        <label>
          <span>{{ mode === 'change' ? '新密码' : '密码' }}（至少 10 个字符）</span>
          <input v-model="pass" class="field" :type="show ? 'text' : 'password'" autocomplete="new-password" autocapitalize="off" aria-label="密码" />
        </label>
        <label><span>再输一次</span><input v-model="pass2" class="field" :type="show ? 'text' : 'password'" autocomplete="new-password" autocapitalize="off" aria-label="再输一次密码" /></label>
        <div class="row tight">
          <button class="text-btn" @click="gen">生成一个随机密码</button>
          <button class="text-btn" @click="show = !show">{{ show ? '隐藏' : '显示' }}</button>
        </div>
        <label class="check"><input v-model="saved" type="checkbox" /> 我已经把密码存进密码管理器或抄下来了</label>
      </template>

      <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
      <div class="row">
        <button v-if="mode === 'change'" class="text-btn" @click="mode = 'view'; msg = ''">取消</button>
        <button class="solid-btn" :disabled="busy" @click="submit">
          {{ busy ? '正在计算，需要几秒…' : mode === 'recover' ? '取回密钥' : mode === 'change' ? '修改' : '设置' }}
        </button>
      </div>
      <p v-if="then" class="hint">设置后会为{{ BACKENDS.find((b) => b.id === then)?.label }}打开加密，并把云端全部改成加密文件。</p>
    </div>

    <p v-if="encState.hasKeys || mode === 'view'" class="desc pad" style="margin-top: 20px">
      提醒：AI 问答、标注和总结仍会把相关日记以明文发给你选的 AI 服务，这一点不受云端加密影响。
    </p>
  </div>
</template>

<style scoped>
code { font-size: 0.9em; word-break: break-all; }
.key { font-size: 12px; }
.tabs { display: flex; gap: 6px; margin-top: 8px; }
.tabs button {
  flex: 1;
  min-height: 38px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: transparent;
  font-size: 14px;
}
.tabs button.on { background: var(--surface); border-color: var(--accent); font-weight: 700; }
.row.tight { margin-top: 8px; }
.check { display: flex !important; align-items: center; gap: 8px; margin-top: 16px; font-size: 14px; }
.check input { width: 18px; height: 18px; }
.note a { color: inherit; }
</style>

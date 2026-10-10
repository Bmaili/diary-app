<script setup lang="ts">
/** 导入导出设置（2026-10-10 加入）：选类别，用密码加密成一个文件；导入时输密码，所选类别整类覆盖 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import { PARTS, decryptBundle, encryptBundle, looksLikeBundle, settingsFileName, type PartId, type SettingsBundle } from '../../core/settingsBundle'
import { checkPassphrase, generatePassphrase } from '../../core/sync/crypto'
import { applyBundle, buildBundle, bundlePartSummary, partStatus } from '../../settingsTransfer'
import { openExport } from '../../platform/exportShare'
import { expectExternal } from '../../lockService'

const router = useRouter()
const mode = ref<'export' | 'import'>('export')
const busy = ref(false)
const msg = ref('')
const bad = ref(false)

function setMsg(text: string, isBad = false) {
  msg.value = text
  bad.value = isBad
}
function switchMode(m: 'export' | 'import') {
  mode.value = m
  setMsg('')
}

// ---------- 导出 ----------
const pick = reactive<Record<PartId, boolean>>({ ai: true, sync: true, place: true, misc: true })
const pass = ref('')
const pass2 = ref('')
const show = ref(false)
const picked = computed(() => PARTS.filter((p) => pick[p.id]).map((p) => p.id))

function gen() {
  pass.value = pass2.value = generatePassphrase()
  show.value = true
}

async function doExport() {
  setMsg('')
  if (!picked.value.length) return setMsg('至少选一项', true)
  const err = checkPassphrase(pass.value)
  if (err) return setMsg(err, true)
  if (pass.value !== pass2.value) return setMsg('两次输入的密码不一样', true)
  busy.value = true
  try {
    const bytes = await encryptBundle(await buildBundle(picked.value), pass.value)
    const name = settingsFileName()
    const target = await openExport(name, 'application/octet-stream', '保存或发送设置文件')
    await target.sink.write(bytes)
    const done = expectExternal()
    try {
      await target.finish()
    } finally {
      done()
    }
    setMsg(`已导出 ${picked.value.length} 类设置（${name}）。导入时要输入刚才的密码。`)
  } catch (e) {
    setMsg(`导出失败：${(e as Error).message}`, true)
  } finally {
    busy.value = false
  }
}

// ---------- 导入 ----------
const file = ref<{ name: string; bytes: Uint8Array } | null>(null)
const ipass = ref('')
const bundle = ref<SettingsBundle | null>(null)
const ipick = reactive<Record<PartId, boolean>>({ ai: true, sync: true, place: true, misc: true })
const todo = ref<string[]>([])
const inParts = computed(() => (bundle.value ? PARTS.filter((p) => bundle.value!.parts[p.id]) : []))

function chooseFile() {
  const input = document.createElement('input')
  input.type = 'file'
  const done = expectExternal()
  input.onchange = async () => {
    done()
    const f = input.files?.[0]
    if (!f) return
    const bytes = new Uint8Array(await f.arrayBuffer())
    bundle.value = null
    todo.value = []
    ipass.value = ''
    if (!looksLikeBundle(bytes)) {
      file.value = null
      return setMsg('这不是浮生记导出的设置文件', true)
    }
    file.value = { name: f.name, bytes }
    setMsg('')
  }
  input.addEventListener('cancel', done)
  input.click()
}

async function unlock() {
  if (!file.value) return
  if (!ipass.value) return setMsg('请输入导出时设置的密码', true)
  setMsg('')
  busy.value = true
  try {
    bundle.value = await decryptBundle(file.value.bytes, ipass.value)
    for (const p of PARTS) ipick[p.id] = !!bundle.value.parts[p.id]
  } catch (e) {
    setMsg((e as Error).message, true)
  } finally {
    busy.value = false
  }
}

const exportedAt = computed(() => {
  const b = bundle.value
  if (!b) return ''
  const d = new Date(b.exportedAt)
  const t = Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} `
  return `${t}导出，版本 ${b.appVersion}`
})

async function doImport() {
  const b = bundle.value
  if (!b) return
  const ids = inParts.value.filter((p) => ipick[p.id]).map((p) => p.id)
  if (!ids.length) return setMsg('至少选一项', true)
  const names = PARTS.filter((p) => ids.includes(p.id)).map((p) => p.label).join('、')
  if (!window.confirm(`用文件里的设置替换这台手机上的：${names}？\n\n日记不受影响。`)) return
  busy.value = true
  setMsg('')
  try {
    const r = await applyBundle(b, ids)
    todo.value = r.todo
    setMsg(`已导入：${names}`)
    bundle.value = null
    file.value = null
    ipass.value = ''
  } catch (e) {
    setMsg(`导入失败：${(e as Error).message}`, true)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>导入导出设置</h1>
    </header>

    <div class="note">
      换手机或重装时，用它把 AI、同步、位置等设置一次带过去，不用再一项项填。文件里<strong class="inline">不含日记</strong>（日记请用云端同步或“导出为 zip”），也不含应用锁。
    </div>

    <div class="form">
      <div class="tabs" role="tablist">
        <button role="tab" :aria-selected="mode === 'export'" :class="{ on: mode === 'export' }" @click="switchMode('export')">导出</button>
        <button role="tab" :aria-selected="mode === 'import'" :class="{ on: mode === 'import' }" @click="switchMode('import')">导入</button>
      </div>
    </div>

    <template v-if="mode === 'export'">
      <section>
        <h2>导出哪些</h2>
        <div v-for="p in PARTS" :key="p.id" class="item">
          <div>
            <div>{{ p.label }} <span class="status">{{ partStatus(p.id) }}</span></div>
            <div class="desc">{{ p.desc }}</div>
          </div>
          <Switch v-model="pick[p.id]" :label="p.label" />
        </div>
      </section>
      <div class="form">
        <label>
          <span>给文件设一个密码（至少 10 个字符）</span>
          <input v-model="pass" class="field" :type="show ? 'text' : 'password'" autocomplete="new-password" autocapitalize="off" aria-label="密码" />
        </label>
        <label><span>再输一次</span><input v-model="pass2" class="field" :type="show ? 'text' : 'password'" autocomplete="new-password" autocapitalize="off" aria-label="再输一次密码" /></label>
        <div class="row tight">
          <button class="text-btn" @click="gen">生成一个随机密码</button>
          <button class="text-btn" @click="show = !show">{{ show ? '隐藏' : '显示' }}</button>
        </div>
        <p class="hint">文件里有各种密钥，所以一定要加密。导入时要输入这个密码；忘了的话这个文件就打不开了，只能重新填写设置，日记不受影响。</p>
        <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
        <div class="row">
          <button class="solid-btn" :disabled="busy" @click="doExport">{{ busy ? '正在加密，需要几秒…' : '导出' }}</button>
        </div>
      </div>
    </template>

    <template v-else>
      <div v-if="!bundle" class="form">
        <div class="row">
          <button class="text-btn file-btn" :disabled="busy" @click="chooseFile">{{ file ? '换一个文件' : '选择设置文件' }}</button>
        </div>
        <p v-if="file" class="desc">已选择：{{ file.name }}</p>
        <template v-if="file">
          <label>
            <span>导出时设置的密码</span>
            <input v-model="ipass" class="field" type="password" autocomplete="off" autocapitalize="off" aria-label="导出时设置的密码" @keyup.enter="unlock" />
          </label>
        </template>
        <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
        <ul v-if="todo.length" class="todo">
          <li v-for="t in todo" :key="t">{{ t }}</li>
        </ul>
        <div v-if="file" class="row">
          <button class="solid-btn" :disabled="busy" @click="unlock">{{ busy ? '正在解密，需要几秒…' : '打开' }}</button>
        </div>
      </div>

      <template v-else>
        <p class="desc pad meta">{{ exportedAt }}。选择要导入的类别：</p>
        <section>
          <div v-for="p in inParts" :key="p.id" class="item">
            <div>
              <div>{{ p.label }}</div>
              <div class="desc">{{ bundlePartSummary(p.id, bundle.parts[p.id]!) }}</div>
            </div>
            <Switch v-model="ipick[p.id]" :label="p.label" />
          </div>
        </section>
        <div class="form">
          <p class="hint">选中的类别会整类换成文件里的内容（例如 AI 服务列表整个替换）。同步要你自己再打开一次开关：云端已有日记时，会先问你要不要恢复。</p>
          <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
          <div class="row">
            <button class="text-btn" :disabled="busy" @click="bundle = null; setMsg('')">取消</button>
            <button class="solid-btn" :disabled="busy" @click="doImport">导入</button>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
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
.status { margin-left: 6px; font-size: 12px; color: var(--faint); }
.note .inline { display: inline; }
.meta { margin-top: 16px; }
.file-btn { border: 1px solid var(--line); }
.todo { margin: 8px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.6; color: var(--muted); }
</style>

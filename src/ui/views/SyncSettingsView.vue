<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import {
  BACKENDS, canDecrypt, checkNow, encState, manifestEmpty, preview, refreshPending, syncNow, syncState, type BackendId,
} from '../../syncService'
import { hasSecret } from '../../platform/secrets'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'

const router = useRouter()
onMounted(() => void refreshPending())

const configured = (id: BackendId) =>
  id === 'oss'
    ? !!(prefs.sync.oss.endpoint && prefs.sync.oss.bucket && prefs.sync.oss.accessKeyId)
    : !!(prefs.sync.github.owner && prefs.sync.github.repo)

async function toggle(id: BackendId, on: boolean) {
  if (!on) {
    prefs.sync[id].enabled = false
    await refreshPending()
    return
  }
  const secretName = id === 'oss' ? 'oss.secret' : 'github.token'
  if (!configured(id) || !(await hasSecret(secretName))) {
    router.push(`/settings/sync/${id}`)
    return
  }
  // 首次启用且云端已有数据：先建议恢复（规格 6.6 第 5 条）
  if (await manifestEmpty(id)) {
    try {
      const p = await preview(id)
      if (p.entries > 0) {
        const goRestore = window.confirm(
          `云端已有 ${p.entries} 篇日记（最新 ${p.latest}）。\n\n建议先从云端恢复，再开启同步。点“确定”去恢复；点“取消”直接开启（同名日记以手机上的为准）。`,
        )
        if (goRestore) {
          router.push({ path: '/settings/restore', query: { from: id } })
          return
        }
        // 云端是加密的：继续加密同步，否则会把云端改回明文
        if (p.encrypted) {
          prefs.sync[id].encrypt = true
          if (!(await canDecrypt(p))) {
            window.alert('云端的日记是加密的。请先输入当时设置的加密密码。')
            router.push({ path: '/settings/sync/encryption', query: { recover: id } })
            return
          }
        }
      }
    } catch (e) {
      if (!window.confirm(`连不上${id === 'oss' ? ' OSS' : ' GitHub'}：${(e as Error).message}\n\n仍然开启吗？`)) return
    }
  }
  prefs.sync[id].enabled = true
  await refreshPending()
  void syncNow(true, [id])
}

/** 中文和英文之间加空格：“阿里云 OSS ”、“ GitHub ” */
const pad = (label: string) => label.replace(/^([A-Za-z])/, ' $1').replace(/([A-Za-z])$/, '$1 ')

async function toggleEncrypt(id: BackendId, on: boolean) {
  const label = pad(BACKENDS.find((b) => b.id === id)!.label)
  if (on) {
    const warn = id === 'github'
      ? 'GitHub 的提交历史里仍然保留着以前的明文。想彻底不留明文，建议新建一个仓库，在 GitHub 设置里改好仓库名后再打开加密。'
      : '如果 Bucket 开了版本控制，以前的明文会作为历史版本保留。想彻底清除，需要在 OSS 控制台删除历史版本。'
    if (!window.confirm(`为${label}打开加密？

云端的文件会全部换成加密版本，旧的明文文件会被删除。

${warn}`)) return
    if (!encState.hasKeys) {
      router.push({ path: '/settings/sync/encryption', query: { then: id } })
      return
    }
  } else if (!window.confirm(`关闭${label}的加密？

云端会全部换回明文文件，加密文件和 _encryption 文件夹会被删除。`)) return
  prefs.sync[id].encrypt = on
  await refreshPending()
  if (prefs.sync[id].enabled) void syncNow(true, [id])
}

function ago(t: number | null): string {
  if (!t) return '还没有核对过'
  const d = Math.floor((Date.now() - t) / 86400000)
  if (d >= 1) return `${d} 天前`
  const h = Math.floor((Date.now() - t) / 3600000)
  return h >= 1 ? `${h} 小时前` : '刚刚'
}

function checkText(id: BackendId): string {
  const c = syncState[id].check
  if (c.running) return '正在核对…'
  if (c.error) return `核对失败：${c.error}`
  const r = c.result
  if (!r) return ago(c.at)
  const fixes = r.missing.length + r.changed.length
  const parts = [`${ago(c.at)}核对`]
  parts.push(fixes ? `云端缺 ${r.missing.length} 个${r.changed.length ? `、${r.changed.length} 个和手机上不一致` : ''}，已重新上传` : '云端完整')
  if (r.removed.length) parts.push(`清理了 ${r.removed.length} 个旧文件`)
  return parts.join('，')
}

const onBackends = computed(() => BACKENDS.filter((b) => prefs.sync[b.id].enabled))
const anyOn = computed(() => prefs.sync.oss.enabled || prefs.sync.github.enabled)
const busy = computed(() => BACKENDS.some((b) => syncState[b.id].status === 'syncing'))

function stateText(id: BackendId): { cls: string; text: string } {
  const s = syncState[id]
  if (!prefs.sync[id].enabled) return { cls: '', text: configured(id) ? '已关闭' : '未设置' }
  if (s.status === 'syncing') return { cls: 'syncing', text: s.progress ? `同步中 ${s.progress.done}/${s.progress.total}` : '同步中' }
  if (s.status === 'error') {
    const wait = s.nextRetry ? Math.max(0, Math.round((s.nextRetry - Date.now()) / 1000)) : 0
    return { cls: 'error', text: `失败${wait ? `，${wait >= 60 ? Math.round(wait / 60) + ' 分钟' : wait + ' 秒'}后重试` : ''}` }
  }
  if (s.pending) return { cls: 'pending', text: `待同步 ${s.pending} 个文件` }
  return { cls: 'ok', text: s.lastOk ? `已同步，${new Date(s.lastOk).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '已同步' }
}

const QUIET = [
  { v: 0, label: '离开编辑页就传' },
  { v: 1, label: '1 分钟' },
  { v: 2, label: '2 分钟' },
  { v: 5, label: '5 分钟' },
  { v: 15, label: '15 分钟' },
  { v: 30, label: '30 分钟' },
]
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>同步与备份</h1>
    </header>

    <p v-if="!anyOn" class="note warn">
      <strong>还没有开启任何同步。</strong>
      日记只在这台手机上，卸载 app 或换手机就没了。开启一个就能自动备份到云端。
    </p>

    <section>
      <h2>同步到</h2>
      <div v-for="b in BACKENDS" :key="b.id" class="item">
        <div>
          <div>{{ b.label }}</div>
          <div class="state" :class="stateText(b.id).cls">{{ stateText(b.id).text }}</div>
          <div v-if="syncState[b.id].status === 'error'" class="desc bad-text">{{ syncState[b.id].error }}</div>
        </div>
        <button class="text-btn" @click="router.push(`/settings/sync/${b.id}`)">设置</button>
        <Switch :model-value="prefs.sync[b.id].enabled" :label="`同步到${b.label}`" @update:model-value="toggle(b.id, $event)" />
      </div>
      <p class="desc pad" style="margin-top: 8px">两个可以都开，互不影响；一个失败，另一个照常同步。</p>
    </section>

    <section>
      <h2>什么时候同步</h2>
      <div class="item">
        <div>
          <div>写完自动同步</div>
          <div class="desc">停笔一会儿、切到后台、打开 app 时，把改动传上去。</div>
        </div>
        <Switch v-model="prefs.sync.autoSync" label="写完自动同步" />
      </div>
      <template v-if="prefs.sync.autoSync">
        <label class="item">
          <div>
            <div>停笔多久后同步</div>
            <div class="desc">这段时间里再改会重新计时，反复修改只传一次。日记每秒都保存在手机上，晚传不会丢。</div>
          </div>
          <select v-model.number="prefs.sync.quietMin" class="field sel">
            <option v-for="o in QUIET" :key="o.v" :value="o.v">{{ o.label }}</option>
          </select>
        </label>
        <div class="item">
          <div>
            <div>切到后台时立即同步</div>
            <div class="desc">建议开着：app 在后台可能被系统清掉，等不到停笔计时结束。关掉的话，没传的改动会在下次打开 app 时传。</div>
          </div>
          <Switch v-model="prefs.sync.syncOnHide" label="切到后台时立即同步" />
        </div>
      </template>
      <div class="item">
        <div>
          <div>只在 Wi‑Fi 下自动同步</div>
          <div class="desc">手动点“立即同步”不受这个限制。</div>
        </div>
        <Switch v-model="prefs.sync.wifiOnly" label="只在 Wi-Fi 下自动同步" />
      </div>
      <div class="item">
        <div>
          <div>立即同步</div>
        </div>
        <button class="text-btn" :disabled="!anyOn || busy" @click="syncNow(true)">{{ busy ? '同步中' : '同步' }}</button>
      </div>
    </section>

    <section v-if="anyOn">
      <h2>核对云端</h2>
      <div v-for="b in onBackends" :key="b.id" class="item">
        <div>
          <div>{{ b.label }}</div>
          <div class="desc" :class="{ 'bad-text': !!syncState[b.id].check.error }">{{ checkText(b.id) }}</div>
        </div>
        <button class="text-btn" :disabled="syncState[b.id].check.running" @click="checkNow(b.id)">核对</button>
      </div>
      <p class="desc pad" style="margin-top: 8px">
        检查云端的文件是否还在、有没有被改过，缺了的自动补传。每周会自动核对一次。只看文件列表，不下载内容。
      </p>
    </section>

    <section>
      <h2>加密</h2>
      <router-link to="/settings/sync/encryption" class="item link">
        <div>
          <div>加密密码</div>
          <div class="desc">{{ encState.hasKeys ? '已设置' : '未设置' }}</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
      <div v-for="b in BACKENDS" :key="b.id" class="item">
        <div>
          <div>加密{{ pad(b.label) }}上的副本</div>
          <div class="desc">{{ prefs.sync[b.id].encrypt ? '云端只有加密文件' : '云端是明文，可以在网页上直接看' }}</div>
        </div>
        <Switch :model-value="prefs.sync[b.id].encrypt" :label="`加密${pad(b.label)}上的副本`" @update:model-value="toggleEncrypt(b.id, $event)" />
      </div>
      <p class="desc pad" style="margin-top: 8px">默认关闭。可以只加密其中一个，比如加密 GitHub、OSS 保持明文。</p>
    </section>

    <section>
      <h2>恢复</h2>
      <router-link to="/settings/restore" class="item link">
        <div>
          <div>从云端恢复</div>
          <div class="desc">换了手机或重装 app 后，把云端的日记拉回来。</div>
        </div>
        <Icon name="right" class="chev" />
      </router-link>
    </section>
  </div>
</template>

<style scoped>
.bad-text { color: var(--danger); }
.sel { width: auto; min-height: 38px; padding: 0 8px; }
</style>

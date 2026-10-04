<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { prefs } from '../../prefs'
import {
  BACKENDS, manifestEmpty, preview, refreshPending, syncNow, syncState, type BackendId,
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
  // 首次启用且云端已有数据：先建议恢复（规格 6.5 第 5 条）
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
      }
    } catch (e) {
      if (!window.confirm(`连不上${id === 'oss' ? ' OSS' : ' GitHub'}：${(e as Error).message}\n\n仍然开启吗？`)) return
    }
  }
  prefs.sync[id].enabled = true
  await refreshPending()
  void syncNow(true, [id])
}

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
          <div class="desc">离开编辑页、打开 app 时，把改动传上去。</div>
        </div>
        <Switch v-model="prefs.sync.autoSync" label="写完自动同步" />
      </div>
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
</style>

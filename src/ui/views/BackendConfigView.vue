<script setup lang="ts">
/** OSS / GitHub 的配置表单（规格 6.2、6.3）。密钥只存在本机加密存储。 */
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { prefs, savePrefsNow } from '../../prefs'
import { getSecret, setSecret } from '../../platform/secrets'
import { refreshPending, resetManifest, syncNow, type BackendId } from '../../syncService'
import { OssStore, regionOf } from '../../core/sync/oss'
import { GitHubStore } from '../../core/sync/github'
import Icon from '../components/Icon.vue'

const route = useRoute()
const router = useRouter()
const id = route.params.id as BackendId
const isOss = id === 'oss'

const oss = reactive({ ...prefs.sync.oss, secret: '' })
const gh = reactive({ ...prefs.sync.github, token: '' })
const msg = ref('')
const bad = ref(false)
const busy = ref(false)

onMounted(async () => {
  if (isOss) oss.secret = await getSecret('oss.secret')
  else gh.token = await getSecret('github.token')
})

function build() {
  if (isOss) {
    const endpoint = oss.endpoint.trim()
    regionOf(endpoint)
    return new OssStore({ endpoint, bucket: oss.bucket.trim(), prefix: oss.prefix, accessKeyId: oss.accessKeyId.trim(), accessKeySecret: oss.secret.trim() })
  }
  return new GitHubStore({ owner: gh.owner.trim(), repo: gh.repo.trim(), branch: gh.branch.trim() || 'main', token: gh.token.trim(), apiBase: gh.apiBase.trim(), prefix: gh.prefix })
}

async function test() {
  busy.value = true
  msg.value = ''
  try {
    await build().test()
    msg.value = isOss ? '连接成功：写入并删除了一个临时文件。' : '连接成功：Token 能读写这个仓库。'
    bad.value = false
  } catch (e) {
    msg.value = (e as Error).message
    bad.value = true
  } finally {
    busy.value = false
  }
}

async function save() {
  try {
    build()
  } catch (e) {
    msg.value = (e as Error).message
    bad.value = true
    return
  }
  const before = JSON.stringify(prefs.sync[id])
  if (isOss) {
    const { secret, ...rest } = oss
    Object.assign(prefs.sync.oss, { ...rest, enabled: prefs.sync.oss.enabled })
    await setSecret('oss.secret', secret.trim())
  } else {
    const { token, ...rest } = gh
    Object.assign(prefs.sync.github, { ...rest, enabled: prefs.sync.github.enabled })
    await setSecret('github.token', token.trim())
  }
  // 换了存储位置：清单作废，下次全量上传
  const after = JSON.stringify({ ...prefs.sync[id], enabled: JSON.parse(before).enabled })
  if (before !== after) await resetManifest(id)
  await savePrefsNow()
  await refreshPending()
  if (prefs.sync[id].enabled) void syncNow(true, [id])
  if (window.history.state?.back === '/settings/sync') router.back()
  else router.replace('/settings/sync')
}
</script>

<template>
  <div class="settings">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>{{ isOss ? '阿里云 OSS' : 'GitHub 私有仓库' }}</h1>
    </header>

    <div v-if="isOss" class="form">
      <p class="note">
        建议新建一个 RAM 子账号，只给它这个 Bucket 这个前缀的读写权限；Bucket 设为私有；并在 OSS 控制台打开<strong style="display: inline">版本控制</strong>，误删后能找回。
      </p>
      <label><span>Endpoint</span><input v-model="oss.endpoint" class="field" placeholder="oss-cn-hangzhou.aliyuncs.com" autocapitalize="off" /></label>
      <p class="hint">在 Bucket 概览页的“访问端口”里，用外网访问的那个。</p>
      <label><span>Bucket</span><input v-model="oss.bucket" class="field" placeholder="my-diary" autocapitalize="off" /></label>
      <label><span>路径前缀</span><input v-model="oss.prefix" class="field" placeholder="diary/" autocapitalize="off" /></label>
      <label><span>AccessKey ID</span><input v-model="oss.accessKeyId" class="field" autocapitalize="off" autocomplete="off" /></label>
      <label><span>AccessKey Secret</span><input v-model="oss.secret" class="field" type="password" autocomplete="off" /></label>
    </div>

    <div v-else class="form">
      <p class="note">
        在 GitHub 设置里创建一个 Fine-grained token，只选这个仓库，权限给 Contents 读写。仓库请设为私有。大陆网络访问 GitHub 不稳定时，可以填自建的反向代理地址。
      </p>
      <label><span>用户名或组织</span><input v-model="gh.owner" class="field" placeholder="your-name" autocapitalize="off" /></label>
      <label><span>仓库名</span><input v-model="gh.repo" class="field" placeholder="diary" autocapitalize="off" /></label>
      <label><span>分支</span><input v-model="gh.branch" class="field" placeholder="main" autocapitalize="off" /></label>
      <label><span>Token</span><input v-model="gh.token" class="field" type="password" autocomplete="off" placeholder="github_pat_…" /></label>
      <label><span>仓库内的文件夹（可留空）</span><input v-model="gh.prefix" class="field" placeholder="留空表示放在仓库根目录" autocapitalize="off" /></label>
      <label><span>API 地址</span><input v-model="gh.apiBase" class="field" autocapitalize="off" /></label>
    </div>

    <div class="form">
      <p v-if="msg" class="result" :class="{ bad }">{{ msg }}</p>
      <div class="row">
        <button class="text-btn" :disabled="busy" @click="test">{{ busy ? '测试中' : '测试连接' }}</button>
        <button class="solid-btn" @click="save">保存</button>
      </div>
      <p class="hint">换了 Bucket、前缀或仓库后，下次同步会把全部日记重新上传一遍。</p>
    </div>
  </div>
</template>

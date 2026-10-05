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
import HelpTip from '../components/HelpTip.vue'

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
      <HelpTip title="阿里云 OSS 配置教程" label="阿里云 OSS 的配置教程">
        <ol>
          <li><b>建 Bucket</b>：打开 OSS 控制台 <code>oss.console.aliyun.com</code> → Bucket 列表 → 创建 Bucket。地域选离你近的；读写权限选 <b>私有</b>；建议打开 <b>版本控制</b>（误删、被覆盖后能找回旧版本）。</li>
          <li><b>建子账号</b>：打开 RAM 访问控制 <code>ram.console.aliyun.com</code> → 用户 → 创建用户，访问方式勾选 <b>使用永久 AccessKey 访问</b>（OpenAPI 调用访问）。创建后马上复制 AccessKey ID 和 Secret，Secret 只显示这一次。</li>
          <li><b>给子账号授权</b>：最省事是在用户的“权限管理”里添加系统策略 <code>AliyunOSSFullAccess</code>。更安全的做法是自定义一条只允许这个 Bucket 的策略（把 my-diary 换成你的 Bucket 名）：
            <pre>{"Version": "1", "Statement": [{
  "Effect": "Allow",
  "Action": ["oss:PutObject", "oss:GetObject",
             "oss:DeleteObject", "oss:ListObjects"],
  "Resource": ["acs:oss:*:*:my-diary",
               "acs:oss:*:*:my-diary/*"]
}]}</pre>
          </li>
          <li><b>找 Endpoint</b>：Bucket 概览页 → 访问端口 → <b>外网访问</b> 那一行的 Endpoint（地域节点），例如 <code>oss-cn-hangzhou.aliyuncs.com</code>。不要带 Bucket 名，也不要带 https://。</li>
          <li>填好后点“测试连接”：会写入并删除一个临时文件。成功后回到上一页打开开关。</li>
        </ol>
        <p class="tip">路径前缀是 Bucket 里放日记的文件夹，默认 diary/。日记很小，存储和流量费用通常每月几分钱。</p>
      </HelpTip>
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
      <HelpTip title="GitHub 配置教程" label="GitHub 的配置教程">
        <ol>
          <li><b>建仓库</b>：打开 <code>github.com/new</code>，起个名字（比如 diary），选 <b>Private</b>，其他都不用勾，空仓库就行。</li>
          <li><b>建 Token</b>：头像 → Settings → 最底下 Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token。
            <ul>
              <li>Expiration（有效期）：可以选最长；到期后同步会报“token 不对”，换一个新的填进来就行。</li>
              <li>Repository access：选 <b>Only select repositories</b>，只选刚建的仓库。</li>
              <li>Permissions → Repository permissions → <b>Contents</b> 设为 <b>Read and write</b>，其他保持默认。</li>
            </ul>
            生成后马上复制，离开页面就看不到了。
          </li>
          <li><b>用户名或组织</b>和<b>仓库名</b>：就是仓库地址 <code>github.com/用户名/仓库名</code> 里的两段。</li>
          <li>填好后点“测试连接”，成功后回到上一页打开开关。每次同步是一个 commit，在 GitHub 网页上能直接看日记。</li>
        </ol>
        <p class="tip">国内访问 GitHub 不稳定，失败会自动重试，不影响 OSS。也可以在“API 地址”里填你自建的反向代理。仓库是私有的，但 GitHub 能看到明文，介意的话可以在同步设置里打开加密。</p>
      </HelpTip>
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

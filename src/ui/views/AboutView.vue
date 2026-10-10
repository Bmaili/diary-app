<script setup lang="ts">
/** 关于：应用名、slogan、版本、代码仓库、联系作者、开源许可与致谢 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import Icon from '../components/Icon.vue'
import Switch from '../components/Switch.vue'
import icon from '../../assets/app-icon.webp'
import { APP_NAME, AUTHOR_EMAIL, CREDITS, LICENSE_NAME, REPO_URL, SLOGAN } from '../../appInfo'
import { prefs } from '../../prefs'
import { formatSize } from '../../core/update'
import {
  cancelDownload, checkUpdate, dismissUpdate, hasUpdate, installUpdate, openReleasePage, showBadge, startDownload, updateState,
} from '../../updateService'

const router = useRouter()
const version = __APP_VERSION__
const u = updateState

/** 点过“暂不”后收起；点“查看”再展开 */
const reopened = ref(false)
const showCard = computed(() => hasUpdate.value && (showBadge.value || reopened.value || u.phase !== 'idle'))

const updateLine = computed(() => {
  if (u.checking) return '正在检查…'
  if (u.error) return `检查失败：${u.error}`
  if (hasUpdate.value) return showCard.value ? `发现新版本 ${u.latest!.version}` : `新版本 ${u.latest!.version} 已选择暂不更新`
  if (u.lastCheck) {
    const d = new Date(u.lastCheck)
    return `已是最新版本 · ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 检查过`
  }
  return '覆盖安装新版本，日记不会丢'
})

const percent = computed(() => (u.total ? Math.min(100, Math.round((u.done / u.total) * 100)) : 0))

function later() {
  dismissUpdate()
  reopened.value = false
}

/** 外部链接：真机上交给系统（浏览器、邮件 app）打开，浏览器调试时开新标签页 */
function open(url: string) {
  if (Capacitor.isNativePlatform()) window.location.href = url
  else window.open(url, '_blank', 'noopener')
}
</script>

<template>
  <div class="settings about">
    <header class="topbar">
      <button class="icon-btn" aria-label="返回" @click="router.back()"><Icon name="back" /></button>
      <h1>关于</h1>
    </header>

    <div class="hero">
      <img :src="icon" alt="" class="logo" width="88" height="88" />
      <div class="name">{{ APP_NAME }}</div>
      <p class="slogan">{{ SLOGAN }}</p>
      <p class="ver">版本 <span class="num">{{ version }}</span></p>
    </div>

    <div class="intro">
      <p class="lead">岁月不居，时节如流。</p>
      <p>一日之喜忧，一路之晴雨，一面之故人，<br />落笔数字，便可长存。</p>
      <p>此册只藏于你的手机之中，无需注册，旁人不得见；<br />云端寄存、AI 回顾，皆可随心取舍。</p>
    </div>

    <section>
      <div class="item">
        <div>
          <div>检查更新<span v-if="showBadge" class="dot" aria-label="有新版本" /></div>
          <div class="desc" :class="{ bad: !!u.error }">
            {{ updateLine }}<button v-if="hasUpdate && !showCard" class="link" @click="reopened = true">查看</button>
          </div>
        </div>
        <button class="text-btn" :disabled="u.checking || u.phase !== 'idle'" @click="checkUpdate(true)">{{ u.checking ? '检查中' : '检查' }}</button>
      </div>
      <div v-if="showCard && u.latest" class="upd">
        <div class="upd-head">
          <span>新版本 <span class="num">{{ u.latest.version }}</span></span>
          <span v-if="u.latest.apk?.size" class="size num">{{ formatSize(u.latest.apk.size) }}</span>
        </div>
        <div class="notes">{{ u.latest.notes || '这一版没有写更新说明。' }}</div>
        <template v-if="u.phase === 'downloading'">
          <div class="bar" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><i :style="{ width: `${percent}%` }" /></div>
          <div class="upd-row">
            <span class="desc num">正在下载 {{ formatSize(u.done) }} / {{ formatSize(u.total) }}</span>
            <button class="text-btn" @click="cancelDownload">取消</button>
          </div>
        </template>
        <div v-else class="upd-row end">
          <template v-if="u.phase === 'ready'">
            <button class="solid-btn" @click="installUpdate()">安装</button>
          </template>
          <template v-else>
            <button class="text-btn" @click="later">暂不</button>
            <button class="solid-btn" @click="startDownload">更新</button>
          </template>
        </div>
        <p v-if="u.note" class="upd-note">{{ u.note }}</p>
        <p class="upd-foot">覆盖安装，日记不会丢。应用内下载不了时，可以<button class="link" @click="openReleasePage">在浏览器里下载</button>。</p>
      </div>
      <div class="item">
        <div>
          <div>自动检查更新</div>
          <div class="desc">每天最多检查一次。有新版本时只在设置里显示一个小红点，不会弹窗。</div>
        </div>
        <Switch v-model="prefs.update.auto" label="自动检查更新" />
      </div>
      <button class="item link" @click="open(REPO_URL)">
        <div>
          <div>代码仓库</div>
          <div class="desc url">{{ REPO_URL.replace('https://', '') }}</div>
        </div>
        <Icon name="right" class="chev" />
      </button>
      <button class="item link" @click="open(`mailto:${AUTHOR_EMAIL}?subject=${encodeURIComponent(APP_NAME + ' 反馈')}`)">
        <div>
          <div>联系作者</div>
          <div class="desc url">{{ AUTHOR_EMAIL }}</div>
        </div>
        <Icon name="right" class="chev" />
      </button>
      <div class="item">
        <div>
          <div>开源许可</div>
          <div class="desc">{{ LICENSE_NAME }} 许可证：可以自由使用、修改和分发，保留版权声明即可。全部代码由 AI 编写。</div>
        </div>
      </div>
    </section>

    <section>
      <h2>致谢</h2>
      <button v-for="c in CREDITS" :key="c.name" class="item link credit" @click="open(c.url)">
        <div>
          <div>{{ c.name }}</div>
          <div class="desc">{{ c.note }}</div>
        </div>
        <Icon name="right" class="chev" />
      </button>
    </section>

    <p class="foot">浮生若梦，为欢几何 —— 李白</p>
  </div>
</template>

<style scoped>
.hero { display: flex; flex-direction: column; align-items: center; padding: 12px 20px 8px; text-align: center; }
.logo { width: 88px; height: 88px; border-radius: 22px; box-shadow: 0 6px 18px -8px rgba(0, 0, 0, 0.35); }
.name { margin-top: 14px; font-family: var(--serif); font-size: 28px; font-weight: 700; letter-spacing: 0.12em; }
.slogan { margin: 10px 0 0; font-family: var(--kai); font-size: 18px; letter-spacing: 0.2em; color: var(--muted); }
.ver { margin: 8px 0 0; font-size: 12px; color: var(--faint); }
.intro { margin: 16px 24px 8px; font-size: 14px; line-height: 1.9; color: var(--muted); text-align: center; }
.intro p { margin: 0 0 4px; }
.intro .lead { margin-bottom: 8px; font-family: var(--kai); font-size: 17px; letter-spacing: 0.12em; color: var(--ink); }
.dot { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--accent); vertical-align: 0.45em; }
.desc.bad { color: var(--danger); }
.upd { margin: 0 16px 4px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.upd-head { display: flex; justify-content: space-between; align-items: baseline; font-weight: 700; }
.upd-head .size { font-size: 12px; font-weight: 400; color: var(--faint); }
.notes { margin-top: 8px; max-height: 40vh; overflow-y: auto; font-size: 14px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.notes::first-line { font-weight: 600; }
.bar { height: 6px; margin-top: 14px; border-radius: 3px; background: var(--line); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--m4); transition: width 0.2s linear; }
.upd-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 12px; }
.upd-row.end { justify-content: flex-end; }
.upd-row .solid-btn { min-height: 42px; }
.upd-note { margin: 10px 0 0; font-size: 13px; font-weight: 600; line-height: 1.6; }
.upd-foot { margin: 10px 0 0; font-size: 12px; color: var(--faint); line-height: 1.6; }
.upd-foot .link, .desc .link { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; text-decoration: underline; text-underline-offset: 2px; }
.desc .link { margin-left: 6px; }
.url { word-break: break-all; }
.credit { min-height: 52px; }
.foot { margin: 28px 16px 40px; text-align: center; font-family: var(--kai); font-size: 13px; color: var(--faint); }
</style>

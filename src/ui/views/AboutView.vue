<script setup lang="ts">
/** 关于：应用名、slogan、版本、代码仓库、联系作者、开源许可与致谢 */
import { useRouter } from 'vue-router'
import { Capacitor } from '@capacitor/core'
import Icon from '../components/Icon.vue'
import icon from '../../assets/app-icon.webp'
import { APP_NAME, AUTHOR_EMAIL, CREDITS, LICENSE_NAME, RELEASES_URL, REPO_URL, SLOGAN } from '../../appInfo'

const router = useRouter()
const version = __APP_VERSION__

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

    <p class="intro">
      一个把日记存成普通 Markdown 文件的安卓日记本。日记只在你的手机上，云端同步和 AI 都由你自己选择、自己配置；
      离开这个 app，任何 Markdown 工具都能读你的日记。
    </p>

    <section>
      <button class="item link" @click="open(RELEASES_URL)">
        <div>
          <div>检查更新</div>
          <div class="desc">在 GitHub Releases 下载最新版本，覆盖安装即可，日记不会丢</div>
        </div>
        <Icon name="right" class="chev" />
      </button>
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
.intro { margin: 12px 20px 8px; font-size: 14px; line-height: 1.8; color: var(--muted); }
.url { word-break: break-all; }
.credit { min-height: 52px; }
.foot { margin: 28px 16px 40px; text-align: center; font-family: var(--kai); font-size: 13px; color: var(--faint); }
</style>

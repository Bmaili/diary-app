<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { loadError, ready, start } from '../app'
import Icon from './components/Icon.vue'
import LockScreen from './components/LockScreen.vue'
import { lock } from '../lockService'
import { initLaunch } from '../launchService'

const route = useRoute()
const router = useRouter()
const tab = computed(() => route.meta.tab as string | undefined)

/** 首页上偶尔飘落的梅花瓣：位置和节奏按序号算，每次都一样 */
const petals = Array.from({ length: 7 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1
  return {
    left: `${(5 + r(1) * 90).toFixed(1)}%`,
    d: `${(16 + r(3) * 14).toFixed(1)}s`,
    delay: `${(-r(4) * 30).toFixed(1)}s`,
    s: (0.7 + r(2) * 0.6).toFixed(2),
    sway: `${Math.round(30 + r(5) * 60)}px`,
  }
})
const tabIndex = computed(() => Math.max(0, tabs.findIndex((t) => t.key === tab.value)))

const tabs = [
  { key: 'home', path: '/', label: '日记', icon: 'book' },
  { key: 'calendar', path: '/calendar', label: '日历', icon: 'calendar' },
  { key: 'search', path: '/search', label: '搜索', icon: 'search' },
  { key: 'ai', path: '/ai', label: 'AI', icon: 'brush' },
]

onMounted(() => {
  start()
    .then(() => initLaunch(router))
    .catch(() => {})
  if (Capacitor.isNativePlatform()) {
    // 安卓返回键：首页退出 app，其他页面返回上一页
    CapApp.addListener('backButton', () => {
      if (lock.locked || route.path === '/') CapApp.exitApp()
      else if (tab.value) router.replace('/')
      else router.back()
    })
  }
})
</script>

<template>
  <div v-if="loadError" class="boot">
    <p>打开日记文件夹失败：{{ loadError }}</p>
  </div>
  <div v-else-if="!ready" class="boot" aria-busy="true">
    <p class="muted">正在读取日记…</p>
  </div>
  <template v-else>
    <div v-if="tab === 'home'" class="petals" aria-hidden="true">
      <i v-for="(p, i) in petals" :key="i" :style="{ left: p.left, '--d': p.d, '--delay': p.delay, '--s': p.s, '--sway': p.sway }"></i>
    </div>
    <div class="shell" :inert="lock.locked || undefined">
    <router-view v-slot="{ Component }">
      <keep-alive :include="['HomeView', 'CalendarView', 'SearchView', 'AiView']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <nav v-if="tab" class="nav" aria-label="主导航">
      <span class="nav-ind" :style="{ transform: `translateX(${tabIndex * 100}%)` }" aria-hidden="true"><i></i></span>
      <router-link v-for="t in tabs" :key="t.key" :to="t.path" replace class="nav-item"
        :class="{ active: tab === t.key }" :aria-current="tab === t.key ? 'page' : undefined">
        <Icon :name="t.icon" />
        <span>{{ t.label }}</span>
      </router-link>
    </nav>
    </div>
    <LockScreen v-if="lock.locked" />
  </template>
</template>

<style scoped>
.shell { display: contents; }
.boot {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  text-align: center;
}
.nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  height: calc(var(--nav-h) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  background-color: var(--bg);
  background-image: var(--paper, none);
  border-top: 1px solid var(--line);
  view-transition-name: nav;
}
/* 当前标签下面的小亮点，切换时弹性地滑过去 */
.nav-ind {
  position: absolute;
  left: 0;
  bottom: calc(var(--safe-bottom) + 6px);
  width: 25%;
  display: flex;
  justify-content: center;
  pointer-events: none;
  transition: transform 0.45s var(--spring);
}
.nav-ind i {
  width: 16px;
  height: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.nav-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--faint);
  text-decoration: none;
  font-size: 12px;
}
.nav-item svg { width: 22px; height: 22px; }
.nav-item svg { transition: transform 0.35s var(--spring); }
.nav-item { padding-bottom: 6px; transition: color 0.2s; }
.nav-item.active { color: var(--ink); }
.nav-item.active svg { stroke-width: 2; transform: translateY(-2px) scale(1.12); }
.nav-item:active svg { transform: scale(0.85); }
.nav-item.active span { font-weight: 700; }
</style>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { App as CapApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { loadError, ready, start } from '../app'
import Icon from './components/Icon.vue'
import LockScreen from './components/LockScreen.vue'
import { lock } from '../lockService'

const route = useRoute()
const router = useRouter()
const tab = computed(() => route.meta.tab as string | undefined)

const tabs = [
  { key: 'home', path: '/', label: '日记', icon: 'book' },
  { key: 'calendar', path: '/calendar', label: '日历', icon: 'moon' },
  { key: 'search', path: '/search', label: '搜索', icon: 'telescope' },
  { key: 'ai', path: '/ai', label: 'AI', icon: 'orbit' },
]

onMounted(() => {
  start().catch(() => {})
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
    <div class="shell" :inert="lock.locked || undefined">
    <router-view v-slot="{ Component }">
      <keep-alive :include="['HomeView', 'CalendarView', 'SearchView', 'AiView']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
    <nav v-if="tab" class="nav" aria-label="主导航">
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
  background-image: var(--stars, none);
  background-attachment: fixed;
  border-top: 1px solid var(--line);
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
.nav-item svg { transition: transform 0.2s; }
.nav-item.active { color: var(--ink); }
.nav-item.active svg { stroke-width: 2; transform: translateY(-1px); }
.nav-item.active span { font-weight: 700; }
.nav-item.active::after {
  content: '';
  width: 4px;
  height: 4px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--m3);
  box-shadow: 0 0 6px var(--m3);
}
</style>

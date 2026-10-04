import { createRouter, createWebHashHistory } from 'vue-router'
import Home from './views/HomeView.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: Home, meta: { tab: 'home' } },
    { path: '/calendar', component: () => import('./views/CalendarView.vue'), meta: { tab: 'calendar' } },
    { path: '/search', component: () => import('./views/SearchView.vue'), meta: { tab: 'search' } },
    { path: '/ai', component: () => import('./views/AiView.vue'), meta: { tab: 'ai' } },
    { path: '/settings', component: () => import('./views/SettingsView.vue') },
    { path: '/entry/:date', component: () => import('./views/EditorView.vue') },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})

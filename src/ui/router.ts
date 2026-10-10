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
    { path: '/settings/sync', component: () => import('./views/SyncSettingsView.vue') },
    { path: '/settings/sync/encryption', component: () => import('./views/EncryptionView.vue') },
    { path: '/settings/sync/:id(oss|github)', component: () => import('./views/BackendConfigView.vue') },
    { path: '/settings/place', component: () => import('./views/PlaceSettingsView.vue') },
    { path: '/settings/ai', component: () => import('./views/AiSettingsView.vue') },
    { path: '/settings/ai/prompt/:pid', component: () => import('./views/PromptView.vue') },
    { path: '/settings/ai/:id', component: () => import('./views/AiProfileView.vue') },
    { path: '/ai/summary/:period', component: () => import('./views/SummaryView.vue') },
    { path: '/settings/reminder', component: () => import('./views/ReminderSettingsView.vue') },
    { path: '/settings/lock', component: () => import('./views/LockSettingsView.vue') },
    { path: '/settings/about', component: () => import('./views/AboutView.vue') },
    { path: '/settings/trash', component: () => import('./views/TrashView.vue') },
    { path: '/settings/transfer', component: () => import('./views/SettingsTransferView.vue') },
    { path: '/settings/restore', component: () => import('./views/RestoreView.vue') },
    { path: '/entry/:date', component: () => import('./views/EditorView.vue') },
  ],
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 }
  },
})

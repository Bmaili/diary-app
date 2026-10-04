import { createApp } from 'vue'
import App from './ui/App.vue'
import { router } from './ui/router'
import './ui/style.css'
import './ui/settings.css'
import { initSync } from './syncService'
import { initLock } from './lockService'
import { initReminder } from './reminderService'
import { applyMotionClass, installTransitions } from './ui/motion'
import { prefs } from './prefs'
import { watch } from 'vue'

initSync()
initLock()
initReminder()

installTransitions(router)
watch(() => prefs.ui.motion, applyMotionClass, { immediate: true })
window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', applyMotionClass)

createApp(App).use(router).mount('#app')

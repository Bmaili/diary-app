import { createApp } from 'vue'
import App from './ui/App.vue'
import { router } from './ui/router'
import './ui/style.css'
import './ui/settings.css'
import { initSync } from './syncService'
import { initLock } from './lockService'
import { initReminder } from './reminderService'

initSync()
initLock()
initReminder()

createApp(App).use(router).mount('#app')

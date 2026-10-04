import { createApp } from 'vue'
import App from './ui/App.vue'
import { router } from './ui/router'
import './ui/style.css'
import './ui/settings.css'
import { initSync } from './syncService'

initSync()

createApp(App).use(router).mount('#app')

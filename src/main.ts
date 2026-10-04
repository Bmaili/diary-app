import { createApp } from 'vue'
import App from './ui/App.vue'
import { router } from './ui/router'
import './ui/style.css'

createApp(App).use(router).mount('#app')

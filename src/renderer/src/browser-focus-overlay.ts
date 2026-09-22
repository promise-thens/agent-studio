import { createApp } from 'vue'
import BrowserFocusOverlay from './components/BrowserFocusOverlay.vue'
import './assets/tokens.css'

/** 原生子窗只挂载输入投影，主题令牌沿用工作台。 */
createApp(BrowserFocusOverlay).mount('#app')

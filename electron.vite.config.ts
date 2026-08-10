import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {},
  preload: {
    build: {
      // 沙箱 Preload 无法在运行时加载第三方包，因此必须在构建阶段一并打包。
      externalizeDeps: false
    }
  },
  renderer: {
    // 强制绑定 IPv4，避免 Windows 上 localhost 仅监听 ::1 时 Electron 连不上页面。
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})

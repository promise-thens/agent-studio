import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

/**
 * isolatedEntries 的进度条会调用 stdout.clearLine / cursorTo。
 * 非 TTY（CI、管道）没有这些方法，不补齐 preload 构建会直接失败。
 */
function ensureStdoutCursorApis(): void {
  const stdout = process.stdout
  if (typeof stdout.clearLine !== 'function') {
    stdout.clearLine = () => true
  }
  if (typeof stdout.cursorTo !== 'function') {
    stdout.cursorTo = () => true
  }
  if (typeof stdout.moveCursor !== 'function') {
    stdout.moveCursor = () => true
  }
}

ensureStdoutCursorApis()

export default defineConfig({
  main: {},
  preload: {
    build: {
      // 沙箱 Preload 无法 require 第三方包，也不能加载 Rollup 拆出的 ./chunks/*。
      // 双入口必须各自打成单文件，否则 sandbox_bundle 会让 window.agent 整段缺失。
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          overlay: resolve('src/preload/overlay.ts')
        }
      }
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
    plugins: [vue()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html')
        }
      }
    }
  }
})

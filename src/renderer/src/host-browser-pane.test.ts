import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const paneSource = readFileSync(join(rendererDir, 'components/HostBrowserPane.vue'), 'utf8')
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
const cssSource = readFileSync(join(rendererDir, 'assets/main.css'), 'utf8')
const inspectorSource = readFileSync(join(rendererDir, 'components/TaskInspector.vue'), 'utf8')

describe('宿主内置浏览器功能与面板优化', () => {
  it('支持自由拖拽调整大小、防穿透遮罩与双击恢复默认宽度', () => {
    // 包含左边缘拖拽把手与双击恢复默认
    expect(paneSource).toContain('class="host-browser-resizer"')
    expect(paneSource).toContain('@pointerdown="onResizerPointerDown"')
    expect(paneSource).toContain('@dblclick="onResizerDblClick"')
    expect(paneSource).toContain("'update:width'")
    // 包含拖拽期间防 WebContentsView 吞事件的遮罩
    expect(paneSource).toContain('class="host-browser-drag-shield"')
    // App.vue 与 main.css 支持动态 CSS 变量与 localStorage 记忆
    expect(appSource).toContain('--host-browser-width')
    expect(appSource).toContain('agent-studio:host-browser-width')
    expect(cssSource).toContain('--host-browser-width')
  })

  it('顶栏支持前进/后退/刷新/停止动作分发与真实可用状态', () => {
    expect(paneSource).toContain(':disabled="!canGoBack"')
    expect(paneSource).toContain(':disabled="!canGoForward"')
    expect(paneSource).toContain("emit('act', 'back')")
    expect(paneSource).toContain("emit('act', 'forward')")
    expect(paneSource).toContain("emit('act', 'stop')")
    expect(paneSource).toContain("emit('act', 'reload')")
    expect(paneSource).toContain('host-browser-progress-bar')
  })

  it('全功能地址栏支持协议安全展示、智能提交与清除', () => {
    expect(paneSource).toContain('isSecureProtocol')
    expect(paneSource).toContain('address-protocol-badge')
    expect(paneSource).toContain('address-clear-btn')
    expect(paneSource).toContain('onClearInput')
    expect(paneSource).toContain('onInputKeydown')
    expect(paneSource).toContain('address-go-btn')
  })

  it('支持复制当前链接与在系统默认浏览器中打开', () => {
    expect(paneSource).toContain('copyCurrentUrl')
    expect(paneSource).toContain('copiedRecently')
    expect(paneSource).toContain('openInExternalBrowser')
    expect(paneSource).toContain("window.open(target, '_blank')")
  })

  it('提供深色就绪空状态与快捷直达胶囊', () => {
    expect(paneSource).toContain('host-browser-empty-state')
    expect(paneSource).toContain('内置浏览器已就绪')
    expect(paneSource).toContain('quick-link-pill')
    expect(paneSource).toContain('quickNavigate')
  })

  it('标题栏按钮并排对齐，且浏览器与检查器可同时存在、互不遮挡', () => {
    // 标题栏按钮使用 titlebar-actions 容器包裹，解决 grid 换行错位
    expect(appSource).toContain('class="titlebar-actions no-drag"')
    expect(cssSource).toContain('.titlebar-actions {')
    // 两者可同时存在，App.vue 传递 right-offset 避让宽度
    expect(appSource).toContain(':right-offset="hostBrowserVisible ? hostBrowserWidth : 0"')
    // TaskInspector 正确接收并据此计算 effectiveWidth，使得卡片始终局限在中间对话列内
    expect(inspectorSource).toContain('rightOffset?: number')
    expect(inspectorSource).toContain('baseWidth - (props.rightOffset ?? 0)')
    expect(inspectorSource).toContain('watch(')
    expect(inspectorSource).toContain('() => props.rightOffset')
  })
})

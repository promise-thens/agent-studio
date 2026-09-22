import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const overlaySource = readFileSync(join(rendererDir, 'components/BrowserFocusOverlay.vue'), 'utf8')
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')

describe('浏览器专注浮层 Stop 接线', () => {
  it('子窗只在存在执行时发送点击快照里的三元组', () => {
    expect(overlaySource).toMatch(/if \(kind === 'stop'\) {[\s\S]*?if \(!execution\)/)
    expect(overlaySource).toMatch(
      /if \(kind === 'stop'\) {[\s\S]*?revision: state\.revision,[\s\S]*?execution: {/
    )
    expect(overlaySource).toContain('executionId: execution.executionId')
    expect(overlaySource).toContain('taskId: execution.taskId')
    expect(overlaySource).toContain('turnId: execution.turnId')
  })

  it('主 Renderer 同时复核意图、当前投影与当前执行', () => {
    expect(appSource).toContain('intent.execution.taskId === snapshot.taskId')
    expect(appSource).toContain('intent.execution.executionId === snapshot.execution.executionId')
    expect(appSource).toContain('intent.execution.turnId === snapshot.execution.turnId')
    expect(appSource).toContain('intent.execution.executionId === execution.executionId')
    expect(appSource).toContain('intent.execution.turnId === execution.turnId')
  })

  it('展开对话意图平滑退出专注模式并聚焦输入框，绝不弹出悬浮 Inspector 遮挡对话', () => {
    // 捕获 receiveBrowserFocusIntent 中对 expand 意图的处理块
    const expandBlockMatch = appSource.match(/if \(intent\.kind === 'expand'\) \{([\s\S]*?)\}/)
    expect(expandBlockMatch).not.toBeNull()
    const expandBlock = expandBlockMatch![1]
    expect(expandBlock).toContain('leaveBrowserFocus()')
    expect(expandBlock).toContain('taskComposer.value?.focus()')
    // 强制约束：绝对不得激活 showInspector，避免图 4 悬浮面板遮挡对话
    expect(expandBlock).not.toContain('showInspector')
  })

  it('主 Renderer 从时间线逆序提取最新回复并写入专注模式快照 (任务 A)', () => {
    expect(appSource).toContain('latestAssistantMessage: latestAssistantMessage.value')
    expect(appSource).toContain('function resolveLatestAssistantMessage')
    expect(appSource).toMatch(/node\.kind === ['"]message['"]/)
  })
})

describe('Codex 原生视觉与两层结构 (任务 B)', () => {
  it('彻底摒弃肉粉色和黄色粗边框', () => {
    // 不得出现黄色轮廓或肉粉色硬编码
    expect(overlaySource).not.toContain('outline: 2px solid')
    expect(overlaySource).not.toContain('outline: 3px solid')
    expect(overlaySource).not.toContain('#ffb6c1') // lightpink
    expect(overlaySource).not.toContain('rgb(255, 182, 193)')
  })

  it('具备上层最近一条卡片与下层药丸胶囊两层结构', () => {
    // 上层卡片结构
    expect(overlaySource).toContain('latest-message-card')
    expect(overlaySource).toContain('最近一条')
    expect(overlaySource).toContain('snapshot.latestAssistantMessage')
    expect(overlaySource).toContain('copyLatestMessage')
    expect(overlaySource).toContain('已复制')

    // 下层药丸输入栏结构
    expect(overlaySource).toContain('pill-input-bar')
    expect(overlaySource).toContain('pill-plus-btn')
    expect(overlaySource).toContain('pill-textarea')
    expect(overlaySource).toContain('placeholder="随心输入"')
    expect(overlaySource).toContain('running-spin-ring')
    expect(overlaySource).toContain('full-access-shield')
    expect(overlaySource).toContain('#f59e0b')
    expect(overlaySource).toContain('stop-circle-btn')
    expect(overlaySource).toContain('send-circle-btn')
  })

  it('样式严格匹配 16px 圆角卡片、9999px 药丸胶囊与 34px 圆形按钮', () => {
    expect(overlaySource).toContain('border-radius: 16px')
    expect(overlaySource).toContain('border-radius: 9999px')
    expect(overlaySource).toContain('width: 34px')
    expect(overlaySource).toContain('height: 34px')
  })
  it('彻底消除中部分割线与底部悬空底座，杜绝双层线与焦点外圈', () => {
    // 1. 彻底移除中间分割线 unified-divider，消息区与输入区同在一个纯白气泡内自然留白
    expect(overlaySource).not.toContain('unified-divider')

    // 2. 底部微型折叠指示器紧贴卡片底边缘（bottom: -6px），绝不悬空突出（禁止 bottom: -10px）
    expect(overlaySource).not.toContain('bottom: -10px')
    expect(overlaySource).toContain('bottom: -6px')

    // 3. 右上角折叠小箭头极简纯净，彻底杜绝任何焦点外圈与边框
    expect(overlaySource).toContain('.collapse-toggle-btn')
    expect(overlaySource).toContain('border: none !important')
  })
})

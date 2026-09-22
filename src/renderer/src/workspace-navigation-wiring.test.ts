import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rendererDir = dirname(fileURLToPath(import.meta.url))

/** 读取 Renderer 源码，锁定跨组件导航载荷和窄窗布局边界。 */
function readRendererSource(relativePath: string): string {
  return readFileSync(join(rendererDir, relativePath), 'utf8')
}

describe('工作区详情双向定位接线', () => {
  it('对话工具经过 App 打开 Inspector 时保留真实 turnId 与 nodeId', () => {
    const app = readRendererSource('App.vue')
    const conversation = readRendererSource('components/TaskConversation.vue')

    expect(conversation).toContain('openTool: [turnId: string, nodeId: string]')
    expect(conversation).toContain("emit('openTool', turnId, nodeId)")
    expect(app).toContain('@open-tool="openToolReview"')
    expect(app).toMatch(/function openToolReview\(turnId: string, nodeId: string\): void/)
    expect(app).toContain("inspectorTab.value = 'timeline'")
    expect(app).toContain('inspectorPlanTurnId.value = turnId')
    expect(app).toContain('inspectorFocusNodeId.value = nodeId')
  })

  it('Inspector 工具点击把同一事实身份送回对话', () => {
    const app = readRendererSource('App.vue')
    const timeline = readRendererSource('components/InspectorTimelinePane.vue')

    expect(timeline).toContain("emit('focusTarget', { turnId: turn.turnId, nodeId: tool.nodeId })")
    expect(app).toContain('@focus-target="focusConversationTarget"')
    expect(app).toContain('conversationFocusTurnId.value = target.turnId')
    expect(app).toContain('conversationFocusNodeId.value = target.nodeId ?? null')
  })

  it('Artifacts 使用描述符 turnId，Changes 只接受主进程证明的 latest-turn', () => {
    const artifacts = readRendererSource('components/TaskArtifactsPanel.vue')
    const changes = readRendererSource('components/TaskChangesPanel.vue')

    expect(artifacts).toContain("emit('focusTarget', { turnId: selected.turnId })")
    expect(changes).toContain("revertible.kind === 'latest-turn' ? revertible.turnId : null")
    expect(changes).toContain("emit('focusTarget', { turnId: latestTurnId })")
  })

  it('980px 规则不再把逻辑 docked Inspector 强制画成 absolute', () => {
    const mainCss = readRendererSource('assets/main.css')
    const narrowStart = mainCss.indexOf('@media (max-width: 980px) {')
    const narrowEnd = mainCss.indexOf('/* 980 保底', narrowStart)
    const narrowWorkspaceCss = mainCss.slice(narrowStart, narrowEnd)

    expect(narrowStart).toBeGreaterThanOrEqual(0)
    expect(narrowEnd).toBeGreaterThan(narrowStart)
    expect(narrowWorkspaceCss).not.toContain('.workspace-layout.is-inspector-docked')
    expect(narrowWorkspaceCss).not.toContain('position: absolute')
  })
})

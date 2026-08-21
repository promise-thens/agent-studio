import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GrokMemorySummary } from '../../shared/grok-memory'
import {
  formatMemoryItemSubtitle,
  formatMemoryItemTitle,
  formatMemoryKindLabel,
  formatMemoryUpdatedAt,
  formatProjectKey,
  groupProjectMemories,
  looksLikeFilePath
} from './memory-settings'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const panelSource = readFileSync(join(rendererDir, 'components/MemorySettingsPanel.vue'), 'utf8')

function summary(
  partial: Partial<GrokMemorySummary> & Pick<GrokMemorySummary, 'memoryId' | 'scope'>
): GrokMemorySummary {
  return {
    title: partial.title ?? partial.memoryId,
    updatedAt: partial.updatedAt ?? null,
    projectKey: partial.projectKey,
    isCurrentProject: partial.isCurrentProject,
    ...partial
  }
}

describe('记忆设置展示', () => {
  it('列表不把 Grok 默认绝对路径当标题', () => {
    expect(
      formatMemoryItemTitle({
        scope: 'project',
        title: 'Project Memory — /Users/huyaohang/Desktop/个人/agent-studio'
      })
    ).toBe('项目记忆')
    expect(
      formatMemoryItemTitle({
        scope: 'project',
        title: 'Project Memory — /Users/huyaohang/Desktop/个人/agent-studio',
        projectKey: 'agent-studio-3db544e2'
      })
    ).toBe('agent-studio')
    expect(
      formatMemoryItemTitle({
        scope: 'project',
        title: 'Project Memory - C:\\Users\\huyaohang\\Documents\\demo'
      })
    ).toBe('项目记忆')
    expect(formatMemoryItemTitle({ scope: 'global', title: 'Global Memory' })).toBe('全局记忆')
    expect(
      formatMemoryItemTitle({
        scope: 'project',
        title: 'Project Memory — 写作偏好'
      })
    ).toBe('写作偏好')
    expect(formatMemoryItemTitle({ scope: 'global', title: '写作偏好' })).toBe('写作偏好')
    expect(formatMemoryItemTitle({ scope: 'session', title: 'note.md' })).toBe('未命名会话')
    expect(formatMemoryItemTitle({ scope: 'session', title: '权限策略讨论' })).toBe('权限策略讨论')
  })

  it('项目目录只显示 slug，当前项目排在最前', () => {
    expect(formatProjectKey('agent-studio-3db544e2')).toBe('agent-studio')
    expect(formatProjectKey('agentstudiotest-2d4bd113')).toBe('agentstudiotest')
    const groups = groupProjectMemories([
      summary({
        memoryId: 'project/other-aaaaaaaa/MEMORY.md',
        scope: 'project',
        projectKey: 'other-aaaaaaaa',
        title: '其它'
      }),
      summary({
        memoryId: 'project/agent-studio-3db544e2/MEMORY.md',
        scope: 'project',
        projectKey: 'agent-studio-3db544e2',
        isCurrentProject: true,
        title: '当前'
      }),
      summary({
        memoryId: 'session/agent-studio-3db544e2/one.md',
        scope: 'session',
        projectKey: 'agent-studio-3db544e2',
        isCurrentProject: true,
        title: '会话'
      })
    ])
    expect(groups[0]?.projectKey).toBe('agent-studio-3db544e2')
    expect(groups[0]?.isCurrent).toBe(true)
    expect(groups[0]?.sessions).toHaveLength(1)
    expect(groups[0]?.sessions[0]?.memoryId).toBe('session/agent-studio-3db544e2/one.md')
  })

  it('同一项目下的会话按更新时间新到旧', () => {
    const groups = groupProjectMemories([
      summary({
        memoryId: 'session/demo-deadbeef/old.md',
        scope: 'session',
        projectKey: 'demo-deadbeef',
        updatedAt: '2026-08-21T10:00:00.000Z',
        title: '旧'
      }),
      summary({
        memoryId: 'session/demo-deadbeef/new.md',
        scope: 'session',
        projectKey: 'demo-deadbeef',
        updatedAt: '2026-08-21T12:00:00.000Z',
        title: '新'
      })
    ])
    expect(groups[0]?.sessions.map((item) => item.memoryId)).toEqual([
      'session/demo-deadbeef/new.md',
      'session/demo-deadbeef/old.md'
    ])
  })

  it('相对时间稳定，路径检测覆盖 Unix 和 Windows', () => {
    const now = Date.parse('2026-08-21T12:00:00.000Z')
    expect(formatMemoryUpdatedAt('2026-08-21T11:59:30.000Z', now)).toBe('刚刚')
    expect(formatMemoryUpdatedAt('2026-08-21T11:10:00.000Z', now)).toBe('50 分钟前')
    expect(
      formatMemoryItemSubtitle({ scope: 'global', updatedAt: '2026-08-21T10:00:00.000Z' }, now)
    ).toBe('2 小时前')
    expect(
      formatMemoryItemSubtitle(
        { scope: 'project', updatedAt: '2026-08-21T10:00:00.000Z', isCurrentProject: true },
        now
      )
    ).toBe('2 小时前')
    expect(formatMemoryItemSubtitle({ scope: 'project', updatedAt: null })).toBe('项目笔记')
    expect(formatMemoryKindLabel('global')).toBe('全局')
    expect(formatMemoryKindLabel('project')).toBe('项目')
    expect(formatMemoryKindLabel('session')).toBe('会话')
    expect(looksLikeFilePath('/Users/huyaohang/Desktop/个人/agent-studio')).toBe(true)
    expect(looksLikeFilePath('C:\\Users\\huyaohang\\Documents')).toBe(true)
    expect(looksLikeFilePath('写作偏好')).toBe(false)
  })

  it('面板用展示标题，不直接渲染原始路径标题', () => {
    expect(panelSource).toContain('formatMemoryItemTitle')
    expect(panelSource).toContain('formatProjectKey')
    expect(panelSource).not.toContain('{{ item.title }}')
    expect(panelSource).not.toContain('{{ group.project.title }}')
    expect(panelSource).not.toContain('{{ group.projectKey }}')
  })

  it('侧栏分长期笔记和会话摘要，条目用范围标签而不是树', () => {
    expect(panelSource).toContain('长期笔记')
    expect(panelSource).toContain('会话摘要')
    expect(panelSource).toContain('其它项目')
    expect(panelSource).toContain('kind-tag')
    expect(panelSource).toContain('formatMemoryKindLabel')
    expect(panelSource).not.toContain('class="session-stack"')
    expect(panelSource).not.toContain('margin-left: 10px')
  })

  it('记忆正文默认渲染 Markdown，点编辑才显示源码', () => {
    expect(panelSource).toContain('AssistantMarkdown')
    expect(panelSource).toContain('class="memory-preview"')
    expect(panelSource).toContain('title="查看渲染"')
    expect(panelSource).toContain('title="编辑源码"')
  })

  it('记忆面板不提供写全局 / 写本项目快捷按钮', () => {
    expect(panelSource).not.toContain('写全局')
    expect(panelSource).not.toContain('写本项目')
    expect(panelSource).not.toContain('createMemory')
  })

  it('编辑区底部提示固定可见，不被空状态或编辑框撑出裁切', () => {
    expect(panelSource).toContain('class="editor-footer"')
    expect(panelSource).not.toMatch(/\.editor-empty\s*\{[^}]*min-height:\s*100%/)
    expect(panelSource).not.toMatch(/\.editor-frame\s*\{[^}]*height:\s*100%/)
    expect(panelSource).toMatch(/\.editor-footer\s*\{[^}]*flex:\s*0\s+0\s+auto/)
  })
})

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RuntimePluginSummary } from '../../shared/runtime-plugin'
import {
  PLUGIN_EMPTY_COPY,
  PLUGIN_ENABLE_TOGGLE_HINT,
  applyPluginDetailIfCurrent,
  filterInstalledPlugins,
  filterPluginHubQuery,
  flattenPluginMcps,
  flattenPluginSkills,
  pluginDisplayLabel,
  pluginHubSubtitle,
  resolvePluginHubTab
} from './plugins-page'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const pluginsPageSource = readFileSync(join(rendererDir, 'components/PluginsPage.vue'), 'utf8')
const mcpPanelSource = readFileSync(join(rendererDir, 'components/McpSettingsPanel.vue'), 'utf8')
const bannerSource = readFileSync(
  join(rendererDir, 'components/ExecutionSurfaceBanner.vue'),
  'utf8'
)
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')

function plugin(
  partial: Partial<RuntimePluginSummary> & { pluginId: string }
): RuntimePluginSummary {
  return {
    displayName: partial.displayName ?? partial.pluginId,
    status: 'enabled',
    scope: 'user',
    skillCount: 0,
    mcpCount: 0,
    hookCount: 0,
    ...partial
  }
}

describe('插件页列表过滤', () => {
  it('只按已加载摘要过滤，空查询返回原列表', () => {
    const items = [
      plugin({ pluginId: 'alpha', displayName: 'Alpha Tools' }),
      plugin({ pluginId: 'beta', displayName: 'Beta Pack' })
    ]

    expect(filterInstalledPlugins(items, '')).toEqual(items)
    expect(filterInstalledPlugins(items, '  ')).toEqual(items)
    expect(filterInstalledPlugins(items, 'alpha').map((item) => item.pluginId)).toEqual(['alpha'])
    expect(filterInstalledPlugins(items, 'Pack').map((item) => item.pluginId)).toEqual(['beta'])
  })

  it('显示名只用 displayName 或 pluginId，不合成 Runtime 前缀', () => {
    expect(pluginDisplayLabel(plugin({ pluginId: 'raw-id', displayName: '  ' }))).toBe('raw-id')
    expect(pluginDisplayLabel(plugin({ pluginId: 'raw-id', displayName: 'Docs' }))).toBe('Docs')
    expect(pluginDisplayLabel(plugin({ pluginId: 'raw-id', displayName: 'Docs' }))).not.toMatch(
      /Grok\s·/
    )
  })

  it('选中已变时丢掉迟到的 getPlugin 结果', () => {
    expect(
      applyPluginDetailIfCurrent({
        selectedPluginId: 'b',
        requestedPluginId: 'a',
        incoming: { ok: true, detail: { pluginId: 'a' } }
      })
    ).toEqual({ apply: false })

    expect(
      applyPluginDetailIfCurrent({
        selectedPluginId: 'b',
        requestedPluginId: 'a',
        incoming: { ok: false, errorMessage: '插件详情加载失败。' }
      })
    ).toEqual({ apply: false })

    expect(
      applyPluginDetailIfCurrent({
        selectedPluginId: 'b',
        requestedPluginId: 'b',
        incoming: { ok: true, detail: { pluginId: 'b' } }
      })
    ).toEqual({
      apply: true,
      detail: { pluginId: 'b' },
      detailState: 'ready',
      detailError: ''
    })

    expect(
      applyPluginDetailIfCurrent({
        selectedPluginId: 'b',
        requestedPluginId: 'b',
        incoming: { ok: false, errorMessage: '插件详情加载失败。' }
      })
    ).toEqual({
      apply: true,
      detail: null,
      detailState: 'error',
      detailError: '插件详情加载失败。'
    })
  })
})

describe('插件中心三栏', () => {
  it('未知 tab 回到插件，合法值原样保留', () => {
    expect(resolvePluginHubTab('plugins')).toBe('plugins')
    expect(resolvePluginHubTab('mcp')).toBe('mcp')
    expect(resolvePluginHubTab('skills')).toBe('skills')
    expect(resolvePluginHubTab('marketplace')).toBe('plugins')
    expect(resolvePluginHubTab(null)).toBe('plugins')
  })

  it('技能与插件 MCP 从详情摊平，搜索命中名称或说明', () => {
    const details = [
      {
        ...plugin({ pluginId: 'docs-kit', displayName: '文档工具', skillCount: 2, mcpCount: 1 }),
        skillNames: ['summarize', 'outline'],
        skillDescriptions: { summarize: '把长文压成要点' },
        mcpNames: ['docs'],
        hookNames: []
      },
      {
        ...plugin({
          pluginId: 'browser',
          displayName: 'Browser',
          status: 'disabled' as const,
          skillCount: 0,
          mcpCount: 1
        }),
        skillNames: [],
        mcpNames: ['computer-use'],
        hookNames: []
      }
    ]

    const skills = flattenPluginSkills(details)
    expect(skills.map((item) => item.skillKey)).toEqual(['docs-kit:outline', 'docs-kit:summarize'])
    expect(skills.find((item) => item.name === 'summarize')?.description).toBe('把长文压成要点')
    expect(skills.find((item) => item.name === 'outline')?.pluginLabel).toBe('文档工具')
    expect(filterPluginHubQuery(skills, '要点').map((item) => item.name)).toEqual(['summarize'])

    const pluginMcps = flattenPluginMcps(details)
    expect(pluginMcps.map((item) => item.name)).toEqual(['computer-use', 'docs'])
    expect(pluginMcps.find((item) => item.name === 'computer-use')?.enabled).toBe(false)
  })

  it('插件副标题只用计数，不合成 Runtime 前缀', () => {
    expect(
      pluginHubSubtitle(plugin({ pluginId: 'docs-kit', skillCount: 2, mcpCount: 1, hookCount: 0 }))
    ).toBe('技能 2 · MCP 1')
    expect(pluginHubSubtitle(plugin({ pluginId: 'empty' }))).toBe('未包含技能或 MCP')
    expect(
      pluginHubSubtitle(plugin({ pluginId: 'docs-kit', displayName: 'Docs', skillCount: 1 }))
    ).not.toMatch(/Grok\s·/)
  })
})

describe('插件主列表面', () => {
  it('空状态文案固定，启停开关调用 IPC 且失败不得乐观打勾', () => {
    expect(PLUGIN_EMPTY_COPY).toBe(
      '还没有已安装的插件。插件由 Grok Build 加载，本页只展示已安装项。'
    )
    expect(pluginsPageSource).toContain('PLUGIN_EMPTY_COPY')
    expect(pluginsPageSource).toContain('window.app.listPlugins()')
    expect(pluginsPageSource).toContain('window.app.getPlugin')
    expect(pluginsPageSource).toContain('McpSettingsPanel')
    expect(mcpPanelSource).toContain('window.app.listMcpServers')
    expect(pluginsPageSource).toContain('window.app.setPluginEnabled')
    expect(pluginsPageSource).toContain('togglePlugin')
    expect(pluginsPageSource).toContain('PLUGIN_ENABLE_TOGGLE_HINT')
    expect(PLUGIN_ENABLE_TOGGLE_HINT).toContain('下一 session')
    expect(pluginsPageSource).toContain('role="tablist"')
    expect(pluginsPageSource).toContain('技能')
    expect(pluginsPageSource).not.toContain('absolutePath')
    expect(pluginsPageSource).not.toContain('Grok ·')
    expect(pluginsPageSource).not.toContain('浏览目录')
  })

  it('插件页不渲染对话输入框，执行条返回对话不取消', () => {
    expect(appSource).toContain("primaryView.value === 'plugins'")
    expect(appSource).toContain('<PluginsPage')
    expect(appSource).toContain('<ExecutionSurfaceBanner')
    expect(appSource).toContain('workbench.returnToConversation')
    expect(appSource).toContain('workbench.openPlugins')
    expect(bannerSource).toContain('resolveExecutionSurfaceBanner')
    expect(bannerSource).toContain('返回对话')
    expect(bannerSource).toContain('任务正在执行')
    expect(bannerSource).toContain('任务等待审批')
    expect(bannerSource).not.toContain('cancelTurn')
    expect(bannerSource).not.toContain('disconnect')
  })
})

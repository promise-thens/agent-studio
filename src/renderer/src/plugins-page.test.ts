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
  pluginDisplayLabel
} from './plugins-page'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const pluginsPageSource = readFileSync(join(rendererDir, 'components/PluginsPage.vue'), 'utf8')
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

describe('插件主列表面', () => {
  it('空状态文案固定，启停开关调用 IPC 且失败不得乐观打勾', () => {
    expect(PLUGIN_EMPTY_COPY).toBe(
      '还没有已安装的插件。插件由 Grok Build 加载，本页只展示已安装项。'
    )
    expect(pluginsPageSource).toContain(PLUGIN_EMPTY_COPY)
    expect(pluginsPageSource).toContain('window.app.listPlugins()')
    expect(pluginsPageSource).toContain('window.app.getPlugin')
    expect(pluginsPageSource).toContain('applyPluginDetailIfCurrent')
    expect(pluginsPageSource).toContain('window.app.setPluginEnabled')
    expect(pluginsPageSource).toContain('togglePlugin')
    expect(pluginsPageSource).toContain('PLUGIN_ENABLE_TOGGLE_HINT')
    expect(PLUGIN_ENABLE_TOGGLE_HINT).toContain('下一 session')
    expect(pluginsPageSource).not.toContain('absolutePath')
    expect(pluginsPageSource).not.toContain('Grok ·')
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

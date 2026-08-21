import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { RuntimePluginSummary } from '../../shared/runtime-plugin'
import type { MarketplacePluginSummary } from '../../shared/runtime-marketplace-plugin'
import {
  OFFICIAL_MARKETPLACE_GIT_URL,
  PLUGIN_ADD_OFFICIAL_MARKETPLACE_COPY,
  PLUGIN_EMPTY_COPY,
  PLUGIN_ENABLE_TOGGLE_HINT,
  PLUGIN_GO_TO_MARKETPLACE_COPY,
  PLUGIN_INSTALL_SUCCESS_COPY,
  PLUGIN_PAGE_INTRO_COPY,
  PLUGIN_TRUST_WARNING_COPY,
  applyPluginDetailIfCurrent,
  buildPluginUninstallRequest,
  buildTrustedPluginInstallRequest,
  filterInstalledPlugins,
  filterPluginHubQuery,
  flattenPluginMcps,
  flattenPluginSkills,
  marketplaceDisplayLabel,
  marketplacePluginSubtitle,
  pluginDisplayLabel,
  pluginHubSubtitle,
  resolvePluginHubTab,
  resolvePluginPane,
  resolveProductSlashPluginTarget
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

  it('已安装空状态保留原本文案，并提供去市场看看', () => {
    expect(PLUGIN_EMPTY_COPY).toBe(
      '还没有已安装的插件。插件由 Grok Build 加载，本页只展示已安装项。'
    )
    expect(PLUGIN_GO_TO_MARKETPLACE_COPY).toBe('去市场看看')
    expect(PLUGIN_PAGE_INTRO_COPY).toBe('只展示 App grok-home 已加载项；安装由 Grok 执行。')
    expect(pluginsPageSource).toContain('PLUGIN_EMPTY_COPY')
    expect(pluginsPageSource).toContain('PLUGIN_GO_TO_MARKETPLACE_COPY')
    expect(pluginsPageSource).toContain('PLUGIN_PAGE_INTRO_COPY')
    expect(pluginsPageSource).toContain("pane = 'marketplace'")
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

function marketplacePlugin(
  partial: Partial<MarketplacePluginSummary> & { name: string }
): MarketplacePluginSummary {
  return {
    displayName: partial.displayName ?? partial.name,
    description: partial.description ?? '',
    sourceName: partial.sourceName ?? 'plugin-marketplace',
    installed: partial.installed ?? false,
    ...partial
  }
}

describe('插件页已安装/市场嵌套栏', () => {
  it('未知 pane 回到已安装，合法值原样保留', () => {
    expect(resolvePluginPane('installed')).toBe('installed')
    expect(resolvePluginPane('marketplace')).toBe('marketplace')
    expect(resolvePluginPane('plugins')).toBe('installed')
    expect(resolvePluginPane(null)).toBe('installed')
    expect(resolvePluginHubTab('marketplace')).toBe('plugins')
  })

  it('/marketplace 产品动作打开插件 tab 的市场栏', () => {
    expect(resolveProductSlashPluginTarget('open-plugins')).toEqual({
      tab: 'plugins',
      pane: 'installed'
    })
    expect(resolveProductSlashPluginTarget('open-plugins-marketplace')).toEqual({
      tab: 'plugins',
      pane: 'marketplace'
    })
    expect(resolveProductSlashPluginTarget('open-plugins-mcp')).toEqual({
      tab: 'mcp',
      pane: 'installed'
    })
    expect(resolveProductSlashPluginTarget('open-settings')).toBeNull()
  })

  it('市场副标题只用 DTO 计数与说明，不编造展示名', () => {
    expect(
      marketplacePluginSubtitle(
        marketplacePlugin({
          name: 'chrome-devtools',
          description: 'Chrome DevTools MCP',
          skillCount: 0,
          mcpCount: 1,
          hookCount: 0
        })
      )
    ).toBe('Chrome DevTools MCP · 技能 0 · MCP 1 · Hooks 0')
    expect(marketplacePluginSubtitle(marketplacePlugin({ name: 'exa' }))).toBe('')
    expect(marketplaceDisplayLabel(marketplacePlugin({ name: 'raw-id', displayName: '  ' }))).toBe(
      'raw-id'
    )
    expect(
      marketplaceDisplayLabel(marketplacePlugin({ name: 'raw-id', displayName: 'Docs' }))
    ).not.toMatch(/Grok\s·/)
  })
})

describe('插件安装信任确认', () => {
  it('未勾选信任不能发出 trust: true', () => {
    expect(buildTrustedPluginInstallRequest({ name: 'chrome-devtools' }, false)).toBeNull()
    expect(buildTrustedPluginInstallRequest({ name: 'chrome-devtools' }, true)).toEqual({
      name: 'chrome-devtools',
      trust: true
    })
    expect(buildTrustedPluginInstallRequest(undefined, true)).toBeNull()
    expect(buildTrustedPluginInstallRequest({ name: '' }, true)).toBeNull()

    const trustDialogSource = readFileSync(
      join(rendererDir, 'components/PluginTrustDialog.vue'),
      'utf8'
    )
    expect(PLUGIN_TRUST_WARNING_COPY).toBe(
      '信任后将启用该插件的 Hooks、MCP 与 LSP，并以你的用户权限运行。'
    )
    expect(trustDialogSource).toContain('PLUGIN_TRUST_WARNING_COPY')
    expect(trustDialogSource).toContain('type="checkbox"')
    expect(trustDialogSource).toContain(':disabled="!trusted"')
    expect(trustDialogSource).toContain('sourceName')
    expect(trustDialogSource).not.toContain('gitUrl')
    expect(trustDialogSource).not.toContain('trust: false')
    expect(trustDialogSource).not.toContain('trust: true')
    expect(pluginsPageSource).toContain('buildTrustedPluginInstallRequest')
    expect(pluginsPageSource).toContain('PluginTrustDialog')
    expect(pluginsPageSource).toContain('window.app.installPlugin')
    expect(pluginsPageSource).not.toContain('trust: false')
    expect(pluginsPageSource).not.toMatch(/installPlugin\([^)]*false/)
    expect(pluginsPageSource).not.toContain('cancelTurn')
    expect(pluginsPageSource).not.toContain('disconnect')
  })

  it('信任框 header 不得把警告挤进全局 38px 图标列', () => {
    const trustDialogSource = readFileSync(
      join(rendererDir, 'components/PluginTrustDialog.vue'),
      'utf8'
    )
    const hasIconColumn = trustDialogSource.includes('class="permission-icon"')
    const hasFullWidthHeader = trustDialogSource.includes('grid-template-columns: minmax(0, 1fr)')
    expect(hasIconColumn || hasFullWidthHeader).toBe(true)
  })

  it('安装成功文案不得声称当前 Turn 已生效，空市场可添加官方源', () => {
    expect(PLUGIN_INSTALL_SUCCESS_COPY).toBe('已安装。新对话或重新进入任务后由 Grok 加载。')
    expect(PLUGIN_INSTALL_SUCCESS_COPY).not.toContain('当前 Turn')
    expect(PLUGIN_INSTALL_SUCCESS_COPY).not.toContain('已生效')
    expect(PLUGIN_ADD_OFFICIAL_MARKETPLACE_COPY).toBe('添加官方市场')
    expect(OFFICIAL_MARKETPLACE_GIT_URL).toBe('https://github.com/xai-org/plugin-marketplace.git')
    expect(pluginsPageSource).toContain('PLUGIN_INSTALL_SUCCESS_COPY')
    expect(pluginsPageSource).toContain('PLUGIN_ADD_OFFICIAL_MARKETPLACE_COPY')
    expect(pluginsPageSource).toContain('OFFICIAL_MARKETPLACE_GIT_URL')
    expect(pluginsPageSource).toContain('window.app.listMarketplacePlugins')
    expect(pluginsPageSource).toContain('window.app.addMarketplaceSource')
    expect(pluginsPageSource).toContain('window.app.uninstallPlugin')
    expect(pluginsPageSource).toContain('buildPluginUninstallRequest')
    expect(pluginsPageSource).not.toContain('当前 Turn 已生效')
  })

  it('卸载请求只用已安装列表里的 pluginId', () => {
    const installed = [plugin({ pluginId: 'chrome-devtools-mcp' })]
    expect(buildPluginUninstallRequest('chrome-devtools-mcp', installed)).toEqual({
      pluginId: 'chrome-devtools-mcp'
    })
    expect(buildPluginUninstallRequest('--confirm', installed)).toBeNull()
    expect(buildPluginUninstallRequest('missing', installed)).toBeNull()
  })
})

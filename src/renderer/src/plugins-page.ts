import type { RuntimePluginDetail, RuntimePluginSummary } from '../../shared/runtime-plugin'

export const PLUGIN_EMPTY_COPY = '还没有已安装的插件。插件由 Grok Build 加载，本页只展示已安装项。'

export const PLUGIN_ENABLE_TOGGLE_HINT = '启用或停用插件，下一 session 生效'

export const PLUGIN_HUB_TABS = ['plugins', 'mcp', 'skills'] as const
export type PluginHubTab = (typeof PLUGIN_HUB_TABS)[number]
export const DEFAULT_PLUGIN_HUB_TAB: PluginHubTab = 'plugins'

export interface PluginHubSkillRow {
  skillKey: string
  name: string
  description: string
  pluginId: string
  pluginLabel: string
  enabled: boolean
  invalid: boolean
}

export interface PluginHubMcpRow {
  name: string
  pluginId: string
  pluginLabel: string
  enabled: boolean
}

const PLUGIN_HUB_TAB_IDS: readonly PluginHubTab[] = PLUGIN_HUB_TABS

export function isPluginHubTab(value: unknown): value is PluginHubTab {
  return typeof value === 'string' && PLUGIN_HUB_TAB_IDS.includes(value as PluginHubTab)
}

/** 未知栏回到插件，避免主列空白。 */
export function resolvePluginHubTab(value: unknown): PluginHubTab {
  return isPluginHubTab(value) ? value : DEFAULT_PLUGIN_HUB_TAB
}

/** 只展示接口返回的 displayName，缺失时原样用 pluginId，禁止合成前缀。 */
export function pluginDisplayLabel(
  plugin: Pick<RuntimePluginSummary, 'pluginId' | 'displayName'>
): string {
  return plugin.displayName.trim() || plugin.pluginId
}

/**
 * 选中已变时丢掉迟到的 getPlugin，避免列表亮 B、详情却是 A。
 * 失败路径单独重载：没有 detail 时不要把 T 推断成 unknown。
 */
export function applyPluginDetailIfCurrent(input: {
  selectedPluginId: string
  requestedPluginId: string
  incoming: { ok: false; errorMessage: string }
}): { apply: false } | { apply: true; detail: null; detailState: 'error'; detailError: string }
export function applyPluginDetailIfCurrent<T>(input: {
  selectedPluginId: string
  requestedPluginId: string
  incoming: { ok: true; detail: T }
}): { apply: false } | { apply: true; detail: T; detailState: 'ready'; detailError: '' }
export function applyPluginDetailIfCurrent<T>(input: {
  selectedPluginId: string
  requestedPluginId: string
  incoming: { ok: true; detail: T } | { ok: false; errorMessage: string }
}):
  | { apply: false }
  | { apply: true; detail: T; detailState: 'ready'; detailError: '' }
  | { apply: true; detail: null; detailState: 'error'; detailError: string } {
  if (input.selectedPluginId !== input.requestedPluginId) return { apply: false }
  if (input.incoming.ok) {
    return {
      apply: true,
      detail: input.incoming.detail,
      detailState: 'ready',
      detailError: ''
    }
  }
  return {
    apply: true,
    detail: null,
    detailState: 'error',
    detailError: input.incoming.errorMessage
  }
}

/** 搜索只过滤已经加载的摘要，不再请求 IPC。 */
export function filterInstalledPlugins(
  plugins: readonly RuntimePluginSummary[],
  query: string
): RuntimePluginSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...plugins]
  return plugins.filter((plugin) => matchesPluginHubQuery(plugin, needle))
}

function matchesPluginHubQuery(
  plugin: Pick<RuntimePluginSummary, 'pluginId' | 'displayName' | 'description'>,
  needle: string
): boolean {
  const label = pluginDisplayLabel(plugin).toLowerCase()
  const description = plugin.description?.toLowerCase() ?? ''
  return (
    label.includes(needle) ||
    plugin.pluginId.toLowerCase().includes(needle) ||
    description.includes(needle)
  )
}

export function filterPluginHubQuery<
  T extends { name: string; description?: string; pluginLabel?: string }
>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  return items.filter((item) => {
    const haystacks = [item.name, item.description ?? '', item.pluginLabel ?? '']
    return haystacks.some((text) => text.toLowerCase().includes(needle))
  })
}

/** 技能按名称摊平；启停仍跟随所属插件，第一波没有单独的 skill 开关。 */
export function flattenPluginSkills(details: readonly RuntimePluginDetail[]): PluginHubSkillRow[] {
  const rows: PluginHubSkillRow[] = []
  for (const detail of details) {
    for (const name of detail.skillNames) {
      rows.push({
        skillKey: `${detail.pluginId}:${name}`,
        name,
        description: detail.skillDescriptions?.[name] ?? '',
        pluginId: detail.pluginId,
        pluginLabel: pluginDisplayLabel(detail),
        enabled: detail.status === 'enabled',
        invalid: detail.status === 'invalid'
      })
    }
  }
  return rows.sort((left, right) => {
    const byName = left.name.localeCompare(right.name)
    return byName !== 0 ? byName : left.pluginId.localeCompare(right.pluginId)
  })
}

/** 插件自带 MCP 只读展示，不与用户级服务器混成可编辑项。 */
export function flattenPluginMcps(details: readonly RuntimePluginDetail[]): PluginHubMcpRow[] {
  const rows: PluginHubMcpRow[] = []
  for (const detail of details) {
    for (const name of detail.mcpNames) {
      rows.push({
        name,
        pluginId: detail.pluginId,
        pluginLabel: pluginDisplayLabel(detail),
        enabled: detail.status === 'enabled'
      })
    }
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name))
}

export function pluginHubSubtitle(plugin: RuntimePluginSummary): string {
  if (plugin.description?.trim()) return plugin.description.trim()
  const parts: string[] = []
  if (plugin.skillCount > 0) parts.push(`技能 ${plugin.skillCount}`)
  if (plugin.mcpCount > 0) parts.push(`MCP ${plugin.mcpCount}`)
  if (plugin.hookCount > 0) parts.push(`Hooks ${plugin.hookCount}`)
  return parts.length > 0 ? parts.join(' · ') : '未包含技能或 MCP'
}

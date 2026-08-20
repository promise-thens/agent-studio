import type { RuntimePluginSummary } from '../../shared/runtime-plugin'

export const PLUGIN_EMPTY_COPY = '还没有已安装的插件。插件由 Grok Build 加载，本页只展示已安装项。'

export const PLUGIN_ENABLE_TOGGLE_HINT = '启用或停用插件，下一 session 生效'

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
  return plugins.filter((plugin) => {
    const label = pluginDisplayLabel(plugin).toLowerCase()
    return label.includes(needle) || plugin.pluginId.toLowerCase().includes(needle)
  })
}

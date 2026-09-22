import type {
  PluginSourceReport,
  RuntimePluginDiscovery
} from '../../shared/runtime-plugin-discovery'
import type { MarketplacePluginSummary } from '../../shared/runtime-marketplace-plugin'

export type PluginListLoadState = 'loading' | 'ready' | 'error'

/** 未加载与失败不能显示为有效的零库存。 */
export function pluginCountLabel(state: PluginListLoadState, count: number): string {
  return state === 'loading' ? '加载中' : state === 'error' ? '加载失败' : String(count)
}

/** 只读发现搜索不会触发文件读取，也不会混入应用安装列表。 */
export function filterPluginDiscoveries(
  items: readonly RuntimePluginDiscovery[], query: string
): RuntimePluginDiscovery[] {
  const needle = query.trim().toLowerCase()
  return items.filter((item) => [
    item.directoryName, item.displayName ?? '', item.pluginId ?? '', item.description ?? ''
  ].some((text) => text.toLowerCase().includes(needle)))
}

/** 库存、配置启用和 Runtime 实际加载是三种证据，此处只描述发现。 */
export function pluginDiscoverySubtitle(item: RuntimePluginDiscovery): string {
  const state = item.state === 'identified' ? '已识别清单'
    : item.state === 'invalid' ? '元数据无效或路径被拒绝' : '待识别，未找到清单'
  const boundary = item.source === 'user' ? '尚未接入当前应用' : '未登记为应用安装项'
  return `${state} · ${boundary} · 仅只读展示`
}

/** 注册表异常与部分拒绝应有可操作提示，但不能泄漏原始异常路径。 */
export function pluginSourceNotice(report: PluginSourceReport): string {
  const label = report.source === 'app' ? '应用' : '用户'
  if (report.state === 'missing') return `${label}插件目录不存在。`
  if (report.state === 'invalid') return `${label}插件目录不可安全读取；请检查目录权限或链接。`
  const parts: string[] = []
  if (report.registryState === 'invalid') parts.push('安装注册表损坏，目录仅作发现展示')
  if (report.registryState === 'missing' && report.source === 'app') parts.push('没有安装注册表')
  if (report.registryState === 'empty' && report.source === 'app') parts.push('安装注册表为空，残留目录不会重新启用')
  if (report.rejectedCount) parts.push(`已拒绝 ${report.rejectedCount} 个无效条目`)
  if (report.truncated) parts.push('条目超过扫描上限，结果不完整')
  return parts.length ? `${label}：${parts.join('；')}。` : ''
}

/** 现有 CLI 只支持 name 安装，无法确认同名条目的来源时禁用入口。 */
export function hasAmbiguousMarketplaceName(
  plugin: MarketplacePluginSummary, catalog: readonly MarketplacePluginSummary[]
): boolean {
  return catalog.filter((item) => item.name === plugin.name).length !== 1
}

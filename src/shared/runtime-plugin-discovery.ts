import type { DesktopIpcResult } from './ipc-result'
import { isRuntimePluginId, parseSafePluginDescription } from './runtime-plugin'

/** 来源独立于 Runtime 的 scope；发现项永远不是可启停、可卸载的安装项。 */
export type PluginDiscoverySource = 'app' | 'user'
export type PluginDiscoveryRoot = 'plugins' | 'installed-plugins'
export type PluginRegistryState = 'missing' | 'invalid' | 'empty' | 'ready' | 'partial'
export type PluginDiscoveryState = 'identified' | 'unidentified' | 'invalid'

export interface RuntimePluginDiscovery {
  discoveryId: string
  source: PluginDiscoverySource
  root: PluginDiscoveryRoot
  directoryName: string
  state: PluginDiscoveryState
  pluginId?: string
  displayName?: string
  version?: string
  description?: string
}

export interface PluginSourceReport {
  source: PluginDiscoverySource
  state: 'missing' | 'ready' | 'invalid'
  registryState: PluginRegistryState
  rejectedCount: number
  truncated: boolean
}

export interface RuntimePluginDiscoverySnapshot {
  items: RuntimePluginDiscovery[]
  sources: PluginSourceReport[]
}

export const PLUGIN_DISCOVERY_CHANNELS = {
  list: 'app:list-plugin-discoveries',
  reveal: 'app:reveal-plugin-discovery'
} as const

export interface PluginDiscoveryDesktopApi {
  listPluginDiscoveries: () => Promise<DesktopIpcResult<RuntimePluginDiscoverySnapshot>>
  revealPluginDiscovery: (discoveryId: string) => Promise<DesktopIpcResult<null>>
}

export const MAX_PLUGIN_DISCOVERIES = 256

/** ID 由来源、固定根和目录名组成；不能将它当作 CLI pluginId 使用。 */
export function pluginDiscoveryId(
  source: PluginDiscoverySource,
  root: PluginDiscoveryRoot,
  directoryName: string
): string {
  return `${source}:${root}:${directoryName}`
}

/** 仓库键仅限单层磁盘目录名；比逻辑插件身份更严格，禁止隐藏项与命令选项。 */
export function isPluginRepositoryKey(value: unknown): value is string {
  return (
    isRuntimePluginId(value) &&
    value.length <= 256 &&
    !value.startsWith('.') &&
    !value.startsWith('-') &&
    !/\p{Cc}|:/u.test(value)
  )
}

/** 窄 DTO 过滤：不携带绝对路径、命令、环境、信任和伪造组件数。 */
export function parseRuntimePluginDiscoverySnapshot(
  value: unknown
): RuntimePluginDiscoverySnapshot | null {
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.sources)) return null
  if (value.items.length > MAX_PLUGIN_DISCOVERIES * 2 || value.sources.length > 2) return null
  const items: RuntimePluginDiscovery[] = []
  const seen = new Set<string>()
  for (const raw of value.items) {
    if (!isRecord(raw)) continue
    if (raw.source !== 'app' && raw.source !== 'user') continue
    if (raw.root !== 'plugins' && raw.root !== 'installed-plugins') continue
    if (!isPluginRepositoryKey(raw.directoryName)) continue
    if (!['identified', 'unidentified', 'invalid'].includes(String(raw.state))) continue
    const discoveryId = pluginDiscoveryId(raw.source, raw.root, raw.directoryName)
    if (raw.discoveryId !== discoveryId || seen.has(discoveryId)) continue
    const item: RuntimePluginDiscovery = {
      discoveryId,
      source: raw.source,
      root: raw.root,
      directoryName: raw.directoryName,
      state: raw.state as PluginDiscoveryState
    }
    if (item.state === 'identified') {
      if (!isRuntimePluginId(raw.pluginId)) continue
      item.pluginId = raw.pluginId
      if (safeLabel(raw.displayName, 256)) item.displayName = raw.displayName
      if (safeLabel(raw.version, 64)) item.version = raw.version
      const description = parseSafePluginDescription(raw.description)
      if (description) item.description = description
    }
    seen.add(discoveryId)
    items.push(item)
  }
  const sources: PluginSourceReport[] = []
  for (const raw of value.sources) {
    if (!isRecord(raw) || (raw.source !== 'app' && raw.source !== 'user')) return null
    if (sources.some((source) => source.source === raw.source)) return null
    if (!['missing', 'ready', 'invalid'].includes(String(raw.state))) return null
    if (!['missing', 'invalid', 'empty', 'ready', 'partial'].includes(String(raw.registryState))) {
      return null
    }
    if (
      !Number.isSafeInteger(raw.rejectedCount) ||
      (raw.rejectedCount as number) < 0 ||
      typeof raw.truncated !== 'boolean'
    ) return null
    sources.push({
      source: raw.source,
      state: raw.state as PluginSourceReport['state'],
      registryState: raw.registryState as PluginRegistryState,
      rejectedCount: raw.rejectedCount as number,
      truncated: raw.truncated
    })
  }
  return { items, sources }
}

/** 标签仅用于展示，拒绝控制字符和路径分隔符，避免透传路径。 */
function safeLabel(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    !/[\p{Cc}/\\]/u.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

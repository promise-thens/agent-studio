import { isAppAppearanceMode, type AppAppearanceState } from '../shared/app-appearance'
import {
  APP_INVOKE_CHANNELS,
  type AppGrokConfigDocument,
  type AppPluginEnabledState
} from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import {
  isGrokMemoryId,
  type GrokMemoryDocument,
  type GrokMemoryEnabledState,
  type GrokMemorySummary
} from '../shared/grok-memory'
import { GROK_CONFIG_MAX_BYTES } from '../shared/grok-config-hints'
import {
  isMcpServerName,
  isMcpTransportKind,
  type McpServerInput,
  type McpServerSummary
} from '../shared/mcp-server-config'
import {
  isMarketplacePluginName,
  type MarketplacePluginSummary
} from '../shared/runtime-marketplace-plugin'
import {
  isRuntimePluginId,
  type RuntimePluginDetail,
  type RuntimePluginSummary
} from '../shared/runtime-plugin'
import type { MacosFolderAccessNotice } from '../shared/macos-folder-access'
import type { DeletionPreview, ProjectSummary } from '../shared/task-history'
import type { DesktopIpcMain } from './ipc-types'
import {
  DesktopIpcFailure,
  runDesktopIpcOperation,
  type TrustedIpcInvokeEvent
} from './security/ipc-sender-validation'

export interface AppIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  chooseProject: () => Promise<ProjectSummary | null>
  listProjects: () => Promise<ProjectSummary[]>
  revealProject: (projectId: string) => Promise<void>
  removeProject: (projectId: string) => Promise<void>
  previewProjectHistoryDeletion: (projectId: string) => Promise<DeletionPreview>
  deleteProjectHistory: (projectId: string, token: string) => Promise<void>
  getAppearance: () => AppAppearanceState | Promise<AppAppearanceState>
  setAppearance: (mode: AppAppearanceState['mode']) => Promise<AppAppearanceState>
  listPlugins: () => Promise<RuntimePluginSummary[]>
  getPlugin: (pluginId: string) => Promise<RuntimePluginDetail | null>
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<AppPluginEnabledState>
  getGrokConfig: () => Promise<AppGrokConfigDocument>
  saveGrokConfig: (text: string) => Promise<void>
  listMemories: (projectHint?: string) => Promise<GrokMemorySummary[]>
  getMemory: (memoryId: string) => Promise<GrokMemoryDocument>
  saveMemory: (memoryId: string, markdown: string) => Promise<GrokMemoryDocument>
  deleteMemory: (memoryId: string) => Promise<void>
  getMemoryEnabled: () => Promise<GrokMemoryEnabledState>
  setMemoryEnabled: (enabled: boolean) => Promise<GrokMemoryEnabledState>
  listMcpServers: (projectId?: string) => Promise<McpServerSummary[]>
  upsertMcpServer: (input: McpServerInput) => Promise<McpServerSummary>
  deleteMcpServer: (name: string) => Promise<void>
  listMarketplacePlugins: () => Promise<MarketplacePluginSummary[]>
  installPlugin: (input: { name: string; trust: boolean }) => Promise<null>
  uninstallPlugin: (input: { pluginId: string }) => Promise<null>
  addMarketplaceSource: (input: { gitUrl: string }) => Promise<null>
  probeMacosFolderAccess: (projectId: string) => Promise<MacosFolderAccessNotice>
  openMacosFilesPrivacySettings: () => Promise<void>
  sanitizeError: (error: unknown) => string
}

const MAX_IDENTIFIER_BYTES = 4 * 1024
const MAX_MEMORY_MARKDOWN_BYTES = 256 * 1024
const MAX_PROJECT_HINT_BYTES = 256
const MAX_MARKETPLACE_GIT_URL_BYTES = 2_048

function readRequest(args: unknown[], fields: readonly string[]): Record<string, unknown> {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  const record = args[0] as Record<string, unknown>
  if (Object.keys(record).some((key) => !fields.includes(key))) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return record
}

function readOptionalRequest(args: unknown[], fields: readonly string[]): Record<string, unknown> {
  if (args.length === 0) return {}
  return readRequest(args, fields)
}

function readText(
  record: Record<string, unknown>,
  field: string,
  maxBytes = MAX_IDENTIFIER_BYTES
): string {
  const value = record[field]
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return value
}

function readOptionalText(
  record: Record<string, unknown>,
  field: string,
  maxBytes = MAX_IDENTIFIER_BYTES
): string | undefined {
  if (!(field in record) || record[field] === undefined) return undefined
  return readText(record, field, maxBytes)
}

/** 注册 Project 管理、外观偏好与插件安装 IPC，不向 Renderer 暴露 Dialog、路径、CLI 输出或 nativeTheme。 */
export function registerAppIpcHandlers(dependencies: AppIpcDependencies): void {
  const register = <T>(channel: string, operation: (args: unknown[]) => Promise<T> | T): void => {
    dependencies.ipcMain.handle(channel, (event, ...args): Promise<DesktopIpcResult<T>> =>
      runDesktopIpcOperation(async () => {
        dependencies.assertTrustedSender(event)
        return operation(args)
      }, dependencies.sanitizeError)
    )
  }

  register(APP_INVOKE_CHANNELS.chooseProject, (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.chooseProject()
  })
  register(APP_INVOKE_CHANNELS.listProjects, (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.listProjects()
  })
  register(APP_INVOKE_CHANNELS.revealProject, async (args) => {
    const request = readRequest(args, ['projectId'])
    await dependencies.revealProject(readText(request, 'projectId'))
    return null
  })
  register(APP_INVOKE_CHANNELS.removeProject, async (args) => {
    const request = readRequest(args, ['projectId'])
    await dependencies.removeProject(readText(request, 'projectId'))
    return null
  })
  register(APP_INVOKE_CHANNELS.previewProjectHistoryDeletion, (args) => {
    const request = readRequest(args, ['projectId'])
    return dependencies.previewProjectHistoryDeletion(readText(request, 'projectId'))
  })
  register(APP_INVOKE_CHANNELS.deleteProjectHistory, async (args) => {
    const request = readRequest(args, ['projectId', 'token'])
    await dependencies.deleteProjectHistory(
      readText(request, 'projectId'),
      readText(request, 'token')
    )
    return null
  })
  register(APP_INVOKE_CHANNELS.getAppearance, (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.getAppearance()
  })
  register(APP_INVOKE_CHANNELS.setAppearance, (args) => {
    const request = readRequest(args, ['mode'])
    const mode = request.mode
    if (!isAppAppearanceMode(mode)) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.setAppearance(mode)
  })
  register(APP_INVOKE_CHANNELS.listPlugins, (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.listPlugins()
  })
  /**
   * pluginId 禁止含 `/` `\`：否则 join(plugins, id) 会在扫描前越出受管目录。
   * 格式非法用 invalid-input；格式合法但库存没有该项才用 not-found，便于 UI 区分。
   */
  register(APP_INVOKE_CHANNELS.getPlugin, async (args) => {
    const request = readRequest(args, ['pluginId'])
    const pluginId = readText(request, 'pluginId')
    if (!isRuntimePluginId(pluginId)) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    const detail = await dependencies.getPlugin(pluginId)
    if (!detail) {
      throw new DesktopIpcFailure('not-found', '未找到指定插件。')
    }
    return detail
  })
  register(APP_INVOKE_CHANNELS.setPluginEnabled, async (args) => {
    const request = readRequest(args, ['pluginId', 'enabled'])
    const pluginId = readText(request, 'pluginId')
    if (!isRuntimePluginId(pluginId) || typeof request.enabled !== 'boolean') {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    return dependencies.setPluginEnabled(pluginId, request.enabled)
  })
  register(APP_INVOKE_CHANNELS.getGrokConfig, (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.getGrokConfig()
  })
  register(APP_INVOKE_CHANNELS.saveGrokConfig, async (args) => {
    const request = readRequest(args, ['text'])
    const text = request.text
    if (typeof text !== 'string' || text.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', '配置文本无效。')
    }
    if (Buffer.byteLength(text, 'utf8') > GROK_CONFIG_MAX_BYTES) {
      throw new DesktopIpcFailure('payload-too-large', '配置超过 128 KiB 上限。')
    }
    await dependencies.saveGrokConfig(text)
    return null
  })
  register(APP_INVOKE_CHANNELS.listMemories, (args) => {
    const request = readOptionalRequest(args, ['projectHint'])
    return dependencies.listMemories(
      readOptionalText(request, 'projectHint', MAX_PROJECT_HINT_BYTES)
    )
  })
  register(APP_INVOKE_CHANNELS.getMemory, (args) => {
    const request = readRequest(args, ['memoryId'])
    const memoryId = readText(request, 'memoryId')
    if (!isGrokMemoryId(memoryId)) throw new DesktopIpcFailure('invalid-input', '记忆标识无效。')
    return dependencies.getMemory(memoryId)
  })
  register(APP_INVOKE_CHANNELS.saveMemory, (args) => {
    const request = readRequest(args, ['memoryId', 'markdown'])
    const memoryId = readText(request, 'memoryId')
    if (!isGrokMemoryId(memoryId)) throw new DesktopIpcFailure('invalid-input', '记忆标识无效。')
    const markdown = request.markdown
    if (typeof markdown !== 'string' || markdown.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', '记忆内容无效。')
    }
    if (Buffer.byteLength(markdown, 'utf8') > MAX_MEMORY_MARKDOWN_BYTES) {
      throw new DesktopIpcFailure('payload-too-large', '记忆内容超过 256 KiB。')
    }
    return dependencies.saveMemory(memoryId, markdown)
  })
  register(APP_INVOKE_CHANNELS.deleteMemory, async (args) => {
    const request = readRequest(args, ['memoryId'])
    const memoryId = readText(request, 'memoryId')
    if (!isGrokMemoryId(memoryId)) throw new DesktopIpcFailure('invalid-input', '记忆标识无效。')
    await dependencies.deleteMemory(memoryId)
    return null
  })
  register(APP_INVOKE_CHANNELS.getMemoryEnabled, (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.getMemoryEnabled()
  })
  register(APP_INVOKE_CHANNELS.setMemoryEnabled, (args) => {
    const request = readRequest(args, ['enabled'])
    if (typeof request.enabled !== 'boolean') {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    return dependencies.setMemoryEnabled(request.enabled)
  })
  register(APP_INVOKE_CHANNELS.listMcpServers, (args) => {
    const request = readOptionalRequest(args, ['projectId'])
    return dependencies.listMcpServers(readOptionalText(request, 'projectId'))
  })
  register(APP_INVOKE_CHANNELS.upsertMcpServer, (args) => {
    const request = readRequest(args, [
      'name',
      'enabled',
      'transport',
      'command',
      'args',
      'url',
      'env',
      'headers'
    ])
    return dependencies.upsertMcpServer(readMcpServerInput(request))
  })
  register(APP_INVOKE_CHANNELS.deleteMcpServer, async (args) => {
    const request = readRequest(args, ['name'])
    const name = readText(request, 'name')
    if (!isMcpServerName(name)) throw new DesktopIpcFailure('invalid-input', 'MCP 名称无效。')
    await dependencies.deleteMcpServer(name)
    return null
  })
  register(APP_INVOKE_CHANNELS.listMarketplacePlugins, (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    return dependencies.listMarketplacePlugins()
  })
  /**
   * 安装只允许当前货架已列出的 name；未知或含路径的 name 一律 invalid-input。
   * trust !== true 时把 trust:false 交给依赖，禁止附加 --trust，避免绕过确认框启用 Hooks/MCP。
   */
  register(APP_INVOKE_CHANNELS.installPlugin, async (args) => {
    const request = readRequest(args, ['name', 'trust'])
    const name = readText(request, 'name')
    if (!isMarketplacePluginName(name)) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    if ('trust' in request && typeof request.trust !== 'boolean') {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    const catalog = await dependencies.listMarketplacePlugins()
    if (!catalog.some((item) => item.name === name)) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    await dependencies.installPlugin({ name, trust: request.trust === true })
    return null
  })
  /**
   * 卸载走 Grok CLI；pluginId 必须同时过货架字符集，禁止前导 `-`。
   * 否则 `--keep-data` 会进 argv，被 CLI 当成选项而不是名称。
   * 不在 IPC 层附加 --keep-data，避免残留 MCP 状态目录说不清。
   */
  register(APP_INVOKE_CHANNELS.uninstallPlugin, async (args) => {
    const request = readRequest(args, ['pluginId'])
    const pluginId = readText(request, 'pluginId')
    if (!isMarketplacePluginName(pluginId)) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    await dependencies.uninstallPlugin({ pluginId })
    return null
  })
  /**
   * 加源只允许 https git URL：无 userinfo，禁止 query/hash（视为 Secret）。
   * 拒绝 http，避免把凭据或源地址走明文传输。
   */
  register(APP_INVOKE_CHANNELS.addMarketplaceSource, async (args) => {
    const request = readRequest(args, ['gitUrl'])
    const gitUrl = readMarketplaceGitUrl(readText(request, 'gitUrl', MAX_MARKETPLACE_GIT_URL_BYTES))
    await dependencies.addMarketplaceSource({ gitUrl })
    return null
  })
  /**
   * 只接受已注册 projectId。主进程用 canonicalRoot 读目录触发 TCC，
   * 不让 Renderer 指定路径，也不把绝对路径回传。
   */
  register(APP_INVOKE_CHANNELS.probeMacosFolderAccess, (args) => {
    const request = readRequest(args, ['projectId'])
    return dependencies.probeMacosFolderAccess(readText(request, 'projectId'))
  })
  register(APP_INVOKE_CHANNELS.openMacosFilesPrivacySettings, async (args) => {
    if (args.length !== 0) throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    await dependencies.openMacosFilesPrivacySettings()
    return null
  })
}

function readMcpServerInput(record: Record<string, unknown>): McpServerInput {
  const name = readText(record, 'name')
  if (
    !isMcpServerName(name) ||
    typeof record.enabled !== 'boolean' ||
    !isMcpTransportKind(record.transport)
  ) {
    throw new DesktopIpcFailure('invalid-input', 'MCP 配置无效。')
  }
  const input: McpServerInput = {
    name,
    enabled: record.enabled,
    transport: record.transport
  }
  if (typeof record.command === 'string') input.command = record.command
  if (Array.isArray(record.args)) {
    if (!record.args.every((item) => typeof item === 'string')) {
      throw new DesktopIpcFailure('invalid-input', 'MCP 配置无效。')
    }
    input.args = record.args
  }
  if (typeof record.url === 'string') input.url = record.url
  if (record.env !== undefined) input.env = readStringMap(record.env)
  if (record.headers !== undefined) input.headers = readStringMap(record.headers)
  return input
}

/**
 * 市场源只接受 https git URL。
 * userinfo / query / hash 与 Provider Base URL 同样视为可能的 Secret，禁止进入 CLI argv。
 */
function readMarketplaceGitUrl(value: string): string {
  const gitUrl = value.trim()
  if (gitUrl !== value || /\s/.test(gitUrl)) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  let parsed: URL
  try {
    parsed = new URL(gitUrl)
  } catch {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (parsed.protocol !== 'https:') {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (parsed.username || parsed.password) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (parsed.search || parsed.hash) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return gitUrl
}

function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DesktopIpcFailure('invalid-input', 'MCP 配置无效。')
  }
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') throw new DesktopIpcFailure('invalid-input', 'MCP 配置无效。')
    next[key] = item
  }
  return next
}

import { isAppAppearanceMode, type AppAppearanceState } from '../shared/app-appearance'
import { APP_INVOKE_CHANNELS } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import {
  isRuntimePluginId,
  type RuntimePluginDetail,
  type RuntimePluginSummary
} from '../shared/runtime-plugin'
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
  sanitizeError: (error: unknown) => string
}

const MAX_IDENTIFIER_BYTES = 4 * 1024

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

function readText(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES
  ) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return value
}

/** 注册 Project 管理与外观偏好 IPC，不向 Renderer 暴露 Dialog、路径或 nativeTheme。 */
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
}

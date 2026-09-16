import { parseHostBrowserBounds, parseHostBrowserNavigateUrl } from '../../shared/host-browser'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import { DesktopIpcFailure } from '../security/ipc-sender-validation'
import type { HostBrowserService } from './host-browser-service'

const MAX_TEXT_BYTES = 4 * 1024
const MAX_REQUEST_BYTES = 32 * 1024

export interface HostBrowserIpcDependencies {
  getHistory: () => { getTaskDetail(taskId: string): { projectId: string } } | null
  getHostBrowser: () => HostBrowserService | null
}

type RegisterTaskHandler = <T>(
  channel: string,
  operation: (args: unknown[]) => T | Promise<T>
) => void

/**
 * 宿主浏览器 IPC 走既有 task:* 包装器：先校验主窗口 sender，再读对象参数。
 * 用户导航不创建 Runtime OperationIntent。
 */
export function registerHostBrowserIpcHandlers(
  register: RegisterTaskHandler,
  dependencies: HostBrowserIpcDependencies
): void {
  register(TASK_INVOKE_CHANNELS.getBrowserChrome, (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readText(request, 'taskId')
    requireTaskProjectId(dependencies.getHistory, taskId)
    return requireHostBrowser(dependencies.getHostBrowser).getChrome()
  })

  register(TASK_INVOKE_CHANNELS.setBrowserOpen, (args) => {
    const request = readRequest(args, ['taskId', 'open'])
    const taskId = readText(request, 'taskId')
    const projectId = requireTaskProjectId(dependencies.getHistory, taskId)
    return requireHostBrowser(dependencies.getHostBrowser).setOpen(
      taskId,
      projectId,
      readBoolean(request, 'open')
    )
  })

  register(TASK_INVOKE_CHANNELS.userNavigateBrowser, (args) => {
    const request = readRequest(args, ['taskId', 'url'])
    const taskId = readText(request, 'taskId')
    const projectId = requireTaskProjectId(dependencies.getHistory, taskId)
    const href = parseHostBrowserNavigateUrl(readText(request, 'url'))
    if (!href) throw new DesktopIpcFailure('invalid-input', '只允许 http(s) 网页地址。')
    return requireHostBrowser(dependencies.getHostBrowser).userNavigate(taskId, projectId, href)
  })

  register(TASK_INVOKE_CHANNELS.updateBrowserBounds, (args) => {
    const request = readRequest(args, ['taskId', 'x', 'y', 'width', 'height'])
    const taskId = readText(request, 'taskId')
    requireTaskProjectId(dependencies.getHistory, taskId)
    const bounds = parseHostBrowserBounds({
      x: request.x,
      y: request.y,
      width: request.width,
      height: request.height
    })
    if (!bounds) throw new DesktopIpcFailure('invalid-input', '浏览器区域无效。')
    requireHostBrowser(dependencies.getHostBrowser).updateBounds(bounds)
    return null
  })
}

function requireHostBrowser(getHostBrowser: () => HostBrowserService | null): HostBrowserService {
  const browser = getHostBrowser()
  if (!browser) throw new DesktopIpcFailure('runtime-unavailable', '内置浏览器尚未初始化。')
  return browser
}

/**
 * 用 Task 历史解析 projectId。失败统一成 history-not-found，避免把 Store 路径回给 Renderer。
 */
function requireTaskProjectId(
  getHistory: HostBrowserIpcDependencies['getHistory'],
  taskId: string
): string {
  const history = getHistory()
  if (!history) throw new DesktopIpcFailure('runtime-unavailable', 'Task 历史服务尚未初始化。')
  try {
    const projectId = history.getTaskDetail(taskId).projectId
    if (!projectId.trim()) throw new Error('missing-project')
    return projectId
  } catch (error) {
    if (error instanceof DesktopIpcFailure) throw error
    throw new DesktopIpcFailure('history-not-found', '未找到指定 Task。')
  }
}

function readRequest(args: unknown[], allowed: readonly string[]): Record<string, unknown> {
  if (args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  const request = args[0] as Record<string, unknown>
  const serialized = JSON.stringify(request)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
  }
  if (Object.keys(request).some((key) => !allowed.includes(key))) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return request
}

function readText(request: Record<string, unknown>, field: string): string {
  const value = request[field]
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return value
}

function readBoolean(request: Record<string, unknown>, field: string): boolean {
  const value = request[field]
  if (value !== true && value !== false) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return value
}

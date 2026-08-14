import type {
  DeletionPreview,
  PermissionAuditPage,
  PersistedAgentEventPage,
  RuntimeResumeSummary,
  TaskHistoryDetail,
  TaskHistoryPage,
  TurnHistoryPage
} from '../../shared/task-history'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcMain } from '../ipc-types'
import {
  DesktopIpcFailure,
  runDesktopIpcOperation,
  type TrustedIpcInvokeEvent
} from '../security/ipc-sender-validation'

const MAX_TEXT_BYTES = 4 * 1024
const MAX_REQUEST_BYTES = 32 * 1024

export interface TaskHistoryIpcRuntime {
  listTasks(projectId: string, cursor?: string, limit?: number): Promise<TaskHistoryPage>
  getTaskDetail(taskId: string): TaskHistoryDetail
  listTurns(taskId: string, cursor?: string, limit?: number): Promise<TurnHistoryPage>
  listEvents(
    taskId: string,
    turnId: string,
    afterSequence?: number,
    limit?: number
  ): Promise<PersistedAgentEventPage>
  listPermissionAudits(
    taskId: string,
    cursor?: string,
    limit?: number
  ): Promise<PermissionAuditPage>
  resumeTask(taskId: string): Promise<RuntimeResumeSummary>
  previewTaskDeletion(taskId: string): Promise<DeletionPreview>
  deleteTask(taskId: string, token: string): Promise<void>
}

export interface TaskIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  getHistory: () => TaskHistoryIpcRuntime | null
  sanitizeError: (error: unknown) => string
}

function requireHistory(getHistory: TaskIpcDependencies['getHistory']): TaskHistoryIpcRuntime {
  const history = getHistory()
  if (!history) throw new DesktopIpcFailure('runtime-unavailable', 'Task 历史服务尚未初始化。')
  return history
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

function readText(
  request: Record<string, unknown>,
  field: string,
  optional = false
): string | undefined {
  const value = request[field]
  if (optional && value === undefined) return undefined
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

function readInteger(request: Record<string, unknown>, field: string): number | undefined {
  const value = request[field]
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return Number(value)
}

/** 注册固定 Task 历史查询、恢复与两阶段删除接口。 */
export function registerTaskIpcHandlers(dependencies: TaskIpcDependencies): void {
  const register = <T>(channel: string, operation: (args: unknown[]) => Promise<T> | T): void => {
    dependencies.ipcMain.handle(channel, (event, ...args): Promise<DesktopIpcResult<T>> =>
      runDesktopIpcOperation(async () => {
        dependencies.assertTrustedSender(event)
        return operation(args)
      }, dependencies.sanitizeError)
    )
  }
  register(TASK_INVOKE_CHANNELS.list, (args) => {
    const request = readRequest(args, ['projectId', 'cursor', 'limit'])
    return requireHistory(dependencies.getHistory).listTasks(
      readText(request, 'projectId')!,
      readText(request, 'cursor', true),
      readInteger(request, 'limit')
    )
  })
  register(TASK_INVOKE_CHANNELS.get, (args) => {
    const request = readRequest(args, ['taskId'])
    return requireHistory(dependencies.getHistory).getTaskDetail(readText(request, 'taskId')!)
  })
  register(TASK_INVOKE_CHANNELS.listTurns, (args) => {
    const request = readRequest(args, ['taskId', 'cursor', 'limit'])
    return requireHistory(dependencies.getHistory).listTurns(
      readText(request, 'taskId')!,
      readText(request, 'cursor', true),
      readInteger(request, 'limit')
    )
  })
  register(TASK_INVOKE_CHANNELS.listEvents, (args) => {
    const request = readRequest(args, ['taskId', 'turnId', 'afterSequence', 'limit'])
    return requireHistory(dependencies.getHistory).listEvents(
      readText(request, 'taskId')!,
      readText(request, 'turnId')!,
      readInteger(request, 'afterSequence'),
      readInteger(request, 'limit')
    )
  })
  register(TASK_INVOKE_CHANNELS.listPermissionAudits, (args) => {
    const request = readRequest(args, ['taskId', 'cursor', 'limit'])
    return requireHistory(dependencies.getHistory).listPermissionAudits(
      readText(request, 'taskId')!,
      readText(request, 'cursor', true),
      readInteger(request, 'limit')
    )
  })
  register(TASK_INVOKE_CHANNELS.resume, (args) => {
    const request = readRequest(args, ['taskId'])
    return requireHistory(dependencies.getHistory).resumeTask(readText(request, 'taskId')!)
  })
  register(TASK_INVOKE_CHANNELS.previewDelete, (args) => {
    const request = readRequest(args, ['taskId'])
    return requireHistory(dependencies.getHistory).previewTaskDeletion(readText(request, 'taskId')!)
  })
  register(TASK_INVOKE_CHANNELS.delete, async (args) => {
    const request = readRequest(args, ['taskId', 'token'])
    await requireHistory(dependencies.getHistory).deleteTask(
      readText(request, 'taskId')!,
      readText(request, 'token')!
    )
    return null
  })
}

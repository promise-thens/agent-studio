import type { DesktopIpcResult } from './ipc-result'
import type {
  DeletionPreview,
  PermissionAuditPage,
  PersistedAgentEventPage,
  RuntimeResumeSummary,
  TaskHistoryDetail,
  TaskHistoryPage,
  TurnHistoryPage
} from './task-history'

export const TASK_INVOKE_CHANNELS = {
  list: 'task:list',
  get: 'task:get',
  listTurns: 'task:list-turns',
  listEvents: 'task:list-events',
  listPermissionAudits: 'task:list-permission-audits',
  resume: 'task:resume',
  previewDelete: 'task:preview-delete',
  delete: 'task:delete'
} as const

export interface TaskDesktopApi {
  list: (
    projectId: string,
    cursor?: string,
    limit?: number
  ) => Promise<DesktopIpcResult<TaskHistoryPage>>
  get: (taskId: string) => Promise<DesktopIpcResult<TaskHistoryDetail>>
  listTurns: (
    taskId: string,
    cursor?: string,
    limit?: number
  ) => Promise<DesktopIpcResult<TurnHistoryPage>>
  listEvents: (
    taskId: string,
    turnId: string,
    afterSequence?: number,
    limit?: number
  ) => Promise<DesktopIpcResult<PersistedAgentEventPage>>
  listPermissionAudits: (
    taskId: string,
    cursor?: string,
    limit?: number
  ) => Promise<DesktopIpcResult<PermissionAuditPage>>
  resume: (taskId: string) => Promise<DesktopIpcResult<RuntimeResumeSummary>>
  previewDelete: (taskId: string) => Promise<DesktopIpcResult<DeletionPreview>>
  delete: (taskId: string, token: string) => Promise<DesktopIpcResult<null>>
}

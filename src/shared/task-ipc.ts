import type { PublicAgentEvent } from './agent-event'
import type {
  CommandEvidencePage,
  CommandExecutionEvidence,
  CommandTranscriptPage
} from './command'
import type { DesktopIpcResult } from './ipc-result'
import type {
  DeletionPreview,
  PermissionAuditPage,
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
  delete: 'task:delete',
  rename: 'task:rename',
  archive: 'task:archive',
  listCommandEvidence: 'task:list-command-evidence',
  getCommandEvidence: 'task:get-command-evidence',
  getCommandTranscript: 'task:get-command-transcript'
} as const

export interface PublicAgentEventPage {
  items: PublicAgentEvent[]
  nextAfterSequence?: number
  watermark: number
}

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
  ) => Promise<DesktopIpcResult<PublicAgentEventPage>>
  listPermissionAudits: (
    taskId: string,
    cursor?: string,
    limit?: number
  ) => Promise<DesktopIpcResult<PermissionAuditPage>>
  listCommandEvidence: (taskId: string) => Promise<DesktopIpcResult<CommandEvidencePage>>
  getCommandEvidence: (
    taskId: string,
    commandId: string
  ) => Promise<DesktopIpcResult<CommandExecutionEvidence>>
  getCommandTranscript: (
    taskId: string,
    commandId: string,
    offset?: number,
    limit?: number
  ) => Promise<DesktopIpcResult<CommandTranscriptPage>>
  resume: (taskId: string) => Promise<DesktopIpcResult<RuntimeResumeSummary>>
  previewDelete: (taskId: string) => Promise<DesktopIpcResult<DeletionPreview>>
  delete: (taskId: string, token: string) => Promise<DesktopIpcResult<null>>
  rename: (taskId: string, title: string) => Promise<DesktopIpcResult<TaskHistoryDetail>>
  archive: (taskId: string) => Promise<DesktopIpcResult<TaskHistoryDetail>>
}

import type { PublicAgentEvent } from './agent-event'
import type { TaskAttachmentDescriptor } from './task-attachment'
import type {
  CommandEvidencePage,
  CommandExecutionEvidence,
  CommandTranscriptPage
} from './command'
import type {
  FileDiffResult,
  LatestTurnRestorePreview,
  LatestTurnRestoreResult,
  TaskChangeSetQueryResult,
  TurnChangeCheckpoint
} from './git-review'
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
  getCommandTranscript: 'task:get-command-transcript',
  getChangeSet: 'task:get-change-set',
  getFileDiff: 'task:get-file-diff',
  listTurnCheckpoints: 'task:list-turn-checkpoints',
  previewLatestTurnRestore: 'task:preview-latest-turn-restore',
  restoreLatestTurn: 'task:restore-latest-turn',
  pickAttachments: 'task:pick-attachments',
  importDroppedPaths: 'task:import-dropped-paths',
  importClipboard: 'task:import-clipboard',
  listDraftAttachments: 'task:list-draft-attachments',
  removeAttachment: 'task:remove-attachment',
  getAttachmentPreview: 'task:get-attachment-preview',
  getAttachmentImage: 'task:get-attachment-image',
  getChangeMediaPreview: 'task:get-change-media-preview'
} as const

export interface PublicAgentEventPage {
  items: PublicAgentEvent[]
  nextAfterSequence?: number
  watermark: number
}

export interface TaskAttachmentPreview {
  descriptor: TaskAttachmentDescriptor
  thumbnailBase64?: string
  thumbnailMime?: string
}

export interface TaskAttachmentImage {
  originalName: string
  mimeType: string
  imageBase64: string
}

export interface TaskDesktopApi {
  /** 只解析真实拖入的 File；Renderer 不获得通用 Electron 或文件系统能力。 */
  resolveDroppedFilePaths: (files: readonly File[]) => string[]
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
  getChangeSet: (taskId: string) => Promise<DesktopIpcResult<TaskChangeSetQueryResult>>
  getFileDiff: (taskId: string, path: string) => Promise<DesktopIpcResult<FileDiffResult>>
  listTurnCheckpoints: (taskId: string) => Promise<DesktopIpcResult<TurnChangeCheckpoint[]>>
  previewLatestTurnRestore: (taskId: string) => Promise<DesktopIpcResult<LatestTurnRestorePreview>>
  restoreLatestTurn: (taskId: string) => Promise<DesktopIpcResult<LatestTurnRestoreResult>>
  resume: (taskId: string) => Promise<DesktopIpcResult<RuntimeResumeSummary>>
  previewDelete: (taskId: string) => Promise<DesktopIpcResult<DeletionPreview>>
  delete: (taskId: string, token: string) => Promise<DesktopIpcResult<null>>
  rename: (taskId: string, title: string) => Promise<DesktopIpcResult<TaskHistoryDetail>>
  archive: (taskId: string) => Promise<DesktopIpcResult<TaskHistoryDetail>>
  pickAttachments: (taskId: string) => Promise<DesktopIpcResult<TaskAttachmentDescriptor[]>>
  importDroppedPaths: (
    taskId: string,
    paths: string[]
  ) => Promise<DesktopIpcResult<TaskAttachmentDescriptor[]>>
  importClipboard: (taskId: string) => Promise<DesktopIpcResult<TaskAttachmentDescriptor[]>>
  listDraftAttachments: (taskId: string) => Promise<DesktopIpcResult<TaskAttachmentDescriptor[]>>
  removeAttachment: (taskId: string, attachmentId: string) => Promise<DesktopIpcResult<null>>
  getAttachmentPreview: (
    taskId: string,
    attachmentId: string
  ) => Promise<DesktopIpcResult<TaskAttachmentPreview>>
  getAttachmentImage: (
    taskId: string,
    attachmentId: string
  ) => Promise<DesktopIpcResult<TaskAttachmentImage>>
  getChangeMediaPreview: (
    taskId: string,
    path: string
  ) => Promise<DesktopIpcResult<TaskAttachmentPreview>>
}

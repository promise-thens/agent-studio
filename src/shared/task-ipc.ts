import type { PublicAgentEvent } from './agent-event'
import type { ArtifactContent, ArtifactDescriptor } from './artifact'
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
import type { AgentToolStatus } from './agent'
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
  listArtifacts: 'task:list-artifacts',
  getArtifactContent: 'task:get-artifact-content',
  pickAttachments: 'task:pick-attachments',
  importDroppedPaths: 'task:import-dropped-paths',
  importClipboard: 'task:import-clipboard',
  listDraftAttachments: 'task:list-draft-attachments',
  removeAttachment: 'task:remove-attachment',
  getAttachmentPreview: 'task:get-attachment-preview',
  getAttachmentImage: 'task:get-attachment-image',
  getChangeMediaPreview: 'task:get-change-media-preview',
  getSubagentActivity: 'task:get-subagent-activity'
} as const

/** 子代理工具来自 Grok 子 session 落盘；missing 表示父时间线没有孩子工具。 */
export type SubagentActivitySource = 'grok-session' | 'missing'

export interface SubagentActivityToolRow {
  toolCallId: string
  title: string
  status: AgentToolStatus | 'unknown'
}

/** 子代理真实最后回复；不是桌面端二次生成的摘要。 */
export interface SubagentActivityResult {
  text: string
  truncated: boolean
}

export interface SubagentActivityPage {
  source: SubagentActivitySource
  tools: SubagentActivityToolRow[]
  result?: SubagentActivityResult
}

const SUBAGENT_ACTIVITY_STATUSES = new Set<AgentToolStatus | 'unknown'>([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'unknown'
])

/** Preload 再校验主进程回包，丢掉未知键和超长列表。 */
export function parseSubagentActivityPage(value: unknown): SubagentActivityPage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.source !== 'grok-session' && record.source !== 'missing') return null
  if (!Array.isArray(record.tools) || record.tools.length > 200) return null
  const tools: SubagentActivityToolRow[] = []
  for (const item of record.tools) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const row = item as Record<string, unknown>
    if (typeof row.toolCallId !== 'string' || !row.toolCallId.trim() || row.toolCallId.length > 256)
      return null
    if (typeof row.title !== 'string' || row.title.length > 4 * 1024) return null
    if (!SUBAGENT_ACTIVITY_STATUSES.has(row.status as AgentToolStatus | 'unknown')) return null
    tools.push({
      toolCallId: row.toolCallId,
      title: row.title,
      status: row.status as AgentToolStatus | 'unknown'
    })
  }
  let result: SubagentActivityResult | undefined
  if (record.result != null) {
    if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
      return null
    }
    const rawResult = record.result as Record<string, unknown>
    if (
      typeof rawResult.text !== 'string' ||
      !rawResult.text.trim() ||
      rawResult.text.includes('\0') ||
      new TextEncoder().encode(rawResult.text).byteLength > 32 * 1024 ||
      typeof rawResult.truncated !== 'boolean'
    ) {
      return null
    }
    result = { text: rawResult.text, truncated: rawResult.truncated }
  }
  return { source: record.source, tools, ...(result ? { result } : {}) }
}

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
  listArtifacts: (taskId: string) => Promise<DesktopIpcResult<ArtifactDescriptor[]>>
  getArtifactContent: (
    taskId: string,
    artifactId: string
  ) => Promise<DesktopIpcResult<ArtifactContent>>
  getSubagentActivity: (
    taskId: string,
    shortId: string
  ) => Promise<DesktopIpcResult<SubagentActivityPage>>
}

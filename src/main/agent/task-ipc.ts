import {
  DEFAULT_COMMAND_TRANSCRIPT_PAGE_LIMIT,
  MAX_COMMAND_TRANSCRIPT_PAGE_LIMIT,
  takeLatestCommandEvidencePage,
  type CommandExecutionEvidence,
  type CommandTranscriptPage
} from '../../shared/command'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type {
  DeletionPreview,
  PermissionAuditPage,
  RuntimeResumeSummary,
  TaskHistoryDetail,
  TaskHistoryPage,
  TurnHistoryPage
} from '../../shared/task-history'
import type {
  FileDiffResult,
  LatestTurnRestorePreview,
  LatestTurnRestoreResult,
  TaskChangeSetQueryResult,
  TurnChangeCheckpoint
} from '../../shared/git-review'
import type { PublicAgentEventPage } from '../../shared/task-ipc'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import type { ArtifactContentService } from '../artifact/artifact-content-service'
import { ArtifactRegistryError, type ArtifactRegistry } from '../artifact/artifact-registry'
import { registerTaskAttachmentIpcHandlers } from './task-attachment-ipc'
import type { TaskAttachmentInbox } from './task-attachment-inbox'
import type { CommandEvidenceStore } from '../command/command-evidence-store'
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
  ): Promise<PublicAgentEventPage>
  listPermissionAudits(
    taskId: string,
    cursor?: string,
    limit?: number
  ): Promise<PermissionAuditPage>
  resumeTask(taskId: string): Promise<RuntimeResumeSummary>
  previewTaskDeletion(taskId: string): Promise<DeletionPreview>
  deleteTask(taskId: string, token: string): Promise<void>
  renameTask(taskId: string, title: string): Promise<TaskHistoryDetail>
  archiveTask(taskId: string): Promise<TaskHistoryDetail>
}

export interface TaskIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  getHistory: () => TaskHistoryIpcRuntime | null
  /** 只读命令证据；不得把 store 的写/执行入口暴露给 Renderer。 */
  getCommandEvidenceStore: () => Pick<
    CommandEvidenceStore,
    'listEvidence' | 'readEvidence' | 'readTranscript' | 'waitForWrites' | 'hasPersistIncomplete'
  > | null
  /** 只读 Git 审阅；不得暴露写 git / Broker。 */
  getGitReview?: () => {
    getChangeSet(taskId: string): Promise<TaskChangeSetQueryResult>
    getFileDiff(taskId: string, path: string): Promise<FileDiffResult>
    listTurnCheckpoints(taskId: string): Promise<TurnChangeCheckpoint[]>
    previewLatestTurnRestore(taskId: string): Promise<LatestTurnRestorePreview>
    restoreLatestTurn(taskId: string): Promise<LatestTurnRestoreResult>
  } | null
  sanitizeError: (error: unknown) => string
  getInbox?: () => TaskAttachmentInbox | null
  pickFiles?: () => Promise<string[] | null>
  readClipboard?: () => Promise<Array<{ originalName: string; bytes: Buffer }>>
  getChangeMediaPreview?: (
    taskId: string,
    path: string
  ) => Promise<import('../../shared/task-ipc').TaskAttachmentPreview>
  getArtifactRegistry?: () => ArtifactRegistry | null
  getArtifactContent?: () => ArtifactContentService | null
}

function requireHistory(getHistory: TaskIpcDependencies['getHistory']): TaskHistoryIpcRuntime {
  const history = getHistory()
  if (!history) throw new DesktopIpcFailure('runtime-unavailable', 'Task 历史服务尚未初始化。')
  return history
}

function requireCommandEvidenceStore(
  getStore: TaskIpcDependencies['getCommandEvidenceStore']
): Pick<
  CommandEvidenceStore,
  'listEvidence' | 'readEvidence' | 'readTranscript' | 'waitForWrites' | 'hasPersistIncomplete'
> {
  const store = getStore()
  if (!store) throw new DesktopIpcFailure('runtime-unavailable', '命令证据服务尚未初始化。')
  return store
}

/**
 * 查询前必须证明 Task 存在。失败统一成 history-not-found，避免把 Store 堆栈或路径回给 Renderer。
 */
function requireExistingTask(getHistory: TaskIpcDependencies['getHistory'], taskId: string): void {
  try {
    requireHistory(getHistory).getTaskDetail(taskId)
  } catch (error) {
    if (error instanceof DesktopIpcFailure) throw error
    throw new DesktopIpcFailure('history-not-found', '未找到指定 Task。')
  }
}

/**
 * 命令证据身份只能是单段标识。禁止 `/` `\` `.` `..`，避免被当成路径片段。
 */
function readCommandIdentity(request: Record<string, unknown>, field: string): string {
  const value = readText(request, field)!
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..') {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return value
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
  /** 重命名只改展示标题；空值、NUL 与超长由 readText 在进 Store 前拒绝。 */
  register(TASK_INVOKE_CHANNELS.rename, (args) => {
    const request = readRequest(args, ['taskId', 'title'])
    return requireHistory(dependencies.getHistory).renameTask(
      readText(request, 'taskId')!,
      readText(request, 'title')!
    )
  })
  /** 归档由主进程再次校验运行/等待审批状态，UI 禁用不是安全边界。 */
  register(TASK_INVOKE_CHANNELS.archive, (args) => {
    const request = readRequest(args, ['taskId'])
    return requireHistory(dependencies.getHistory).archiveTask(readText(request, 'taskId')!)
  })

  /**
   * 只读列出当前 Task 的命令证据摘要。Renderer 不得提交 executable/cwd/env 或 transcript 路径。
   * 查询前等待落盘，并只保留最新 N 条，避免最旧窗口把最近失败丢掉后假通过。
   */
  register(TASK_INVOKE_CHANNELS.listCommandEvidence, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readCommandIdentity(request, 'taskId')
    requireExistingTask(dependencies.getHistory, taskId)
    const store = requireCommandEvidenceStore(dependencies.getCommandEvidenceStore)
    await store.waitForWrites()
    const listed = await store.listEvidence(taskId)
    const scoped = listed.filter((item) => item.taskId === taskId)
    const page = takeLatestCommandEvidencePage(scoped)
    if (store.hasPersistIncomplete(taskId)) page.persistIncomplete = true
    return page
  })

  /**
   * 按 commandId 取单条证据。跨 Task 身份一律当不存在，禁止把另一 Task 的事实拼过来。
   */
  register(TASK_INVOKE_CHANNELS.getCommandEvidence, async (args) => {
    const request = readRequest(args, ['taskId', 'commandId'])
    const taskId = readCommandIdentity(request, 'taskId')
    const commandId = readCommandIdentity(request, 'commandId')
    requireExistingTask(dependencies.getHistory, taskId)
    const evidence = await requireCommandEvidenceStore(
      dependencies.getCommandEvidenceStore
    ).readEvidence(taskId, commandId)
    return requireScopedEvidence(evidence, taskId)
  })

  /**
   * 按 commandId 读取有界 transcript chunk。offset 是 chunk 下标；超限拒绝。
   * 文件缺失时只返回 missing/expired，永不回传路径。
   */
  register(TASK_INVOKE_CHANNELS.getCommandTranscript, async (args) => {
    const request = readRequest(args, ['taskId', 'commandId', 'offset', 'limit'])
    const taskId = readCommandIdentity(request, 'taskId')
    const commandId = readCommandIdentity(request, 'commandId')
    const offset = readInteger(request, 'offset') ?? 0
    const limit = readInteger(request, 'limit') ?? DEFAULT_COMMAND_TRANSCRIPT_PAGE_LIMIT
    if (limit < 1 || limit > MAX_COMMAND_TRANSCRIPT_PAGE_LIMIT) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    requireExistingTask(dependencies.getHistory, taskId)
    const store = requireCommandEvidenceStore(dependencies.getCommandEvidenceStore)
    const evidence = requireScopedEvidence(await store.readEvidence(taskId, commandId), taskId)
    return readCommandTranscriptPage(store, evidence, offset, limit)
  })

  /**
   * 只读返回当前 Task 的归因摘要与相对路径列表。不含绝对路径、fingerprint 或 porcelain。
   */
  register(TASK_INVOKE_CHANNELS.getChangeSet, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readCommandIdentity(request, 'taskId')
    requireExistingTask(dependencies.getHistory, taskId)
    return requireGitReview(dependencies.getGitReview).getChangeSet(taskId)
  })

  /**
   * 只读单文件 Diff。path 必须是相对路径；越界由服务返回 escaped，不读外部文件。
   */
  register(TASK_INVOKE_CHANNELS.getFileDiff, async (args) => {
    const request = readRequest(args, ['taskId', 'path'])
    const taskId = readCommandIdentity(request, 'taskId')
    const path = readText(request, 'path')!
    requireExistingTask(dependencies.getHistory, taskId)
    return requireGitReview(dependencies.getGitReview).getFileDiff(taskId, path)
  })

  /** 只读列出 Turn 检查点摘要，供审阅链使用。 */
  register(TASK_INVOKE_CHANNELS.listTurnCheckpoints, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readCommandIdentity(request, 'taskId')
    requireExistingTask(dependencies.getHistory, taskId)
    return requireGitReview(dependencies.getGitReview).listTurnCheckpoints(taskId)
  })

  /** 只读预览最新一轮恢复计划。主进程重算 predicate，不信任 UI。 */
  register(TASK_INVOKE_CHANNELS.previewLatestTurnRestore, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readCommandIdentity(request, 'taskId')
    requireExistingTask(dependencies.getHistory, taskId)
    return requireGitReview(dependencies.getGitReview).previewLatestTurnRestore(taskId)
  })

  /** 恢复前再次计算 predicate，经 Broker 写/删，禁止 git reset。 */
  register(TASK_INVOKE_CHANNELS.restoreLatestTurn, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readCommandIdentity(request, 'taskId')
    requireExistingTask(dependencies.getHistory, taskId)
    return requireGitReview(dependencies.getGitReview).restoreLatestTurn(taskId)
  })

  /**
   * 列出当前 Task 的 Artifact 描述符。先从 Git Review 同步候选，再重新验证可用性。
   * Renderer 只拿 opaque artifactId，不得提交相对路径。
   */
  register(TASK_INVOKE_CHANNELS.listArtifacts, async (args) => {
    const request = readRequest(args, ['taskId'])
    const taskId = readCommandIdentity(request, 'taskId')
    requireExistingTask(dependencies.getHistory, taskId)
    const registry = requireArtifactRegistry(dependencies.getArtifactRegistry)
    try {
      const changeSet = await requireGitReview(dependencies.getGitReview).getChangeSet(taskId)
      await registry.syncFromChangeSet(taskId, changeSet)
    } catch {
      // 变更集不可用时仍返回已持久化产物，避免 Git 失败把整个产物页打空。
    }
    try {
      return await registry.list(taskId)
    } catch (error) {
      throw wrapArtifactError(error)
    }
  })

  /**
   * 按 artifactId 读取有限内容。主进程每次重新校验 Task、路径和哈希。
   */
  register(TASK_INVOKE_CHANNELS.getArtifactContent, async (args) => {
    const request = readRequest(args, ['taskId', 'artifactId'])
    const taskId = readCommandIdentity(request, 'taskId')
    const artifactId = readCommandIdentity(request, 'artifactId')
    requireExistingTask(dependencies.getHistory, taskId)
    try {
      const content = await requireArtifactContent(dependencies.getArtifactContent).getContent(
        taskId,
        artifactId
      )
      if (content.descriptor.taskId !== taskId || content.descriptor.artifactId !== artifactId) {
        throw new DesktopIpcFailure('not-found', '未找到该 Artifact。')
      }
      return content
    } catch (error) {
      throw wrapArtifactError(error)
    }
  })

  registerTaskAttachmentIpcHandlers({
    ipcMain: dependencies.ipcMain,
    assertTrustedSender: dependencies.assertTrustedSender,
    sanitizeError: dependencies.sanitizeError,
    getInbox: () => dependencies.getInbox?.() ?? null,
    pickFiles: () => dependencies.pickFiles?.() ?? Promise.resolve(null),
    readClipboard: () => dependencies.readClipboard?.() ?? Promise.resolve([]),
    getChangeMediaPreview: dependencies.getChangeMediaPreview
  })
}

function wrapArtifactError(error: unknown): never {
  if (error instanceof DesktopIpcFailure) throw error
  if (error instanceof ArtifactRegistryError) {
    const code =
      error.code === 'not-found'
        ? 'not-found'
        : error.code === 'too-large'
          ? 'payload-too-large'
          : 'invalid-input'
    throw new DesktopIpcFailure(code, error.message)
  }
  throw error
}

function requireArtifactRegistry(
  getRegistry: TaskIpcDependencies['getArtifactRegistry']
): ArtifactRegistry {
  const registry = getRegistry?.() ?? null
  if (!registry) throw new DesktopIpcFailure('runtime-unavailable', 'Artifact 服务尚未初始化。')
  return registry
}

function requireArtifactContent(
  getContent: TaskIpcDependencies['getArtifactContent']
): ArtifactContentService {
  const service = getContent?.() ?? null
  if (!service) throw new DesktopIpcFailure('runtime-unavailable', 'Artifact 内容服务尚未初始化。')
  return service
}

function requireGitReview(getGitReview: TaskIpcDependencies['getGitReview']): {
  getChangeSet(taskId: string): Promise<TaskChangeSetQueryResult>
  getFileDiff(taskId: string, path: string): Promise<FileDiffResult>
  listTurnCheckpoints(taskId: string): Promise<TurnChangeCheckpoint[]>
  previewLatestTurnRestore(taskId: string): Promise<LatestTurnRestorePreview>
  restoreLatestTurn(taskId: string): Promise<LatestTurnRestoreResult>
} {
  const review = getGitReview?.() ?? null
  if (!review) throw new DesktopIpcFailure('runtime-unavailable', 'Git 审阅服务尚未初始化。')
  return review
}

/**
 * 证据必须属于请求的 Task；否则当成不存在，避免跨 Task 探测。
 */
function requireScopedEvidence(
  evidence: CommandExecutionEvidence | null,
  taskId: string
): CommandExecutionEvidence {
  if (!evidence || evidence.taskId !== taskId) {
    throw new DesktopIpcFailure('not-found', '未找到命令证据。')
  }
  return evidence
}

/**
 * 只切片已持久化的 chunk。transcript 丢失时保留 identity，把 retentionState 降为 missing/expired。
 */
async function readCommandTranscriptPage(
  store: Pick<CommandEvidenceStore, 'readTranscript'>,
  evidence: CommandExecutionEvidence,
  offset: number,
  limit: number
): Promise<CommandTranscriptPage> {
  const transcript = await store.readTranscript(
    evidence.taskId,
    evidence.transcriptRef.transcriptId
  )
  const scoped =
    transcript &&
    transcript.taskId === evidence.taskId &&
    transcript.commandId === evidence.commandId
      ? transcript
      : null
  const chunks = scoped?.chunks ?? []
  if (offset > chunks.length) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  const window = chunks.slice(offset, offset + limit).map((chunk) => ({
    stream: chunk.stream,
    text: chunk.text
  }))
  const nextIndex = offset + window.length
  const retentionState = scoped
    ? evidence.transcriptRef.retentionState
    : evidence.transcriptRef.retentionState === 'expired'
      ? 'expired'
      : 'missing'
  const page: CommandTranscriptPage = {
    taskId: evidence.taskId,
    commandId: evidence.commandId,
    transcriptId: evidence.transcriptRef.transcriptId,
    offset,
    limit,
    truncated:
      evidence.truncated || evidence.transcriptRef.truncated || retentionState !== 'retained',
    retentionState,
    chunks: window
  }
  if (nextIndex < chunks.length) page.nextOffset = nextIndex
  return page
}

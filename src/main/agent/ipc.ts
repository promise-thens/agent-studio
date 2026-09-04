import type { AgentRuntimeStatus, AgentTaskRuntimeState } from '../../shared/agent'
import type { AgentAvailableCommandSnapshot } from '../../shared/agent-available-command'
import type { ConversationEntryState } from '../../shared/task-history'
import {
  AGENT_INVOKE_CHANNELS,
  type AgentCancelTurnRequest,
  type AgentConnectRequest,
  type AgentCreateTaskRequest,
  type AgentEnterTaskRequest,
  type AgentGetTaskRuntimeStateRequest,
  type AgentRespondPermissionRequest,
  type AgentRespondQuestionRequest,
  type AgentSetPermissionModeRequest,
  type AgentSetPermissionModeResult,
  type AgentStartTurnRequest
} from '../../shared/agent-ipc'
import {
  isPublicTakeoverControlPrompt,
  isTaskPermissionMode,
  PUBLIC_TAKEOVER_CONTROL_PROMPT_BLOCKED_MESSAGE
} from '../../shared/task-takeover'
import { ATTACHMENT_LIMITS } from '../../shared/task-attachment'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import { parseAgentQuestionResponse } from '../../shared/agent-question'
import type {
  AgentStartTurnAdmissionResult,
  TaskExecutionSnapshot
} from '../../shared/task-execution'
import type { DesktopIpcMain } from '../ipc-types'
import {
  DesktopIpcFailure,
  runDesktopIpcOperation,
  type TrustedIpcInvokeEvent
} from '../security/ipc-sender-validation'
import { AgentServiceError } from './agent-service'

const MAX_REQUEST_BYTES = 512 * 1024
const MAX_PROJECT_ID_BYTES = 4 * 1024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_TASK_ID_BYTES = 4 * 1024
const MAX_REQUEST_ID_BYTES = 4 * 1024

export interface AgentIpcRuntime {
  getStatus: () => AgentRuntimeStatus
  getExecutionSnapshot?: () => TaskExecutionSnapshot
  connect: (projectId: string) => Promise<AgentRuntimeStatus>
  disconnect: () => Promise<AgentRuntimeStatus>
  createTask: (projectId: string) => Promise<AgentTaskRuntimeState>
  enterTask: (taskId: string) => Promise<ConversationEntryState>
  startTurn: (
    taskId: string,
    prompt: string,
    attachmentIds?: string[]
  ) => Promise<
    AgentStartTurnAdmissionResult | import('../../shared/agent').AgentTurnExecutionResult
  >
  cancelTurn: (request: AgentCancelTurnRequest | string) => Promise<void>
  getTaskRuntimeState: (taskId: string) => AgentTaskRuntimeState
  getAvailableCommands: (taskId: string) => AgentAvailableCommandSnapshot
  respondPermission: (request: AgentRespondPermissionRequest) => Promise<void>
  /** 问答提交必须存在；缺省会让 Renderer 以为成功，Grok 却一直 Waiting。 */
  respondQuestion: (request: AgentRespondQuestionRequest) => void
  setPermissionMode: (
    request: AgentSetPermissionModeRequest
  ) => Promise<AgentSetPermissionModeResult>
}

export interface AgentIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  getAgent: () => AgentIpcRuntime | null
  sanitizeError: (error: unknown) => string
}

function requireAgent(getAgent: () => AgentIpcRuntime | null): AgentIpcRuntime {
  const agent = getAgent()
  if (!agent) {
    throw new DesktopIpcFailure('runtime-unavailable', 'Agent Runtime 尚未初始化。')
  }
  return agent
}

function assertNoArguments(args: unknown[]): void {
  if (args.length !== 0) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readRequest(args: unknown[], allowedFields: readonly string[]): Record<string, unknown> {
  if (args.length !== 1 || !isPlainObject(args[0])) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }

  let serialized: string
  try {
    serialized = JSON.stringify(args[0])
  } catch {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (typeof serialized !== 'string') {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
  }

  const allowed = new Set(allowedFields)
  if (Object.keys(args[0]).some((field) => !allowed.has(field))) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return args[0]
}

function readRequiredString(
  request: Record<string, unknown>,
  field: string,
  maxBytes: number
): string {
  const value = request[field]
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
  }
  return value
}

function readConnectRequest(args: unknown[]): AgentConnectRequest {
  const request = readRequest(args, ['projectId'])
  return { projectId: readRequiredString(request, 'projectId', MAX_PROJECT_ID_BYTES) }
}

function readCreateTaskRequest(args: unknown[]): AgentCreateTaskRequest {
  const request = readRequest(args, ['projectId'])
  return { projectId: readRequiredString(request, 'projectId', MAX_PROJECT_ID_BYTES) }
}

function readEnterTaskRequest(args: unknown[]): AgentEnterTaskRequest {
  const request = readRequest(args, ['taskId'])
  return { taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES) }
}

function readOptionalPrompt(request: Record<string, unknown>): string {
  const value = request.prompt
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_PROMPT_BYTES) {
    throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
  }
  return value
}

function readAttachmentIds(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ATTACHMENT_LIMITS.maxPerTurn) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  const ids: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.includes('\0')) {
      throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
    }
    if (Buffer.byteLength(item, 'utf8') > MAX_TASK_ID_BYTES) {
      throw new DesktopIpcFailure('payload-too-large', '请求内容过大。')
    }
    if (!ids.includes(item)) ids.push(item)
  }
  return ids
}

function readStartTurnRequest(args: unknown[]): AgentStartTurnRequest {
  const request = readRequest(args, ['taskId', 'prompt', 'attachmentIds'])
  const attachmentIds = readAttachmentIds(request.attachmentIds)
  const prompt = readOptionalPrompt(request)
  if (!prompt.trim() && attachmentIds.length === 0) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  // 公开 startTurn 不得把广告命令当作用户 Turn；内部控制 turn 不经过本闸门。
  if (isPublicTakeoverControlPrompt(prompt)) {
    throw new DesktopIpcFailure('invalid-input', PUBLIC_TAKEOVER_CONTROL_PROMPT_BLOCKED_MESSAGE)
  }
  return {
    taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES),
    prompt,
    ...(attachmentIds.length > 0 ? { attachmentIds } : {})
  }
}

function readTaskRequest(args: unknown[]): AgentGetTaskRuntimeStateRequest {
  const request = readRequest(args, ['taskId'])
  return { taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES) }
}

function readCancelRequest(args: unknown[]): AgentCancelTurnRequest {
  const request = readRequest(args, ['executionId', 'taskId', 'turnId'])
  return {
    executionId: readRequiredString(request, 'executionId', MAX_TASK_ID_BYTES),
    taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES),
    turnId: readRequiredString(request, 'turnId', MAX_TASK_ID_BYTES)
  }
}

/**
 * 读取批准模式切换。takeover 必须带 confirmed: true。
 * 这是把审批交给 Grok always-approve，不是 Permission Broker 沙箱。
 */
function readSetPermissionModeRequest(args: unknown[]): AgentSetPermissionModeRequest {
  const request = readRequest(args, ['taskId', 'mode', 'confirmed'])
  const mode = request.mode
  if (!isTaskPermissionMode(mode)) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (request.confirmed !== undefined && typeof request.confirmed !== 'boolean') {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  if (mode === 'takeover' && request.confirmed !== true) {
    throw new DesktopIpcFailure('invalid-input', '打开完全接管前必须确认。')
  }
  return {
    taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES),
    mode,
    ...(typeof request.confirmed === 'boolean' ? { confirmed: request.confirmed } : {})
  }
}

function readPermissionRequest(args: unknown[]): AgentRespondPermissionRequest {
  const request = readRequest(args, ['approvalId', 'taskId', 'turnId', 'decision'])
  const decision = request.decision
  if (
    typeof decision !== 'string' ||
    !(['allow-once', 'allow-task', 'deny'] as const).includes(
      decision as AgentRespondPermissionRequest['decision']
    )
  ) {
    throw new DesktopIpcFailure('invalid-input', '请求参数无效。')
  }
  return {
    approvalId: readRequiredString(request, 'approvalId', MAX_REQUEST_ID_BYTES),
    taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES),
    turnId: readRequiredString(request, 'turnId', MAX_TASK_ID_BYTES),
    decision: decision as AgentRespondPermissionRequest['decision']
  }
}

/** 读取问答卡回答，并在 IPC 边界拒绝未知字段、非法答案值和过大载荷。 */
function readQuestionRequest(args: unknown[]): AgentRespondQuestionRequest {
  const request = readRequest(args, ['questionId', 'taskId', 'turnId', 'response'])
  const response = parseAgentQuestionResponse(request.response)
  if (!response) throw new DesktopIpcFailure('invalid-input', '问答回答无效。')
  return {
    questionId: readRequiredString(request, 'questionId', MAX_REQUEST_ID_BYTES),
    taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES),
    turnId: readRequiredString(request, 'turnId', MAX_TASK_ID_BYTES),
    response
  }
}

function assertConnectState(status: AgentRuntimeStatus): void {
  if (status.state === 'connecting' || status.state === 'busy') {
    throw new DesktopIpcFailure('invalid-state', 'Runtime 当前状态不允许连接。')
  }
}

function assertPromptState(status: AgentRuntimeStatus): void {
  if (status.state !== 'ready') {
    throw new DesktopIpcFailure('invalid-state', '请先连接 Agent Runtime。')
  }
}

function registerResultHandler<T>(
  dependencies: AgentIpcDependencies,
  channel: string,
  operation: (args: unknown[]) => T | Promise<T>
): void {
  dependencies.ipcMain.handle(channel, (event, ...args): Promise<DesktopIpcResult<T>> =>
    runDesktopIpcOperation(async () => {
      dependencies.assertTrustedSender(event)
      try {
        return await operation(args)
      } catch (error) {
        if (error instanceof AgentServiceError) {
          throw new DesktopIpcFailure(error.code, error.message)
        }
        throw error
      }
    }, dependencies.sanitizeError)
  )
}

/**
 * 注册固定的 Agent IPC Handler。
 * 每次调用都先校验来源和请求边界，再委托唯一 AgentService。
 */
export function registerAgentIpcHandlers(dependencies: AgentIpcDependencies): void {
  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.getStatus, (args) => {
    assertNoArguments(args)
    return requireAgent(dependencies.getAgent).getStatus()
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.getExecutionSnapshot, (args) => {
    assertNoArguments(args)
    return (
      requireAgent(dependencies.getAgent).getExecutionSnapshot?.() ?? {
        executorEpoch: 'legacy-agent-service',
        executionRevision: 0,
        execution: null
      }
    )
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.connect, async (args) => {
    const request = readConnectRequest(args)
    const agent = requireAgent(dependencies.getAgent)
    assertConnectState(agent.getStatus())
    return agent.connect(request.projectId)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.disconnect, (args) => {
    assertNoArguments(args)
    return requireAgent(dependencies.getAgent).disconnect()
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.createTask, async (args) => {
    const request = readCreateTaskRequest(args)
    const agent = requireAgent(dependencies.getAgent)
    assertPromptState(agent.getStatus())
    return agent.createTask(request.projectId)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.enterTask, async (args) => {
    const request = readEnterTaskRequest(args)
    return requireAgent(dependencies.getAgent).enterTask(request.taskId)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.startTurn, async (args) => {
    const request = readStartTurnRequest(args)
    const agent = requireAgent(dependencies.getAgent)
    assertPromptState(agent.getStatus())
    return request.attachmentIds?.length
      ? agent.startTurn(request.taskId, request.prompt, request.attachmentIds)
      : agent.startTurn(request.taskId, request.prompt)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.cancelTurn, async (args) => {
    const request = readCancelRequest(args)
    const agent = requireAgent(dependencies.getAgent)
    await agent.cancelTurn(agent.getExecutionSnapshot ? request : request.taskId)
    return null
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.getTaskRuntimeState, (args) => {
    const request = readTaskRequest(args)
    return requireAgent(dependencies.getAgent).getTaskRuntimeState(request.taskId)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.respondPermission, async (args) => {
    const request = readPermissionRequest(args)
    await requireAgent(dependencies.getAgent).respondPermission(request)
    return null
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.respondQuestion, (args) => {
    const request = readQuestionRequest(args)
    const agent = requireAgent(dependencies.getAgent)
    if (typeof agent.respondQuestion !== 'function') {
      throw new DesktopIpcFailure('operation-failed', '当前 Runtime 不支持问答提交。')
    }
    agent.respondQuestion(request)
    return null
  })

  /**
   * 读取 session 级斜杠命令快照。
   * 未知 Task 统一映射为 invalid-input，避免对外暴露独立的「命令快照 Task 查找」语义；
   * 命令执行仍走 startTurn 文本，故意不提供 execute-command IPC。
   */
  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.getAvailableCommands, (args) => {
    const request = readTaskRequest(args)
    try {
      return requireAgent(dependencies.getAgent).getAvailableCommands(request.taskId)
    } catch (error) {
      if (error instanceof AgentServiceError && error.code === 'task-not-found') {
        throw new DesktopIpcFailure('invalid-input', error.message)
      }
      throw error
    }
  })

  /**
   * 切换当前 Task 批准模式。sender 已由 registerResultHandler 校验为主窗口。
   * takeover 无 confirmed 在读参阶段拒绝，避免 Runtime 被误调。
   */
  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.setPermissionMode, async (args) => {
    const request = readSetPermissionModeRequest(args)
    const agent = requireAgent(dependencies.getAgent)
    assertPromptState(agent.getStatus())
    return agent.setPermissionMode(request)
  })
}

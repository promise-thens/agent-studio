import { isAbsolute } from 'node:path'
import type {
  AgentRuntimeStatus,
  AgentTaskRuntimeState,
  AgentTurnExecutionResult
} from '../../shared/agent'
import {
  AGENT_INVOKE_CHANNELS,
  type AgentCancelTurnRequest,
  type AgentConnectRequest,
  type AgentCreateTaskRequest,
  type AgentGetTaskRuntimeStateRequest,
  type AgentRespondPermissionRequest,
  type AgentStartTurnRequest
} from '../../shared/agent-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcMain } from '../ipc-types'
import {
  DesktopIpcFailure,
  runDesktopIpcOperation,
  type TrustedIpcInvokeEvent
} from '../security/ipc-sender-validation'
import { AgentServiceError } from './agent-service'

const MAX_REQUEST_BYTES = 512 * 1024
const MAX_WORKSPACE_BYTES = 4 * 1024
const MAX_PROMPT_BYTES = 64 * 1024
const MAX_TASK_ID_BYTES = 4 * 1024
const MAX_REQUEST_ID_BYTES = 4 * 1024
const MAX_OPTION_ID_BYTES = 256 * 1024

export interface AgentIpcRuntime {
  getStatus: () => AgentRuntimeStatus
  connect: (workspace: string) => Promise<AgentRuntimeStatus>
  disconnect: () => Promise<AgentRuntimeStatus>
  createTask: (workspace: string) => Promise<AgentTaskRuntimeState>
  startTurn: (taskId: string, prompt: string) => Promise<AgentTurnExecutionResult>
  cancelTurn: (taskId: string) => Promise<void>
  getTaskRuntimeState: (taskId: string) => AgentTaskRuntimeState
  respondPermission: (requestId: string, optionId?: string) => void
}

export interface AgentIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  getAgent: () => AgentIpcRuntime | null
  statPath: (path: string) => Promise<{ isDirectory: () => boolean }>
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
  const request = readRequest(args, ['workspace'])
  return { workspace: readRequiredString(request, 'workspace', MAX_WORKSPACE_BYTES) }
}

function readCreateTaskRequest(args: unknown[]): AgentCreateTaskRequest {
  const request = readRequest(args, ['workspace'])
  return { workspace: readRequiredString(request, 'workspace', MAX_WORKSPACE_BYTES) }
}

function readStartTurnRequest(args: unknown[]): AgentStartTurnRequest {
  const request = readRequest(args, ['taskId', 'prompt'])
  return {
    taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES),
    prompt: readRequiredString(request, 'prompt', MAX_PROMPT_BYTES)
  }
}

function readTaskRequest(
  args: unknown[]
): AgentCancelTurnRequest | AgentGetTaskRuntimeStateRequest {
  const request = readRequest(args, ['taskId'])
  return { taskId: readRequiredString(request, 'taskId', MAX_TASK_ID_BYTES) }
}

function readPermissionRequest(args: unknown[]): AgentRespondPermissionRequest {
  const request = readRequest(args, ['requestId', 'optionId'])
  const requestId = readRequiredString(request, 'requestId', MAX_REQUEST_ID_BYTES)
  if (!Object.hasOwn(request, 'optionId') || request.optionId === undefined) {
    return { requestId }
  }
  return {
    requestId,
    optionId: readRequiredString(request, 'optionId', MAX_OPTION_ID_BYTES)
  }
}

async function assertWorkspaceDirectory(
  workspace: string,
  statPath: AgentIpcDependencies['statPath']
): Promise<void> {
  if (!isAbsolute(workspace)) {
    throw new DesktopIpcFailure('invalid-workspace', '请选择有效的绝对目录。')
  }

  try {
    const stats = await statPath(workspace)
    if (!stats.isDirectory()) {
      throw new DesktopIpcFailure('invalid-workspace', '请选择现有目录。')
    }
  } catch (error) {
    if (error instanceof DesktopIpcFailure) throw error
    throw new DesktopIpcFailure('invalid-workspace', '请选择现有目录。')
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

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.connect, async (args) => {
    const request = readConnectRequest(args)
    await assertWorkspaceDirectory(request.workspace, dependencies.statPath)
    const agent = requireAgent(dependencies.getAgent)
    assertConnectState(agent.getStatus())
    return agent.connect(request.workspace)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.disconnect, (args) => {
    assertNoArguments(args)
    return requireAgent(dependencies.getAgent).disconnect()
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.createTask, async (args) => {
    const request = readCreateTaskRequest(args)
    await assertWorkspaceDirectory(request.workspace, dependencies.statPath)
    const agent = requireAgent(dependencies.getAgent)
    assertPromptState(agent.getStatus())
    return agent.createTask(request.workspace)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.startTurn, async (args) => {
    const request = readStartTurnRequest(args)
    const agent = requireAgent(dependencies.getAgent)
    assertPromptState(agent.getStatus())
    return agent.startTurn(request.taskId, request.prompt)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.cancelTurn, async (args) => {
    const request = readTaskRequest(args)
    await requireAgent(dependencies.getAgent).cancelTurn(request.taskId)
    return null
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.getTaskRuntimeState, (args) => {
    const request = readTaskRequest(args)
    return requireAgent(dependencies.getAgent).getTaskRuntimeState(request.taskId)
  })

  registerResultHandler(dependencies, AGENT_INVOKE_CHANNELS.respondPermission, (args) => {
    const request = readPermissionRequest(args)
    requireAgent(dependencies.getAgent).respondPermission(request.requestId, request.optionId)
    return null
  })
}

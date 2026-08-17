import type { AgentRuntimeId } from './agent'
import type { TurnModelSnapshot } from './task-history'

/** P0-08 单执行槽的产品执行状态；不复用旧 Task/Session 的宽泛状态联合。 */
export type TaskExecutionState =
  | 'queued'
  | 'running'
  | 'waiting-permission'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type TaskExecutionTerminalState = Extract<
  TaskExecutionState,
  'completed' | 'failed' | 'cancelled' | 'interrupted'
>

export type TaskExecutionFailureReason =
  'dispatch-failed' | 'runtime-error' | 'runtime-exit' | 'protocol-error' | 'persistence-failed'

export type TaskExecutionCancellationReason = 'cancelled-before-dispatch' | 'runtime-cancelled'

export type TaskExecutionInterruptionReason =
  | 'restart-recovery'
  | 'cancel-timeout'
  | 'forced-shutdown'
  | 'runtime-result-unknown'
  | 'persistence-failed'

/** Renderer 可见的环境身份；绝对执行路径只允许留在主进程内部。 */
export interface TaskExecutionEnvironment {
  environmentId: string
  kind: 'local'
  version: 1
}

interface TaskExecutionBase {
  executionId: string
  taskId: string
  turnId: string
  projectId: string
  runtimeId: AgentRuntimeId
  model: TurnModelSnapshot
  environment: TaskExecutionEnvironment
  acceptedAt: string
  stateChangedAt: string
}

export interface QueuedTaskExecution extends TaskExecutionBase {
  state: 'queued'
}

export interface RunningTaskExecution extends TaskExecutionBase {
  state: 'running'
  dispatchedAt: string
}

export interface WaitingPermissionTaskExecution extends TaskExecutionBase {
  state: 'waiting-permission'
  dispatchedAt: string
  pendingPermissionCount: number
}

export interface CancellingTaskExecution extends TaskExecutionBase {
  state: 'cancelling'
  dispatchedAt: string
  cancelRequestedAt: string
}

export interface CompletedTaskExecution extends TaskExecutionBase {
  state: 'completed'
  dispatchedAt: string
  endedAt: string
}

export interface FailedTaskExecution extends TaskExecutionBase {
  state: 'failed'
  dispatchedAt?: string
  endedAt: string
  reason: TaskExecutionFailureReason
}

export interface CancelledTaskExecution extends TaskExecutionBase {
  state: 'cancelled'
  dispatchedAt?: string
  cancelRequestedAt?: string
  endedAt: string
  reason: TaskExecutionCancellationReason
}

export interface InterruptedTaskExecution extends TaskExecutionBase {
  state: 'interrupted'
  dispatchedAt?: string
  cancelRequestedAt?: string
  endedAt: string
  reason: TaskExecutionInterruptionReason
}

/** 查询与 Push 共用的执行 DTO；判别联合排除非法时间戳和原因组合。 */
export type TaskExecutionDto =
  | QueuedTaskExecution
  | RunningTaskExecution
  | WaitingPermissionTaskExecution
  | CancellingTaskExecution
  | CompletedTaskExecution
  | FailedTaskExecution
  | CancelledTaskExecution
  | InterruptedTaskExecution

/** executionRevision 只在同一 executorEpoch 内比较，不能代替 Task revision 或事件 sequence。 */
export interface TaskExecutionSnapshot {
  executorEpoch: string
  executionRevision: number
  execution: TaskExecutionDto | null
}

/** Turn admission 可靠持久化后立即返回当前全量快照，不等待 Runtime 终态。 */
export type AgentStartTurnAdmissionResult = TaskExecutionSnapshot

/** 取消必须绑定一次 execution，避免陈旧 Renderer 误取消后续 Turn。 */
export interface TaskExecutionCancellationRequest {
  executionId: string
  taskId: string
  turnId: string
}

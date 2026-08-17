import type {
  CancelledTaskExecution,
  CancellingTaskExecution,
  CompletedTaskExecution,
  FailedTaskExecution,
  InterruptedTaskExecution,
  QueuedTaskExecution,
  RunningTaskExecution,
  TaskExecutionCancellationReason,
  TaskExecutionDto,
  TaskExecutionFailureReason,
  TaskExecutionInterruptionReason,
  TaskExecutionState,
  TaskExecutionTerminalState,
  WaitingPermissionTaskExecution
} from '../../shared/task-execution'

const TERMINAL_STATES = new Set<TaskExecutionState>([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])

const ALLOWED_TRANSITIONS: Readonly<Record<TaskExecutionState, ReadonlySet<TaskExecutionState>>> = {
  queued: new Set(['running', 'cancelled', 'failed', 'interrupted']),
  running: new Set([
    'waiting-permission',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ]),
  'waiting-permission': new Set([
    'running',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ]),
  cancelling: new Set(['completed', 'cancelled', 'failed', 'interrupted']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted: new Set()
}

export type TaskExecutionTransition =
  | { state: 'running'; dispatchedAt: string }
  | { state: 'waiting-permission'; pendingPermissionCount: number; stateChangedAt: string }
  | { state: 'cancelling'; cancelRequestedAt: string }
  | { state: 'completed'; endedAt: string }
  | { state: 'failed'; endedAt: string; reason: TaskExecutionFailureReason }
  | { state: 'cancelled'; endedAt: string; reason: TaskExecutionCancellationReason }
  | { state: 'interrupted'; endedAt: string; reason: TaskExecutionInterruptionReason }

export type TaskExecutionTransitionResult =
  | { kind: 'transitioned'; execution: TaskExecutionDto }
  | { kind: 'duplicate'; execution: TaskExecutionDto }
  | { kind: 'conflict'; execution: TaskExecutionDto }
  | { kind: 'invalid'; execution: TaskExecutionDto }

export function isTaskExecutionTerminal(
  state: TaskExecutionState
): state is TaskExecutionTerminalState {
  return TERMINAL_STATES.has(state)
}

export function canTransitionTaskExecution(
  from: TaskExecutionState,
  to: TaskExecutionState
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to)
}

/**
 * 纯函数提交一次执行状态变化。
 * 首个终态一经形成便不可覆盖；相同终态重复提交只返回幂等结果。
 */
export function transitionTaskExecution(
  current: TaskExecutionDto,
  transition: TaskExecutionTransition
): TaskExecutionTransitionResult {
  if (isTaskExecutionTerminal(current.state)) {
    const terminal = current as
      | CompletedTaskExecution
      | FailedTaskExecution
      | CancelledTaskExecution
      | InterruptedTaskExecution
    return isSameTerminal(terminal, transition)
      ? { kind: 'duplicate', execution: current }
      : { kind: 'conflict', execution: current }
  }

  if (transition.state === current.state) {
    if (current.state !== 'waiting-permission' || transition.state !== 'waiting-permission') {
      return { kind: 'duplicate', execution: current }
    }
    if (transition.pendingPermissionCount === current.pendingPermissionCount) {
      return { kind: 'duplicate', execution: current }
    }
    if (!isValidPendingPermissionCount(transition.pendingPermissionCount)) {
      return { kind: 'invalid', execution: current }
    }
    return {
      kind: 'transitioned',
      execution: {
        ...current,
        pendingPermissionCount: transition.pendingPermissionCount,
        stateChangedAt: transition.stateChangedAt
      }
    }
  }

  if (!canTransitionTaskExecution(current.state, transition.state)) {
    return { kind: 'invalid', execution: current }
  }

  const execution = buildTransitionedExecution(current, transition)
  return execution ? { kind: 'transitioned', execution } : { kind: 'invalid', execution: current }
}

function buildTransitionedExecution(
  current: TaskExecutionDto,
  transition: TaskExecutionTransition
): TaskExecutionDto | null {
  switch (transition.state) {
    case 'running':
      return toRunning(current, transition.dispatchedAt)
    case 'waiting-permission':
      if (
        !hasDispatchedAt(current) ||
        !isValidPendingPermissionCount(transition.pendingPermissionCount)
      ) {
        return null
      }
      return {
        ...baseFields(current, transition.stateChangedAt),
        state: 'waiting-permission',
        dispatchedAt: current.dispatchedAt,
        pendingPermissionCount: transition.pendingPermissionCount
      } satisfies WaitingPermissionTaskExecution
    case 'cancelling':
      if (!hasDispatchedAt(current)) return null
      return {
        ...baseFields(current, transition.cancelRequestedAt),
        state: 'cancelling',
        dispatchedAt: current.dispatchedAt,
        cancelRequestedAt: transition.cancelRequestedAt
      } satisfies CancellingTaskExecution
    case 'completed':
      if (!hasDispatchedAt(current)) return null
      return {
        ...baseFields(current, transition.endedAt),
        state: 'completed',
        dispatchedAt: current.dispatchedAt,
        endedAt: transition.endedAt
      } satisfies CompletedTaskExecution
    case 'failed':
      return {
        ...baseFields(current, transition.endedAt),
        state: 'failed',
        ...(hasDispatchedAt(current) ? { dispatchedAt: current.dispatchedAt } : {}),
        endedAt: transition.endedAt,
        reason: transition.reason
      } satisfies FailedTaskExecution
    case 'cancelled':
      return {
        ...baseFields(current, transition.endedAt),
        state: 'cancelled',
        ...(hasDispatchedAt(current) ? { dispatchedAt: current.dispatchedAt } : {}),
        ...(hasCancelRequestedAt(current) ? { cancelRequestedAt: current.cancelRequestedAt } : {}),
        endedAt: transition.endedAt,
        reason: transition.reason
      } satisfies CancelledTaskExecution
    case 'interrupted':
      return {
        ...baseFields(current, transition.endedAt),
        state: 'interrupted',
        ...(hasDispatchedAt(current) ? { dispatchedAt: current.dispatchedAt } : {}),
        ...(hasCancelRequestedAt(current) ? { cancelRequestedAt: current.cancelRequestedAt } : {}),
        endedAt: transition.endedAt,
        reason: transition.reason
      } satisfies InterruptedTaskExecution
  }
}

function toRunning(current: TaskExecutionDto, dispatchedAt: string): RunningTaskExecution | null {
  const preservedDispatchedAt = hasDispatchedAt(current) ? current.dispatchedAt : dispatchedAt
  if (!preservedDispatchedAt) return null
  return {
    ...baseFields(current, dispatchedAt),
    state: 'running',
    dispatchedAt: preservedDispatchedAt
  }
}

function baseFields(
  current: TaskExecutionDto,
  stateChangedAt: string
): Omit<QueuedTaskExecution, 'state'> {
  return {
    executionId: current.executionId,
    taskId: current.taskId,
    turnId: current.turnId,
    projectId: current.projectId,
    runtimeId: current.runtimeId,
    model: current.model,
    environment: current.environment,
    acceptedAt: current.acceptedAt,
    stateChangedAt
  }
}

function hasDispatchedAt(
  execution: TaskExecutionDto
): execution is Exclude<TaskExecutionDto, QueuedTaskExecution> & { dispatchedAt: string } {
  return 'dispatchedAt' in execution && typeof execution.dispatchedAt === 'string'
}

function hasCancelRequestedAt(
  execution: TaskExecutionDto
): execution is TaskExecutionDto & { cancelRequestedAt: string } {
  return 'cancelRequestedAt' in execution && typeof execution.cancelRequestedAt === 'string'
}

function isValidPendingPermissionCount(count: number): boolean {
  return Number.isSafeInteger(count) && count > 0
}

function isSameTerminal(
  current:
    | CompletedTaskExecution
    | FailedTaskExecution
    | CancelledTaskExecution
    | InterruptedTaskExecution,
  transition: TaskExecutionTransition
): boolean {
  if (current.state !== transition.state) return false
  if (current.state === 'completed' && transition.state === 'completed') return true
  return 'reason' in current && 'reason' in transition && current.reason === transition.reason
}

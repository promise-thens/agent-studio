import { describe, expect, it } from 'vitest'
import type { QueuedTaskExecution, TaskExecutionState } from '../../shared/task-execution'
import {
  canTransitionTaskExecution,
  isTaskExecutionTerminal,
  transitionTaskExecution,
  type TaskExecutionTransition
} from './task-execution-state'

const QUEUED: QueuedTaskExecution = {
  executionId: 'execution-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  projectId: 'project-1',
  runtimeId: 'grok',
  model: { modelId: 'model-1', displayName: 'Model 1' },
  environment: { environmentId: 'local:project-1', kind: 'local', version: 1 },
  state: 'queued',
  acceptedAt: '2026-08-17T10:00:00.000Z',
  stateChangedAt: '2026-08-17T10:00:00.000Z'
}

const ALLOWED: Record<TaskExecutionState, TaskExecutionState[]> = {
  queued: ['running', 'cancelled', 'failed', 'interrupted'],
  running: ['waiting-permission', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'],
  'waiting-permission': [
    'running',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'interrupted'
  ],
  cancelling: ['completed', 'cancelled', 'failed', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: []
}

const STATES = Object.keys(ALLOWED) as TaskExecutionState[]

describe('Task execution 状态机', () => {
  it('固定所有合法迁移并拒绝未声明组合', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        expect(canTransitionTaskExecution(from, to)).toBe(ALLOWED[from].includes(to))
      }
    }
  })

  it('只把四个收束状态识别为终态', () => {
    expect(STATES.filter(isTaskExecutionTerminal)).toEqual([
      'completed',
      'failed',
      'cancelled',
      'interrupted'
    ])
  })

  it('从 queued 进入 running 后保留 admission 事实', () => {
    const result = transitionTaskExecution(QUEUED, {
      state: 'running',
      dispatchedAt: '2026-08-17T10:00:01.000Z'
    })

    expect(result).toEqual({
      kind: 'transitioned',
      execution: {
        ...QUEUED,
        state: 'running',
        dispatchedAt: '2026-08-17T10:00:01.000Z',
        stateChangedAt: '2026-08-17T10:00:01.000Z'
      }
    })
  })

  it('多个审批只有正整数聚合，计数变化属于可观察更新', () => {
    const running = transition(QUEUED, {
      state: 'running',
      dispatchedAt: '2026-08-17T10:00:01.000Z'
    })
    const waiting = transition(running, {
      state: 'waiting-permission',
      pendingPermissionCount: 1,
      stateChangedAt: '2026-08-17T10:00:02.000Z'
    })

    expect(
      transitionTaskExecution(waiting, {
        state: 'waiting-permission',
        pendingPermissionCount: 2,
        stateChangedAt: '2026-08-17T10:00:03.000Z'
      })
    ).toMatchObject({
      kind: 'transitioned',
      execution: { state: 'waiting-permission', pendingPermissionCount: 2 }
    })
    expect(
      transitionTaskExecution(waiting, {
        state: 'waiting-permission',
        pendingPermissionCount: 0,
        stateChangedAt: '2026-08-17T10:00:03.000Z'
      })
    ).toMatchObject({ kind: 'invalid' })
  })

  it('cancelling 后可信正常完成可以先赢得终态', () => {
    const running = transition(QUEUED, {
      state: 'running',
      dispatchedAt: '2026-08-17T10:00:01.000Z'
    })
    const cancelling = transition(running, {
      state: 'cancelling',
      cancelRequestedAt: '2026-08-17T10:00:02.000Z'
    })
    const completed = transitionTaskExecution(cancelling, {
      state: 'completed',
      endedAt: '2026-08-17T10:00:03.000Z'
    })

    expect(completed).toMatchObject({
      kind: 'transitioned',
      execution: {
        state: 'completed',
        endedAt: '2026-08-17T10:00:03.000Z'
      }
    })
  })

  it('首个终态不可覆盖，相同终态和原因重复提交保持幂等', () => {
    const running = transition(QUEUED, {
      state: 'running',
      dispatchedAt: '2026-08-17T10:00:01.000Z'
    })
    const failed = transition(running, {
      state: 'failed',
      endedAt: '2026-08-17T10:00:02.000Z',
      reason: 'runtime-error'
    })

    expect(
      transitionTaskExecution(failed, {
        state: 'failed',
        endedAt: '2026-08-17T10:01:00.000Z',
        reason: 'runtime-error'
      })
    ).toEqual({ kind: 'duplicate', execution: failed })
    expect(
      transitionTaskExecution(failed, {
        state: 'completed',
        endedAt: '2026-08-17T10:01:00.000Z'
      })
    ).toEqual({ kind: 'conflict', execution: failed })
    expect(
      transitionTaskExecution(failed, {
        state: 'failed',
        endedAt: '2026-08-17T10:01:00.000Z',
        reason: 'runtime-exit'
      })
    ).toEqual({ kind: 'conflict', execution: failed })
  })

  it('queued 只能在未 dispatch 时取消或以有限原因失败', () => {
    const cancelled = transitionTaskExecution(QUEUED, {
      state: 'cancelled',
      endedAt: '2026-08-17T10:00:01.000Z',
      reason: 'cancelled-before-dispatch'
    })
    expect(cancelled).toMatchObject({
      kind: 'transitioned',
      execution: { state: 'cancelled' }
    })
    expect('dispatchedAt' in cancelled.execution).toBe(false)
    expect(
      transitionTaskExecution(QUEUED, {
        state: 'completed',
        endedAt: '2026-08-17T10:00:01.000Z'
      })
    ).toEqual({ kind: 'invalid', execution: QUEUED })
  })
})

function transition(
  current: Parameters<typeof transitionTaskExecution>[0],
  next: TaskExecutionTransition
): Parameters<typeof transitionTaskExecution>[0] {
  const result = transitionTaskExecution(current, next)
  expect(result.kind).toBe('transitioned')
  return result.execution
}

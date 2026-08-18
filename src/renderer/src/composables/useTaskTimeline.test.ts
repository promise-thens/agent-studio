import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { PublicAgentEvent } from '../../../shared/agent-event'
import type { TaskExecutionSnapshot } from '../../../shared/task-execution'
import type {
  PermissionAuditRecord,
  TaskHistoryDetail,
  TurnHistoryRecord
} from '../../../shared/task-history'
import { useTaskTimeline } from './useTaskTimeline'

const event: PublicAgentEvent = {
  runtimeId: 'grok',
  capabilityState: 'native',
  taskId: 'task-1',
  turnId: 'turn-1',
  sequence: 1,
  observedAt: '2026-08-18T00:00:00.000Z',
  kind: 'agent-message',
  text: 'hello'
}
const snapshot: TaskExecutionSnapshot = {
  executorEpoch: 'epoch-1',
  executionRevision: 0,
  execution: null
}
const historyDetail: TaskHistoryDetail = {
  taskId: 'task-1',
  projectId: 'project-1',
  runtimeId: 'grok',
  title: '历史任务',
  state: 'completed',
  turnCount: 1,
  resumable: false,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  revision: 1,
  environment: { kind: 'local', projectId: 'project-1' },
  permissionPolicy: { kind: 'legacy-runtime' }
}
const historyTurn: TurnHistoryRecord = {
  turnId: 'turn-1',
  taskId: 'task-1',
  promptDisplayText: '恢复这条历史任务',
  model: { modelId: 'grok-4.6' },
  state: 'completed',
  createdAt: '2026-08-18T00:00:00.000Z',
  eventCount: 1,
  eventBytes: 5,
  revision: 1
}
const permissionAudit: PermissionAuditRecord = {
  auditId: 'audit-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  projectId: 'project-1',
  environmentId: 'local:project-1',
  initiator: 'runtime',
  runtimeId: 'grok',
  operationType: 'execute-command',
  risk: 'L3',
  targetSummaries: ['command: sha256:test'],
  title: '权限决策：execute-command',
  impact: '测试审计投影',
  reason: 'user-allowed',
  scope: 'once',
  createdAt: '2026-08-18T00:00:00.000Z'
}

describe('useTaskTimeline', () => {
  it('先接收实时事件，再打开历史时不会丢失已到达事实', async () => {
    const onEvent = vi.fn<(listener: (event: PublicAgentEvent) => void) => () => void>(
      () => () => undefined
    )
    const controller = useTaskTimeline({
      getSnapshot: async () => snapshot,
      subscribeExecution: () => () => undefined,
      subscribeEvents: (listener) => {
        onEvent(listener)
        listener(event)
        return () => undefined
      }
    })
    await controller.start()
    expect(controller.factsByTaskId.value['task-1']?.turnsById['turn-1']).toBeDefined()
    expect(onEvent).toHaveBeenCalledOnce()
  })

  it('Task 之间隔离，删除后清理 facts 和 active identity', async () => {
    const controller = useTaskTimeline({
      getSnapshot: async () => snapshot,
      subscribeExecution: () => () => undefined,
      subscribeEvents: () => () => undefined
    })
    controller.acceptLiveEvent(event)
    await Promise.resolve()
    controller.setActiveTask('task-1')
    controller.removeTask('task-1')
    expect(controller.factsByTaskId.value['task-1']).toBeUndefined()
    expect(controller.activeTaskId.value).toBe('')
  })

  it('将同一微任务内的流式事件合并后再发布 Timeline facts', async () => {
    const controller = useTaskTimeline({ manageSubscriptions: false })
    const nextEvent: PublicAgentEvent = { ...event, sequence: 2, text: ' world' }

    controller.acceptLiveEvent(event)
    controller.acceptLiveEvent(nextEvent)
    controller.setActiveTask('task-1')
    expect(controller.factsByTaskId.value['task-1']).toBeUndefined()

    await Promise.resolve()

    expect(controller.activeTimeline.value?.turns[0]?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'message', text: 'hello world' })])
    )
  })

  it('终态事件会先清空流式批次并立即进入 Timeline', () => {
    const controller = useTaskTimeline({ manageSubscriptions: false })
    const complete: PublicAgentEvent = {
      ...event,
      sequence: 2,
      kind: 'turn-complete',
      outcome: 'completed'
    }

    controller.acceptLiveEvent(event)
    controller.acceptLiveEvent(complete)
    controller.setActiveTask('task-1')

    expect(controller.activeTimeline.value?.turns[0]?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', text: 'hello' }),
        expect.objectContaining({ kind: 'turn-complete', outcome: 'completed' })
      ])
    )
  })

  it('实时 admission 后 Timeline 立即显示用户 Prompt，不依赖历史回放', async () => {
    const controller = useTaskTimeline({ manageSubscriptions: false })
    controller.setActiveTask('task-1')

    controller.acceptLiveEvent(event)
    await Promise.resolve()
    expect(controller.activeTimeline.value?.turns[0]?.prompt).toBe('用户指令不可用')

    controller.acceptAdmission({
      taskId: 'task-1',
      turnId: 'turn-1',
      executionId: 'execution-1',
      promptDisplayText: '阅读 README.md，列出三条要点',
      model: { modelId: 'grok-4.6' },
      acceptedAt: '2026-08-18T00:00:00.000Z'
    })

    expect(controller.activeTimeline.value?.turns[0]?.prompt).toBe(
      '阅读 README.md，列出三条要点'
    )
    expect(controller.activeTimeline.value?.turns[0]?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'user-prompt',
          text: '阅读 README.md，列出三条要点',
          source: 'admission'
        }),
        expect.objectContaining({ kind: 'message', text: 'hello' })
      ])
    )
  })

  it('从响应式历史记录水合时保留 Timeline 和用户提示', () => {
    const controller = useTaskTimeline({
      getSnapshot: async () => snapshot,
      subscribeExecution: () => () => undefined,
      subscribeEvents: () => () => undefined
    })
    const detail = ref(historyDetail)
    const turns = ref([historyTurn])
    const eventsByTurn = ref({ [historyTurn.turnId]: [event] })
    const audits = ref([permissionAudit])

    controller.hydrateHistory(detail.value, turns.value, eventsByTurn.value, audits.value)

    expect(controller.activeTaskId.value).toBe(historyDetail.taskId)
    expect(controller.activeTimeline.value?.turns[0]?.prompt).toBe(historyTurn.promptDisplayText)
    expect(controller.activeTimeline.value?.turns[0]?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'permission-audit', audit: permissionAudit })
      ])
    )
  })

  it('再次水合历史分页后会把新增事件投影到 Timeline', () => {
    const controller = useTaskTimeline({
      getSnapshot: async () => snapshot,
      subscribeExecution: () => () => undefined,
      subscribeEvents: () => () => undefined
    })
    const nextEvent: PublicAgentEvent = { ...event, sequence: 2, text: ' world' }

    controller.hydrateHistory(historyDetail, [historyTurn], { [historyTurn.turnId]: [event] }, [
      permissionAudit
    ])
    controller.hydrateHistory(
      historyDetail,
      [historyTurn],
      { [historyTurn.turnId]: [event, nextEvent] },
      [permissionAudit]
    )

    expect(controller.activeTimeline.value?.turns[0]?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'message', text: 'hello world' })])
    )
  })
})

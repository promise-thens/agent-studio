import { describe, expect, it } from 'vitest'
import type { PublicAgentEvent } from '../../shared/agent-event'
import type { CommandExecutionEvidence } from '../../shared/command'
import type { TaskExecutionSnapshot } from '../../shared/task-execution'
import type { PermissionAuditRecord, TurnHistoryRecord } from '../../shared/task-history'
import {
  createTaskTimelineFacts,
  reduceTaskTimelineFacts,
  selectTaskTimeline
} from './task-timeline-reducer'

const TURN: TurnHistoryRecord = {
  taskId: 'task-1',
  turnId: 'turn-1',
  promptDisplayText: '执行测试',
  model: { modelId: 'model-1' },
  state: 'completed',
  createdAt: '2026-08-18T00:00:00.000Z',
  endedAt: '2026-08-18T00:00:03.000Z',
  eventCount: 5,
  eventBytes: 100,
  revision: 1
}
const BASE = {
  runtimeId: 'grok' as const,
  capabilityState: 'native' as const,
  taskId: 'task-1',
  turnId: 'turn-1',
  observedAt: '2026-08-18T00:00:01.000Z'
}
const EVENTS: PublicAgentEvent[] = [
  { ...BASE, sequence: 1, kind: 'agent-thought', text: '分析' },
  { ...BASE, sequence: 2, kind: 'tool-update', toolCallId: 'tool-1', status: 'in_progress' },
  {
    ...BASE,
    sequence: 3,
    kind: 'tool-call',
    toolCallId: 'tool-1',
    title: 'Vitest',
    status: 'completed'
  },
  { ...BASE, sequence: 4, kind: 'agent-message', text: '完成' },
  {
    ...BASE,
    sequence: 5,
    kind: 'turn-complete',
    outcome: 'completed',
    usage: { scope: 'turn', inputTokens: 1, outputTokens: 2, totalTokens: 3 }
  }
]

function snapshot(state: 'completed' | 'running' = 'completed'): TaskExecutionSnapshot {
  const execution =
    state === 'completed'
      ? {
          executionId: 'execution-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          projectId: 'project-1',
          runtimeId: 'grok' as const,
          model: { modelId: 'model-1' },
          environment: { kind: 'local' as const, version: 1 as const, environmentId: 'local:test' },
          state,
          acceptedAt: '2026-08-18T00:00:00.000Z',
          stateChangedAt: '2026-08-18T00:00:03.000Z',
          dispatchedAt: '2026-08-18T00:00:01.000Z',
          endedAt: '2026-08-18T00:00:03.000Z'
        }
      : {
          executionId: 'execution-1',
          taskId: 'task-1',
          turnId: 'turn-1',
          projectId: 'project-1',
          runtimeId: 'grok' as const,
          model: { modelId: 'model-1' },
          environment: { kind: 'local' as const, version: 1 as const, environmentId: 'local:test' },
          state,
          acceptedAt: '2026-08-18T00:00:00.000Z',
          stateChangedAt: '2026-08-18T00:00:01.000Z',
          dispatchedAt: '2026-08-18T00:00:01.000Z'
        }
  return { executorEpoch: 'epoch-1', executionRevision: 2, execution }
}

describe('Task Timeline reducer', () => {
  it('仅有实时事件时显示用户指令不可用，admission 到达后恢复 Prompt', () => {
    const withEvents = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'events/ingest-public',
      events: EVENTS
    })
    expect(
      selectTaskTimeline(withEvents, { executionSnapshot: snapshot('running') }).turns[0]
    ).toMatchObject({
      prompt: '用户指令不可用'
    })

    const withAdmission = reduceTaskTimelineFacts(withEvents, {
      type: 'turn/admitted',
      admission: {
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1',
        promptDisplayText: '实时用户指令',
        model: { modelId: 'model-1' },
        acceptedAt: '2026-08-18T00:00:00.000Z'
      }
    })
    const liveView = selectTaskTimeline(withAdmission, { executionSnapshot: snapshot('running') })
    expect(liveView.turns[0]?.prompt).toBe('实时用户指令')
    expect(liveView.turns[0]?.nodes[0]).toMatchObject({
      kind: 'user-prompt',
      text: '实时用户指令',
      source: 'admission'
    })

    const withHistory = reduceTaskTimelineFacts(withAdmission, {
      type: 'turns/upsert',
      turns: [TURN]
    })
    expect(
      selectTaskTimeline(withHistory, { executionSnapshot: snapshot() }).turns[0]?.prompt
    ).toBe(TURN.promptDisplayText)
  })

  it('实时与历史任意顺序输入收敛为同一投影', () => {
    const first = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      { type: 'events/ingest-public', events: EVENTS }
    )
    const second = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'events/ingest-public',
        events: [...EVENTS].reverse()
      }),
      { type: 'turns/upsert', turns: [TURN] }
    )
    expect(second).toEqual(first)
    const view = selectTaskTimeline(first, { executionSnapshot: snapshot() })
    expect(view.turns[0]?.nodes.map((node) => node.kind)).toEqual([
      'user-prompt',
      'thought',
      'tool',
      'message',
      'turn-complete'
    ])
    expect(view.turns[0]?.nodes.find((node) => node.kind === 'tool')).toMatchObject({
      title: 'Vitest',
      status: 'completed'
    })
    expect(view.turns[0]?.usage.turnUsage).toMatchObject({
      source: 'turn-complete',
      value: { totalTokens: 3 }
    })
  })

  it('相同 sequence 冲突不保留争议正文并生成有限 issue', () => {
    const first = { ...BASE, sequence: 1, kind: 'agent-message' as const, text: 'A' }
    const second = { ...first, text: 'B' }
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'events/ingest-public',
        events: [first]
      }),
      { type: 'events/ingest-public', events: [second] }
    )
    expect(state.turnsById['turn-1']?.eventsBySequence[1]).toEqual({
      kind: 'conflict',
      sequence: 1,
      observedKinds: ['agent-message']
    })
    expect(JSON.stringify(state)).not.toContain('"A"')
    expect(JSON.stringify(state)).not.toContain('"B"')
    expect(Object.values(state.integrityIssuesByKey)).toContainEqual(
      expect.objectContaining({ code: 'event-sequence-conflict', sequence: 1 })
    )
  })

  it('持久化终态优先于陈旧 execution，并明确状态冲突', () => {
    const state = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'turns/upsert',
      turns: [TURN]
    })
    const view = selectTaskTimeline(state, { executionSnapshot: snapshot('running') })
    expect(view.turns[0]).toMatchObject({
      status: 'completed',
      statusConflict: true,
      statusProvisional: false
    })
  })

  it('权限审计按 auditId 幂等归并，不产生可操作审批', () => {
    const audit: PermissionAuditRecord = {
      auditId: 'audit-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:test',
      initiator: 'runtime',
      runtimeId: 'grok',
      operationType: 'write-file',
      risk: 'L1',
      targetSummaries: ['path: src/a.ts'],
      title: '修改文件',
      impact: '写入文件',
      reason: 'user-allowed',
      scope: 'once',
      createdAt: '2026-08-18T00:00:02.000Z'
    }
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'permission-audits/merge',
        audits: [audit]
      }),
      { type: 'permission-audits/merge', audits: [audit] }
    )
    const view = selectTaskTimeline(state, {
      executionSnapshot: { executorEpoch: 'epoch', executionRevision: 0, execution: null }
    })
    expect(view.turns[0]?.nodes.filter((node) => node.kind === 'permission-audit')).toHaveLength(1)
  })

  it('合并连续的无 messageId 文本片段，但不跨越事件边界', () => {
    const messageChunks: Extract<PublicAgentEvent, { kind: 'agent-message' }>[] = Array.from(
      { length: 1000 },
      (_, index) => ({
        ...BASE,
        sequence: index + 1,
        kind: 'agent-message' as const,
        text: String(index)
      })
    )
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      {
        type: 'events/ingest-public',
        events: [
          ...messageChunks,
          { ...BASE, sequence: 1001, kind: 'agent-thought', text: '先' },
          { ...BASE, sequence: 1002, kind: 'agent-thought', text: '后' },
          {
            ...BASE,
            sequence: 1003,
            kind: 'tool-call',
            toolCallId: 'tool-boundary',
            title: '边界工具'
          },
          { ...BASE, sequence: 1004, kind: 'agent-thought', text: '分隔后' },
          { ...BASE, sequence: 1005, kind: 'agent-message', text: '尾部回复' }
        ]
      }
    )
    const nodes = selectTaskTimeline(state, { executionSnapshot: snapshot() }).turns[0]?.nodes ?? []
    const textNodes = nodes.filter(
      (node): node is Extract<(typeof nodes)[number], { kind: 'message' | 'thought' }> =>
        node.kind === 'message' || node.kind === 'thought'
    )

    expect(textNodes).toEqual([
      expect.objectContaining({
        kind: 'message',
        text: messageChunks.map((event) => event.text).join('')
      }),
      expect.objectContaining({ kind: 'thought', text: '先后' }),
      expect.objectContaining({ kind: 'thought', text: '分隔后' }),
      expect.objectContaining({ kind: 'message', text: '尾部回复' })
    ])
    expect(nodes.filter((node) => node.kind === 'tool')).toHaveLength(1)
  })

  it('同一 messageId 的文本不能跨 Runtime 图片合并', () => {
    const events: PublicAgentEvent[] = [
      { ...BASE, sequence: 1, kind: 'agent-message', text: '前', messageId: 'message-1' },
      {
        ...BASE,
        sequence: 2,
        kind: 'agent-attachment',
        attachmentId: 'attachment-1',
        attachmentKind: 'image',
        originalName: 'runtime-image.png'
      },
      { ...BASE, sequence: 3, kind: 'agent-message', text: '后', messageId: 'message-1' }
    ]
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      { type: 'events/ingest-public', events }
    )
    const nodes =
      selectTaskTimeline(state, { executionSnapshot: snapshot() }).turns[0]?.nodes.filter(
        (node) => node.kind === 'message' || node.kind === 'attachment'
      ) ?? []

    expect(nodes.map((node) => node.kind)).toEqual(['message', 'attachment', 'message'])
    expect(nodes[0]).toMatchObject({ kind: 'message', text: '前' })
    expect(nodes[1]).toMatchObject({ kind: 'attachment', attachmentId: 'attachment-1' })
    expect(nodes[2]).toMatchObject({ kind: 'message', text: '后' })
  })

  it('同一 Turn 连续三次 plan 快照只保留一张卡，entries 取最后一次且 nodeId 不含 sequence', () => {
    const firstEntries = [
      { content: '找现有 auth', priority: 'high' as const, status: 'pending' as const },
      { content: '改登录表单', priority: 'medium' as const, status: 'pending' as const },
      { content: '补测试', priority: 'low' as const, status: 'pending' as const }
    ]
    const secondEntries = [
      { content: '找现有 auth', priority: 'high' as const, status: 'completed' as const },
      { content: '改登录表单', priority: 'medium' as const, status: 'in_progress' as const },
      { content: '补测试', priority: 'low' as const, status: 'pending' as const }
    ]
    const thirdEntries = [
      { content: '找现有 auth', priority: 'high' as const, status: 'completed' as const },
      { content: '改登录表单', priority: 'medium' as const, status: 'completed' as const },
      { content: '补测试', priority: 'low' as const, status: 'completed' as const }
    ]
    const state = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'events/ingest-public',
      events: [
        { ...BASE, sequence: 1, kind: 'plan', entries: firstEntries },
        { ...BASE, sequence: 2, kind: 'plan', entries: secondEntries },
        { ...BASE, sequence: 3, kind: 'plan', entries: thirdEntries }
      ]
    })
    const nodes =
      selectTaskTimeline(state, { executionSnapshot: snapshot('running') }).turns[0]?.nodes ?? []
    const planNodes = nodes.filter((node) => node.kind === 'plan')

    expect(planNodes).toHaveLength(1)
    expect(planNodes[0]).toMatchObject({
      nodeId: 'task-1:turn-1:plan',
      kind: 'plan',
      entries: thirdEntries
    })
    expect(planNodes[0]?.nodeId).not.toContain(':plan:1')
    expect(planNodes[0]?.nodeId).not.toContain(':plan:2')
    expect(planNodes[0]?.nodeId).not.toContain(':plan:3')
  })

  it('把命令证据挂到匹配的工具节点，并只用证据推导验证结果', () => {
    const runtimeEvidence: CommandExecutionEvidence = {
      commandId: 'rt-cmd',
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'env-1',
      source: 'runtime-tool',
      displayCommand: 'pnpm test',
      cwd: '.',
      startedAt: '2026-08-18T00:00:01.000Z',
      endedAt: '2026-08-18T00:00:02.000Z',
      exitCode: 0,
      timedOut: false,
      status: 'succeeded',
      toolCallId: 'tool-1',
      transcriptRef: {
        transcriptId: 'tx-1',
        availableBytes: 2,
        truncated: false,
        encoding: 'utf-8',
        retentionPolicy: 'bounded',
        retentionState: 'retained'
      },
      truncated: false,
      trustLevel: 'runtime-reported'
    }
    const appEvidence: CommandExecutionEvidence = {
      commandId: 'app-cmd',
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'env-1',
      source: 'app-runner',
      displayCommand: 'node -e process.stdout.write("ok")',
      cwd: '.',
      startedAt: '2026-08-18T00:00:01.000Z',
      endedAt: '2026-08-18T00:00:02.000Z',
      exitCode: 0,
      timedOut: false,
      status: 'succeeded',
      transcriptRef: {
        transcriptId: 'tx-2',
        availableBytes: 2,
        truncated: false,
        encoding: 'utf-8',
        retentionPolicy: 'bounded',
        retentionState: 'retained'
      },
      truncated: false,
      trustLevel: 'app-enforced'
    }
    const withEvents = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      { type: 'events/ingest-public', events: EVENTS }
    )
    const emptyReview = selectTaskTimeline(withEvents, {
      executionSnapshot: snapshot()
    }).resultReview
    expect(emptyReview.validations).toEqual({ count: 0, availability: 'not-observed' })
    expect(emptyReview.commands).toEqual([])

    const withEvidence = reduceTaskTimelineFacts(withEvents, {
      type: 'command-evidence/replace',
      evidences: [runtimeEvidence, appEvidence]
    })
    const view = selectTaskTimeline(withEvidence, { executionSnapshot: snapshot() })
    const tool = view.turns[0]?.nodes.find((node) => node.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      command: {
        commandId: 'rt-cmd',
        source: 'runtime-tool',
        sourceLabel: 'Runtime 上报命令',
        cwdLabel: 'Runtime 未冻结工作目录（相对路径 .，并非 App 沙箱）'
      }
    })
    expect(tool && 'command' in tool ? tool.command?.sourceLabel : '').not.toMatch(
      /沙箱执行|Broker 强制/
    )
    expect(view.turns[0]?.nodes.some((node) => node.kind === 'command-evidence')).toBe(true)
    expect(view.resultReview.validations).toMatchObject({
      availability: 'observed',
      outcome: 'pass',
      count: 2
    })
    expect(view.resultReview.commands.map((item) => item.source)).toEqual([
      'runtime-tool',
      'app-runner'
    ])
  })

  it('命令证据列表 truncated 时验证只能 unknown，不得在旧成功项上 pass', () => {
    const successEvidence: CommandExecutionEvidence = {
      commandId: 'old-ok',
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'env-1',
      source: 'runtime-tool',
      displayCommand: 'pnpm test',
      cwd: '.',
      startedAt: '2026-08-18T00:00:01.000Z',
      endedAt: '2026-08-18T00:00:02.000Z',
      exitCode: 0,
      timedOut: false,
      status: 'succeeded',
      toolCallId: 'tool-1',
      transcriptRef: {
        transcriptId: 'tx-1',
        availableBytes: 2,
        truncated: false,
        encoding: 'utf-8',
        retentionPolicy: 'bounded',
        retentionState: 'retained'
      },
      truncated: false,
      trustLevel: 'runtime-reported'
    }
    const withEvents = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      { type: 'events/ingest-public', events: EVENTS }
    )
    const completeWindow = reduceTaskTimelineFacts(withEvents, {
      type: 'command-evidence/replace',
      evidences: [successEvidence]
    })
    expect(
      selectTaskTimeline(completeWindow, { executionSnapshot: snapshot() }).resultReview.validations
    ).toMatchObject({ outcome: 'pass' })

    const truncatedWindow = reduceTaskTimelineFacts(withEvents, {
      type: 'command-evidence/replace',
      evidences: [successEvidence],
      truncated: true
    })
    const truncatedReview = selectTaskTimeline(truncatedWindow, {
      executionSnapshot: snapshot()
    }).resultReview
    expect(truncatedReview.validations).toMatchObject({
      availability: 'observed',
      outcome: 'unknown',
      reason: 'incomplete-list'
    })
    expect(truncatedReview.warnings.some((warning) => warning.includes('不完整'))).toBe(true)
  })

  it('标题与退出事实不一致时结果审阅必须画出冲突', () => {
    const inconsistent: CommandExecutionEvidence = {
      commandId: 'rt-cmd',
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'env-1',
      source: 'runtime-tool',
      displayCommand: 'pnpm test',
      cwd: '.',
      startedAt: '2026-08-18T00:00:01.000Z',
      endedAt: '2026-08-18T00:00:02.000Z',
      exitCode: 2,
      timedOut: false,
      status: 'failed',
      toolCallId: 'tool-1',
      inconsistency: 'title-success-nonzero-exit',
      transcriptRef: {
        transcriptId: 'tx-1',
        availableBytes: 2,
        truncated: false,
        encoding: 'utf-8',
        retentionPolicy: 'bounded',
        retentionState: 'retained'
      },
      truncated: false,
      trustLevel: 'runtime-reported'
    }
    const withEvidence = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(
        reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
          type: 'turns/upsert',
          turns: [TURN]
        }),
        { type: 'events/ingest-public', events: EVENTS }
      ),
      { type: 'command-evidence/replace', evidences: [inconsistent] }
    )
    const view = selectTaskTimeline(withEvidence, { executionSnapshot: snapshot() })
    const tool = view.turns[0]?.nodes.find((node) => node.kind === 'tool')
    expect(tool).toMatchObject({
      kind: 'tool',
      command: { inconsistency: 'title-success-nonzero-exit', exitCode: 2, status: 'failed' }
    })
    expect(view.resultReview.validations.outcome).toBe('fail')
    expect(view.resultReview.warnings.some((warning) => warning.includes('不一致'))).toBe(true)
    expect(view.resultReview.commands[0]?.inconsistency).toBe('title-success-nonzero-exit')
  })

  it('没有命令证据时即使工具标题写通过也不产生 pass', () => {
    const state = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'events/ingest-public',
      events: [
        {
          ...BASE,
          sequence: 1,
          kind: 'tool-call',
          toolCallId: 'tool-pass',
          title: 'Tests passed',
          status: 'completed'
        }
      ]
    })
    expect(
      selectTaskTimeline(state, { executionSnapshot: snapshot() }).resultReview.validations
    ).toEqual({
      count: 0,
      availability: 'not-observed'
    })
  })

  it('连续 12 次自动允许读取折叠成一条摘要，不产出 12 张独立审批节点', () => {
    const audits = Array.from({ length: 12 }, (_, index) =>
      permissionAudit({
        auditId: `read-${index + 1}`,
        operationType: 'read-project',
        reason: index === 0 ? 'auto-allowed' : 'grant-reused',
        createdAt: `2026-08-18T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
        targetSummaries: [`path: src/read-${index + 1}.ts`]
      })
    )
    const state = reduceTaskTimelineFacts(
      reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
        type: 'turns/upsert',
        turns: [TURN]
      }),
      { type: 'permission-audits/merge', audits }
    )
    const nodes = selectTaskTimeline(state, { executionSnapshot: snapshot() }).turns[0]?.nodes ?? []
    const permissionNodes = nodes.filter((node) => node.kind === 'permission-audit')

    expect(nodes[0]?.kind).toBe('user-prompt')
    expect(permissionNodes).toHaveLength(1)
    expect(permissionNodes[0]).toMatchObject({
      kind: 'permission-audit',
      foldedCount: 12,
      summary: '已自动允许 12 次读取'
    })
    expect(JSON.stringify(permissionNodes)).not.toContain('allow_always')
  })

  it('人工审批打断静默折叠，且写授权摘要不能把删除混进去', () => {
    const audits = [
      ...Array.from({ length: 3 }, (_, index) =>
        permissionAudit({
          auditId: `read-${index + 1}`,
          operationType: 'read-project',
          reason: 'auto-allowed',
          createdAt: `2026-08-18T00:00:0${index + 1}.000Z`
        })
      ),
      permissionAudit({
        auditId: 'write-1',
        operationType: 'write-file',
        reason: 'user-allowed',
        risk: 'L1',
        createdAt: '2026-08-18T00:00:04.000Z'
      }),
      ...Array.from({ length: 2 }, (_, index) =>
        permissionAudit({
          auditId: `write-auto-${index + 1}`,
          operationType: 'write-file',
          reason: 'grant-reused',
          risk: 'L1',
          createdAt: `2026-08-18T00:00:0${index + 5}.000Z`
        })
      ),
      permissionAudit({
        auditId: 'delete-1',
        operationType: 'delete-path',
        reason: 'auto-allowed',
        risk: 'L1',
        createdAt: '2026-08-18T00:00:07.000Z'
      })
    ]
    const state = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'permission-audits/merge',
      audits
    })
    const permissionNodes =
      selectTaskTimeline(state, {
        executionSnapshot: { executorEpoch: 'epoch', executionRevision: 0, execution: null }
      }).turns[0]?.nodes.filter((node) => node.kind === 'permission-audit') ?? []

    expect(permissionNodes).toHaveLength(4)
    expect(permissionNodes.map((node) => node.summary ?? node.audit.reason)).toEqual([
      '已自动允许 3 次读取',
      'user-allowed',
      '已自动允许 2 次写入',
      '已自动允许 1 次删除'
    ])
    expect(permissionNodes[1]).toMatchObject({
      foldedCount: 1,
      audit: { reason: 'user-allowed', operationType: 'write-file' }
    })
    expect(permissionNodes[1]?.summary).toBeUndefined()
  })
})

function permissionAudit(
  overrides: Partial<PermissionAuditRecord> &
    Pick<PermissionAuditRecord, 'auditId' | 'operationType' | 'reason'>
): PermissionAuditRecord {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    environmentId: 'local:test',
    initiator: 'runtime',
    runtimeId: 'grok',
    risk: 'L0',
    targetSummaries: [`path: src/${overrides.auditId}.ts`],
    title: '权限决策',
    impact: '测试审计折叠',
    createdAt: '2026-08-18T00:00:02.000Z',
    ...overrides
  }
}

import { describe, expect, it } from 'vitest'
import { projectConversationTurn } from './conversation-turn-view'
import type { ConversationSubagentBlock } from './conversation-turn-view'
import {
  createTaskTimelineFacts,
  reduceTaskTimelineFacts,
  selectTaskTimeline,
  type TimelineAgentGroupNode,
  type TimelineToolNode,
  type TurnTimelineViewModel
} from './task-timeline-reducer'
import {
  formatSubagentCountLine,
  isolateSubagentToolOwnership,
  shouldMountSubagentCard,
  subagentStatusLabel,
  toSubagentCardView,
  toSubagentToolRows
} from './conversation-subagent-view'

function tool(
  toolCallId: string,
  title: string,
  status: TimelineToolNode['status'] = 'completed'
): TimelineToolNode {
  return {
    nodeId: `task-1:turn-1:tool:${toolCallId}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'agent-event',
    kind: 'tool',
    toolCallId,
    title,
    status
  }
}

function turn(
  status: TurnTimelineViewModel['status'],
  nodes: TurnTimelineViewModel['nodes']
): TurnTimelineViewModel {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    prompt: '请改登录',
    model: { modelId: 'model-1' },
    status,
    statusProvisional: false,
    statusConflict: false,
    createdAt: '2026-08-12T00:00:00.000Z',
    nodes,
    usage: { contextSamples: [] },
    historyTruncated: false
  }
}

function fixtureSubagent(
  nodeId: string,
  name: string,
  status: ConversationSubagentBlock['status'],
  tools: ConversationSubagentBlock['tools']
): ConversationSubagentBlock {
  return { kind: 'subagent', nodeId, name, status, tools }
}

function agentGroup(
  toolCallId: string,
  title: string,
  status: TimelineToolNode['status'],
  children: TimelineToolNode[]
): TimelineAgentGroupNode {
  return {
    nodeId: `task-1:turn-1:tool:${toolCallId}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'agent-event',
    kind: 'agent-group',
    toolCallId,
    title,
    status,
    children
  }
}

describe('子 Agent 卡挂载门禁', () => {
  it('无 parent 字段时投影不产出 subagent，主列不得挂载空壳', () => {
    const blocks = projectConversationTurn(
      turn('running', [
        tool('child-1', 'subagent 探查测试结构', 'in_progress'),
        tool('child-2', '子 Agent 改登录逻辑', 'completed')
      ])
    )

    expect(blocks.some((block) => block.kind === 'subagent')).toBe(false)
    expect(blocks.filter((block) => shouldMountSubagentCard(block))).toHaveLength(0)
    expect(shouldMountSubagentCard(undefined)).toBe(false)
    expect(shouldMountSubagentCard({ kind: 'tool' })).toBe(false)
    expect(shouldMountSubagentCard({ kind: 'subagent' })).toBe(true)
  })

  it('agent-group 投影成 subagent 卡，孩子不出现在父流', () => {
    const blocks = projectConversationTurn(
      turn('running', [
        {
          nodeId: 'task-1:turn-1:thought:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'thought',
          text: '先分两路'
        },
        agentGroup('spawn-explore', '探查测试结构', 'in_progress', [
          tool('read-1', '读取 src/auth.ts', 'completed')
        ]),
        {
          nodeId: 'task-1:turn-1:message:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '父 Agent 汇总回复'
        }
      ])
    )
    const subagent = blocks.find((block) => block.kind === 'subagent')

    expect(blocks.map((block) => block.kind)).toEqual(['user', 'thought', 'subagent', 'message'])
    expect(subagent).toMatchObject({
      kind: 'subagent',
      nodeId: 'task-1:turn-1:tool:spawn-explore',
      name: '探查测试结构',
      status: 'running',
      tools: [
        expect.objectContaining({ nodeId: 'task-1:turn-1:tool:read-1', label: '读了 src/auth.ts' })
      ]
    })
    expect(blocks.filter((block) => block.kind === 'tool')).toHaveLength(0)
    expect(shouldMountSubagentCard(subagent)).toBe(true)
  })

  it('两个并行 agent-group 投影后工具不串 nodeId', () => {
    const blocks = projectConversationTurn(
      turn('running', [
        agentGroup('spawn-explore', '探查测试结构', 'in_progress', [
          tool('read-pkg', '读取 package.json', 'in_progress')
        ]),
        agentGroup('spawn-edit', '改登录逻辑', 'completed', [
          tool('write-auth', '写入 src/auth.ts')
        ])
      ])
    )
    const cards = blocks.filter(
      (block): block is ConversationSubagentBlock => block.kind === 'subagent'
    )

    expect(cards).toHaveLength(2)
    expect(cards.map((card) => card.status)).toEqual(['running', 'completed'])
    expect(isolateSubagentToolOwnership(cards)).toEqual({
      sharedToolNodeIds: [],
      toolsByCard: {
        'task-1:turn-1:tool:spawn-explore': ['task-1:turn-1:tool:read-pkg'],
        'task-1:turn-1:tool:spawn-edit': ['task-1:turn-1:tool:write-auth']
      }
    })
  })

  it('同一套 reducer 有 parentId 才成组，实时投影可挂载 SubagentCard', () => {
    const state = reduceTaskTimelineFacts(createTaskTimelineFacts('task-1'), {
      type: 'events/ingest-public',
      events: [
        {
          runtimeId: 'grok',
          capabilityState: 'native',
          taskId: 'task-1',
          turnId: 'turn-1',
          observedAt: '2026-08-18T00:00:01.000Z',
          sequence: 1,
          kind: 'tool-call',
          toolCallId: 'spawn-explore',
          title: '探查测试结构',
          status: 'in_progress'
        },
        {
          runtimeId: 'grok',
          capabilityState: 'native',
          taskId: 'task-1',
          turnId: 'turn-1',
          observedAt: '2026-08-18T00:00:02.000Z',
          sequence: 2,
          kind: 'tool-call',
          toolCallId: 'read-1',
          title: '读取 src/auth.ts',
          status: 'completed',
          parentId: 'spawn-explore'
        }
      ]
    })
    const view = selectTaskTimeline(state, {
      executionSnapshot: { executorEpoch: 'epoch', executionRevision: 0, execution: null }
    }).turns[0]
    expect(view).toBeDefined()
    const blocks = projectConversationTurn(view!)
    const cards = blocks.filter((block) => shouldMountSubagentCard(block))

    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      kind: 'subagent',
      name: '探查测试结构',
      status: 'running'
    })
    expect(blocks.some((block) => block.kind === 'tool')).toBe(false)
  })
})

describe('子 Agent 第 7 节皮肤', () => {
  it('折叠态是名字+状态+工具计数，失败单独标，不把错误糊进父消息', () => {
    expect(subagentStatusLabel('running')).toBe('进行中')
    expect(subagentStatusLabel('completed')).toBe('完成')
    expect(subagentStatusLabel('failed')).toBe('失败')
    expect(formatSubagentCountLine(3)).toBe('已运行 3 个工具 · 点开查看')

    const failed = fixtureSubagent('task-1:turn-1:tool:child-fail', '探查测试结构', 'failed', [
      {
        kind: 'tool',
        nodeId: 'task-1:turn-1:tool:read-1',
        label: '读了 src/auth.ts',
        status: 'failed',
        tools: [tool('read-1', '读取 src/auth.ts', 'failed')]
      }
    ])
    const view = toSubagentCardView(failed)

    expect(view.name).toBe('探查测试结构')
    expect(view.status).toBe('failed')
    expect(view.statusLabel).toBe('失败')
    expect(view.countLine).toBe('已运行 1 个工具 · 点开查看')
    expect(view.defaultExpanded).toBe(false)
    expect(view.errorInParentMessage).toBe(false)
    expect(toSubagentToolRows(failed.tools).map((row) => row.key)).toEqual([
      'task-1:turn-1:tool:read-1'
    ])
  })

  it('进行中默认展开；两个孩子各自带工具，不串 nodeId', () => {
    const exploring = fixtureSubagent('task-1:turn-1:tool:child-a', '探查测试结构', 'running', [
      {
        kind: 'tool',
        nodeId: 'task-1:turn-1:tool:read-pkg',
        label: '读了 package.json',
        status: 'in_progress',
        tools: [tool('read-pkg', '读取 package.json', 'in_progress')]
      }
    ])
    const editing = fixtureSubagent('task-1:turn-1:tool:child-b', '改登录逻辑', 'completed', [
      {
        kind: 'tool',
        nodeId: 'task-1:turn-1:tool:write-auth',
        label: '写入 src/auth.ts',
        status: 'completed',
        tools: [tool('write-auth', '写入 src/auth.ts')]
      }
    ])

    expect(toSubagentCardView(exploring).defaultExpanded).toBe(true)
    expect(toSubagentCardView(editing).defaultExpanded).toBe(false)

    const ownership = isolateSubagentToolOwnership([exploring, editing])
    expect(ownership.sharedToolNodeIds).toEqual([])
    expect(ownership.toolsByCard).toEqual({
      'task-1:turn-1:tool:child-a': ['task-1:turn-1:tool:read-pkg'],
      'task-1:turn-1:tool:child-b': ['task-1:turn-1:tool:write-auth']
    })
  })

  it('子 Agent 工具行透传 Execute 详情，供折叠而不是摊在标签上', () => {
    const command = 'ls -la && find . -maxdepth 3 -print | head -80'
    const rows = toSubagentToolRows([
      {
        kind: 'tool',
        nodeId: 'task-1:turn-1:tool:exec-1',
        label: '跑了命令',
        status: 'completed',
        detail: command,
        tools: [tool('exec-1', `Execute \`${command}\``)]
      }
    ])

    expect(rows).toEqual([
      {
        key: 'task-1:turn-1:tool:exec-1',
        label: '跑了命令',
        status: 'completed',
        files: [],
        detail: command
      }
    ])
    expect(rows[0]?.label).not.toContain('ls -la')
  })
})

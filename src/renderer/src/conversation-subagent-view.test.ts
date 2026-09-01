import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  SUBAGENT_AMBIGUOUS_COPY,
  SUBAGENT_CARD_MAX_DEPTH,
  SUBAGENT_STOP_COPY,
  createSubagentCardExpansion,
  flattenSubagentToolsToRows,
  formatSubagentCountLine,
  formatSubagentDuration,
  isolateSubagentToolOwnership,
  shouldMountSubagentCard,
  subagentStatusLabel,
  subagentStopPolicy,
  toSubagentCardView,
  toSubagentToolRows
} from './conversation-subagent-view'

const root = dirname(fileURLToPath(import.meta.url))
const subagentCardSource = readFileSync(join(root, 'components/SubagentCard.vue'), 'utf8')
const conversationTurnSource = readFileSync(join(root, 'components/ConversationTurn.vue'), 'utf8')
const taskListSource = readFileSync(join(root, 'components/TaskList.vue'), 'utf8')
const sidebarSource = readFileSync(join(root, 'components/ProjectSidebar.vue'), 'utf8')

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

  it('Grok spawn 标题原样做 heading，带耗时；并行提示不编造孩子', () => {
    const heading = '[subagent:general-purpose] Demo subagent run (01a05b79)'
    const blocks = projectConversationTurn(
      turn('completed', [
        {
          ...agentGroup('spawn-1', heading, 'completed', [
            tool('read-1', '读取 src/auth.ts', 'completed')
          ]),
          firstObservedAt: '2026-09-01T05:00:00.000Z',
          lastObservedAt: '2026-09-01T05:00:12.000Z'
        }
      ])
    )
    const card = blocks.find((block) => block.kind === 'subagent')

    expect(card).toMatchObject({
      kind: 'subagent',
      name: heading,
      durationLabel: '12 秒'
    })
    expect(card && 'groupingHint' in card ? card.groupingHint : undefined).toBeUndefined()

    const parallel = projectConversationTurn(
      turn('running', [
        {
          ...agentGroup('spawn-a', '[subagent:explore] A (aaa1)', 'in_progress', []),
          groupingHint: 'ambiguous-parallel'
        }
      ])
    )
    expect(parallel.find((block) => block.kind === 'subagent')).toMatchObject({
      groupingHint: 'ambiguous-parallel',
      groupingNote: SUBAGENT_AMBIGUOUS_COPY,
      tools: []
    })
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

describe('子 Agent 耗时', () => {
  it('用首尾 observedAt 算耗时，缺时间或 0 秒不编造', () => {
    expect(formatSubagentDuration('2026-09-01T05:00:00.000Z', '2026-09-01T05:00:12.000Z')).toBe(
      '12 秒'
    )
    expect(formatSubagentDuration('2026-09-01T05:00:00.000Z', '2026-09-01T05:01:05.000Z')).toBe(
      '1 分 05 秒'
    )
    expect(formatSubagentDuration('2026-09-01T05:00:00.000Z', '2026-09-01T05:00:00.000Z')).toBe(
      undefined
    )
    expect(formatSubagentDuration(undefined, '2026-09-01T05:00:12.000Z')).toBeUndefined()
  })
})

describe('子 Agent 第 7 节皮肤', () => {
  it('折叠态是名字+状态+工具计数，失败单独标，不把错误糊进父消息', () => {
    expect(subagentStatusLabel('running')).toBe('进行中')
    expect(subagentStatusLabel('completed')).toBe('已完成')
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

describe('GACP-06 任务 3 折叠/停止/深度', () => {
  it('进行中默认展开，完成和失败默认折', () => {
    expect(
      toSubagentCardView(fixtureSubagent('a', '探查测试结构', 'running', [])).defaultExpanded
    ).toBe(true)
    expect(
      toSubagentCardView(fixtureSubagent('b', '改登录逻辑', 'completed', [])).defaultExpanded
    ).toBe(false)
    expect(
      toSubagentCardView(fixtureSubagent('c', '探查测试结构', 'failed', [])).defaultExpanded
    ).toBe(false)
    expect(createSubagentCardExpansion('running').open).toBe(true)
    expect(createSubagentCardExpansion('completed').open).toBe(false)
    expect(createSubagentCardExpansion('failed').open).toBe(false)
    expect(subagentCardSource).toContain('createSubagentCardExpansion')
    expect(subagentCardSource).toContain('applyStatus')
    expect(subagentCardSource).toContain('applyToggle')
    expect(subagentCardSource).toMatch(/watch\(\s*\(\)\s*=>\s*props\.status/)
    expect(subagentCardSource).toContain('@toggle')
    expect(subagentCardSource).toContain(':aria-label=')
    expect(subagentCardSource).toContain(':title="name"')
    expect(subagentCardSource).toContain('subagent-pill')
    expect(subagentCardSource).toContain('durationLabel')
    expect(subagentCardSource).toContain('groupingNote')
  })

  it('未手势时 live running→completed 收起；手势过则尊重用户', () => {
    const live = createSubagentCardExpansion('running')
    expect(live.open).toBe(true)
    live.applyStatus('completed')
    expect(live.open).toBe(false)

    const failed = createSubagentCardExpansion('running')
    failed.applyStatus('failed')
    expect(failed.open).toBe(false)

    const userCollapsed = createSubagentCardExpansion('running')
    userCollapsed.applyToggle(false)
    expect(userCollapsed.open).toBe(false)
    userCollapsed.applyStatus('completed')
    expect(userCollapsed.open).toBe(false)

    const userInspected = createSubagentCardExpansion('running')
    userInspected.applyStatus('completed')
    expect(userInspected.open).toBe(false)
    userInspected.applyToggle(true)
    expect(userInspected.open).toBe(true)
    userInspected.applyStatus('completed')
    expect(userInspected.open).toBe(true)

    const echo = createSubagentCardExpansion('running')
    echo.applyStatus('completed')
    echo.applyToggle(false)
    echo.applyStatus('running')
    expect(echo.open).toBe(true)
  })

  it('两个并行孩子互不串工具，v-for 用稳定 nodeId 而不是 index', () => {
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
    const exploringView = toSubagentCardView(exploring)
    const editingView = toSubagentCardView(editing)

    expect(isolateSubagentToolOwnership([exploring, editing]).sharedToolNodeIds).toEqual([])
    expect(exploringView.rowKeys).toEqual(['task-1:turn-1:tool:read-pkg'])
    expect(editingView.rowKeys).toEqual(['task-1:turn-1:tool:write-auth'])
    expect(subagentCardSource).toContain('v-for="tool in tools"')
    expect(subagentCardSource).toContain(':key="tool.key"')
    expect(subagentCardSource).not.toContain('v-for="(tool, index)')
    expect(subagentCardSource).not.toContain('${tool.label}:${index}')
    expect(conversationTurnSource).toContain(':key="block.nodeId"')
    expect(conversationTurnSource).not.toMatch(/v-for="\(block,\s*index\)"/)
  })

  it('失败只标在这张卡上，不写进父助手消息', () => {
    const blocks = projectConversationTurn(
      turn('completed', [
        agentGroup('spawn-fail', '探查测试结构', 'failed', [
          tool('read-1', '读取 src/auth.ts', 'failed')
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
    const message = blocks.find((block) => block.kind === 'message')
    const view = toSubagentCardView(
      subagent && subagent.kind === 'subagent'
        ? subagent
        : fixtureSubagent('missing', '探查测试结构', 'failed', [])
    )

    expect(subagent).toMatchObject({
      kind: 'subagent',
      status: 'failed',
      name: '探查测试结构'
    })
    expect(message).toMatchObject({ kind: 'message', text: '父 Agent 汇总回复' })
    expect(message && 'text' in message ? message.text : '').not.toMatch(/失败|探查测试结构/)
    expect(view.errorInParentMessage).toBe(false)
    expect(view.status).toBe('failed')
  })

  it('没有 child cancel：源码无「停止此子任务」，文案写清停的是整场 Turn', () => {
    const policy = subagentStopPolicy()
    const view = toSubagentCardView(
      fixtureSubagent('task-1:turn-1:tool:child-a', '探查测试结构', 'running', [])
    )

    expect(policy.hasChildCancel).toBe(false)
    expect(policy.scope).toBe('turn')
    expect(policy.copy).toBe(SUBAGENT_STOP_COPY)
    expect(policy.copy).toContain('整场 Turn')
    expect(policy.copy).not.toContain('停止此子任务')
    expect(view.stop).toEqual(policy)
    expect(subagentCardSource).not.toContain('停止此子任务')
    expect(subagentCardSource).not.toContain('cancelTurn')
    expect(subagentCardSource).toContain('SUBAGENT_STOP_COPY')
    expect(conversationTurnSource).not.toContain('停止此子任务')
    expect(conversationTurnSource).toContain('flattenSubagentToolsToRows(block.tools)')
  })

  it('深度限制 2：嵌套 group 摊成 ToolRow，不再套第三层 SubagentCard', () => {
    const nestedGroup = {
      kind: 'subagent' as const,
      nodeId: 'task-1:turn-1:tool:inner',
      name: '更里一层',
      status: 'running' as const,
      tools: [
        {
          kind: 'tool' as const,
          nodeId: 'task-1:turn-1:tool:read-inner',
          label: '读了 inner.ts',
          status: 'completed' as const,
          tools: [tool('read-inner', '读取 inner.ts')]
        }
      ]
    }
    const rows = flattenSubagentToolsToRows([
      {
        kind: 'tool',
        nodeId: 'task-1:turn-1:tool:read-1',
        label: '读了 src/auth.ts',
        status: 'completed',
        tools: [tool('read-1', '读取 src/auth.ts')]
      },
      nestedGroup
    ])
    const view = toSubagentCardView({
      name: '探查测试结构',
      status: 'running',
      tools: [
        {
          kind: 'tool',
          nodeId: 'task-1:turn-1:tool:read-1',
          label: '读了 src/auth.ts',
          status: 'completed',
          tools: [tool('read-1', '读取 src/auth.ts')]
        },
        nestedGroup
      ]
    })

    expect(SUBAGENT_CARD_MAX_DEPTH).toBe(2)
    expect(view.maxDepth).toBe(2)
    expect(view.nestedCardCount).toBe(0)
    expect(rows.map((row) => row.key)).toEqual([
      'task-1:turn-1:tool:read-1',
      'task-1:turn-1:tool:read-inner'
    ])
    expect(view.rowKeys).toEqual(['task-1:turn-1:tool:read-1', 'task-1:turn-1:tool:read-inner'])
    expect(view.tools.some((row) => 'kind' in row)).toBe(false)
    expect(subagentCardSource).toContain('ToolRow')
    expect(subagentCardSource).not.toMatch(/<SubagentCard\b/)
    expect(conversationTurnSource.match(/<SubagentCard\b/g)).toHaveLength(1)
    expect(taskListSource).not.toContain('SubagentCard')
    expect(sidebarSource).not.toContain('SubagentCard')
  })
})

import { describe, expect, it } from 'vitest'
import type { AgentPermissionRequest } from '../../shared/agent'
import type { TimelineToolNode, TurnTimelineViewModel } from './task-timeline-reducer'
import {
  PERMISSION_ALLOW_TASK_LABEL,
  formatMergedReadLabel,
  projectConversationTurn,
  resolvePermissionPrimaryAction
} from './conversation-turn-view'

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
  nodes: TurnTimelineViewModel['nodes'],
  prompt = '请改登录'
): TurnTimelineViewModel {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    prompt,
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

describe('对话块投影', () => {
  it('同一轮用户句只出现一次，助手句走 markdown 字段，思考默认折叠且不含 Tool/Plan 标签', () => {
    const view = turn('completed', [
      {
        nodeId: 'task-1:turn-1:user',
        taskId: 'task-1',
        turnId: 'turn-1',
        source: 'turn-record',
        kind: 'user-prompt',
        text: '请改登录'
      },
      {
        nodeId: 'task-1:turn-1:agent-thought:id:',
        taskId: 'task-1',
        turnId: 'turn-1',
        source: 'agent-event',
        kind: 'thought',
        text: '先找 auth'
      },
      {
        nodeId: 'task-1:turn-1:plan',
        taskId: 'task-1',
        turnId: 'turn-1',
        source: 'agent-event',
        kind: 'plan',
        entries: [
          { content: '找现有 auth', priority: 'high', status: 'completed' },
          { content: '改登录表单', priority: 'medium', status: 'completed' },
          { content: '补测试', priority: 'low', status: 'completed' }
        ]
      },
      {
        nodeId: 'task-1:turn-1:agent-message:id:',
        taskId: 'task-1',
        turnId: 'turn-1',
        source: 'agent-event',
        kind: 'message',
        text: '已经改好登录'
      }
    ])

    const blocks = projectConversationTurn(view)
    const serialized = JSON.stringify(blocks)

    expect(blocks.filter((block) => block.kind === 'user')).toHaveLength(1)
    expect(blocks.find((block) => block.kind === 'user')).toMatchObject({
      kind: 'user',
      text: '请改登录'
    })
    expect(blocks.find((block) => block.kind === 'message')).toMatchObject({
      kind: 'message',
      text: '已经改好登录',
      render: 'markdown'
    })
    expect(blocks.find((block) => block.kind === 'thought')).toMatchObject({
      kind: 'thought',
      text: '先找 auth',
      defaultCollapsed: true,
      summary: '思考过程'
    })
    expect(blocks.find((block) => block.kind === 'plan')).toMatchObject({
      kind: 'plan',
      nodeId: 'task-1:turn-1:plan',
      defaultExpanded: false
    })
    expect(serialized).not.toMatch(/"Tool"/)
    expect(serialized).not.toMatch(/Plan ·/)
    expect(serialized).not.toContain('执行过程')
  })

  it('连续 read 工具合成「读了 N 个文件」，十次读取只占一块', () => {
    const reads = Array.from({ length: 10 }, (_, index) =>
      tool(`read-${index + 1}`, `读取 src/file-${index + 1}.ts`)
    )
    const blocks = projectConversationTurn(
      turn('completed', [
        {
          nodeId: 'task-1:turn-1:user',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'admission',
          kind: 'user-prompt',
          text: '请改登录'
        },
        ...reads,
        tool('write-1', '写入 src/auth.ts')
      ])
    )
    const toolBlocks = blocks.filter((block) => block.kind === 'tool')

    expect(formatMergedReadLabel(10)).toBe('读了 10 个文件')
    expect(toolBlocks).toHaveLength(2)
    expect(toolBlocks[0]).toMatchObject({
      kind: 'tool',
      label: '读了 10 个文件',
      mergedReadCount: 10
    })
    expect(toolBlocks[1]).toMatchObject({
      kind: 'tool',
      label: '写入 src/auth.ts'
    })
  })

  it('无 parent 字段时不按标题编造 subagent 组，工具保持扁平', () => {
    const blocks = projectConversationTurn(
      turn('running', [
        tool('child-1', 'subagent 探查测试结构', 'in_progress'),
        tool('child-2', '子 Agent 改登录逻辑', 'completed')
      ])
    )

    expect(blocks.some((block) => block.kind === 'subagent')).toBe(false)
    expect(blocks.filter((block) => block.kind === 'tool').map((block) => block.label)).toEqual([
      'subagent 探查测试结构',
      '子 Agent 改登录逻辑'
    ])
  })
})

describe('权限卡主按钮', () => {
  it('L1/L2 主按钮文案是「本任务允许」且决策为本任务授权', () => {
    const request: Pick<AgentPermissionRequest, 'allowedScopes' | 'risk'> = {
      allowedScopes: ['once', 'task'],
      risk: 'L1'
    }
    expect(PERMISSION_ALLOW_TASK_LABEL).toBe('本任务允许')
    expect(resolvePermissionPrimaryAction(request)).toEqual({
      decision: 'allow-task',
      label: '本任务允许'
    })
  })
})

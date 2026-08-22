import { describe, expect, it } from 'vitest'
import type { AgentPermissionRequest } from '../../shared/agent'
import type { TimelineToolNode, TurnTimelineViewModel } from './task-timeline-reducer'
import {
  PERMISSION_ALLOW_TASK_LABEL,
  formatMergedReadLabel,
  hasConversationUsageData,
  projectConversationTurn,
  resolvePermissionCardPresentation,
  resolvePermissionOriginLabel,
  resolvePermissionPrimaryAction
} from './conversation-turn-view'

function tool(
  toolCallId: string,
  title: string,
  status: TimelineToolNode['status'] = 'completed',
  command?: TimelineToolNode['command']
): TimelineToolNode {
  return {
    nodeId: `task-1:turn-1:tool:${toolCallId}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'agent-event',
    kind: 'tool',
    toolCallId,
    title,
    status,
    ...(command ? { command } : {})
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

  it('工具证据摘要进入折叠详情，不把 transcript 写进 Markdown', () => {
    const blocks = projectConversationTurn(
      turn('completed', [
        tool('bash-1', 'Execute `pnpm test`', 'completed', {
          commandId: 'rt-cmd',
          displayCommand: 'pnpm test',
          source: 'runtime-tool',
          sourceLabel: 'Runtime 上报命令',
          cwd: '.',
          cwdLabel: 'Runtime 未冻结工作目录（相对路径 .，并非 App 沙箱）',
          exitCode: 0,
          durationMs: 1200,
          timedOut: false,
          truncated: true,
          trustLevel: 'runtime-reported',
          trustLabel: 'Runtime 上报事实',
          status: 'succeeded',
          logIncomplete: true,
          logIncompleteReason: '输出已截断，日志不完整'
        })
      ])
    )
    const toolBlock = blocks.find((block) => block.kind === 'tool')
    expect(toolBlock).toMatchObject({
      kind: 'tool',
      label: '跑了命令',
      detail: expect.stringContaining('Runtime 上报命令')
    })
    expect(toolBlock && 'detail' in toolBlock ? toolBlock.detail : '').toContain('并非 App 沙箱')
    expect(toolBlock && 'detail' in toolBlock ? toolBlock.detail : '').toContain('日志不完整')
    expect(toolBlock && 'detail' in toolBlock ? toolBlock.detail : '').not.toContain('stdout')
    expect(blocks.some((block) => block.kind === 'message')).toBe(false)
  })

  it('标题成功但退出码非 0 时主列按证据失败态展示并露出冲突警告', () => {
    const blocks = projectConversationTurn(
      turn('completed', [
        tool('bash-1', 'Tests passed', 'completed', {
          commandId: 'rt-cmd',
          displayCommand: 'pnpm test',
          source: 'runtime-tool',
          sourceLabel: 'Runtime 上报命令',
          cwd: '.',
          cwdLabel: 'Runtime 未冻结工作目录（相对路径 .，并非 App 沙箱）',
          exitCode: 2,
          timedOut: false,
          truncated: false,
          trustLevel: 'runtime-reported',
          trustLabel: 'Runtime 上报事实',
          status: 'failed',
          logIncomplete: false,
          inconsistency: 'title-success-nonzero-exit'
        })
      ])
    )
    const toolBlock = blocks.find((block) => block.kind === 'tool')
    expect(toolBlock).toMatchObject({
      kind: 'tool',
      status: 'failed',
      warning: expect.stringMatching(/不一致|退出码/)
    })
    expect(toolBlock && 'status' in toolBlock ? toolBlock.status : '').not.toBe('completed')
    expect(toolBlock && 'warning' in toolBlock ? toolBlock.warning : '').toContain('2')
  })

  it('List/Execute 主列只显示短标签，长命令进 detail 供折叠', () => {
    const command =
      'ls -la && (test -f README.md && head -80 README.md; find . -maxdepth 3 -print | head -80)'
    const blocks = projectConversationTurn(
      turn('completed', [
        tool('list-1', 'List `/Users/huyaohang/Documents/agentStudioTest`'),
        tool('exec-1', `Execute \`${command}\``)
      ])
    )
    const toolBlocks = blocks.filter((block) => block.kind === 'tool')

    expect(toolBlocks).toEqual([
      expect.objectContaining({
        kind: 'tool',
        label: '列目录',
        detail: '/Users/huyaohang/Documents/agentStudioTest'
      }),
      expect.objectContaining({
        kind: 'tool',
        label: '跑了命令',
        detail: command
      })
    ])
    expect(toolBlocks[1]?.label).not.toContain('ls -la')
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

  it('流内权限是小卡：非 dialog、不自动抢焦点，并插在计划后面', () => {
    const presentation = resolvePermissionCardPresentation()
    expect(presentation).toMatchObject({
      variant: 'inline',
      role: 'region',
      autofocus: false,
      density: 'compact'
    })
    expect(presentation.role).not.toBe('dialog')
    expect(presentation.variant).not.toBe('modal')

    const request: AgentPermissionRequest = {
      approvalId: 'approval-1',
      initiator: 'runtime',
      runtimeId: 'grok',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:test',
      operationType: 'write-file',
      risk: 'L1',
      title: '修改文件',
      impact: '写入 Project 文件。',
      targets: ['path: src/auth.ts'],
      allowedScopes: ['once', 'task'],
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
    const blocks = projectConversationTurn(
      turn('waiting-permission', [
        {
          nodeId: 'task-1:turn-1:plan',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'plan',
          entries: [{ content: '改登录表单', priority: 'medium', status: 'in_progress' }]
        },
        {
          nodeId: 'task-1:turn-1:agent-message:id:',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '正在改登录'
        }
      ]),
      { pendingPermission: request }
    )
    const kinds = blocks.map((block) => block.kind)
    expect(kinds).toEqual(['user', 'plan', 'permission', 'message'])
    expect(blocks.find((block) => block.kind === 'permission')).toMatchObject({
      kind: 'permission',
      primaryLabel: '本任务允许'
    })
  })

  it('错位审批卡露出任务名，贴在当前 Turn 上时保持紧凑', () => {
    expect(
      resolvePermissionOriginLabel({
        taskTitle: '生命周期审批任务 A',
        attachedToViewedTurn: true
      })
    ).toBeNull()
    expect(
      resolvePermissionOriginLabel({
        taskTitle: '生命周期审批任务 A',
        attachedToViewedTurn: false
      })
    ).toBe('来自「生命周期审批任务 A」')
    expect(
      resolvePermissionOriginLabel({
        taskTitle: '  ',
        attachedToViewedTurn: false
      })
    ).toBeNull()
  })
})

describe('用量块', () => {
  it('有 usage 数据时投影为默认折叠块，没数据才省略', () => {
    expect(
      hasConversationUsageData({
        scope: 'turn',
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3
      })
    ).toBe(true)

    const withUsage = projectConversationTurn(
      turn('completed', [
        {
          nodeId: 'task-1:turn-1:usage:4',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'usage',
          usage: { scope: 'turn', inputTokens: 1, outputTokens: 2, totalTokens: 3 }
        }
      ])
    )
    expect(withUsage.find((block) => block.kind === 'usage')).toMatchObject({
      kind: 'usage',
      defaultCollapsed: true,
      summary: '用量 · 3 tokens'
    })
    expect(JSON.stringify(withUsage)).not.toContain('turn-complete')
    expect(JSON.stringify(withUsage)).not.toContain('permission-audit')

    const withoutUsage = projectConversationTurn(turn('completed', []))
    expect(withoutUsage.some((block) => block.kind === 'usage')).toBe(false)
    expect(
      hasConversationUsageData({ scope: 'context', usedTokens: Number.NaN, limitTokens: 0 })
    ).toBe(false)
  })
})

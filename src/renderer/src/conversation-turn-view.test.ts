import { describe, expect, it } from 'vitest'
import type { AgentPermissionRequest } from '../../shared/agent'
import type { PermissionAuditRecord } from '../../shared/task-history'
import type {
  TimelinePermissionNode,
  TimelineToolNode,
  TurnTimelineViewModel
} from './task-timeline-reducer'
import {
  PERMISSION_ALLOW_TASK_LABEL,
  PERMISSION_INSUFFICIENT_EVIDENCE_NOTICE,
  formatMergedReadLabel,
  formatSilentPermissionSummary,
  hasConversationUsageData,
  projectConversationTurn,
  resolvePermissionCardKeyDecision,
  resolvePermissionCardPresentation,
  resolvePermissionEvidenceNotice,
  resolvePermissionOriginLabel,
  resolvePermissionPrimaryAction,
  stripDisplayedSessionMediaPaths
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

describe('stripDisplayedSessionMediaPaths', () => {
  it('去掉独立的 images/N.jpg 行，保留说明文字', () => {
    expect(
      stripDisplayedSessionMediaPaths('趴着这张来了：\n\nimages/3.jpg\n\n还想伸懒腰或回头看。')
    ).toBe('趴着这张来了：\n\n还想伸懒腰或回头看。')
    expect(stripDisplayedSessionMediaPaths('`images/1.jpg`')).toBe('')
    expect(
      stripDisplayedSessionMediaPaths('[images/4.jpg](file:///tmp/sessions/x/images/4.jpg)')
    ).toBe('')
    expect(stripDisplayedSessionMediaPaths('图在 images/3.jpg 里')).toBe('图在 images/3.jpg 里')
  })
})

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

  it('Runtime 图片插在说明文字和后续句子之间，不显示 images/N.jpg', () => {
    const blocks = projectConversationTurn(
      turn('completed', [
        {
          nodeId: 'task-1:turn-1:thought:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'thought',
          text: '先画'
        },
        {
          nodeId: 'task-1:turn-1:tool:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'tool',
          toolCallId: 'tool-1',
          title: 'image_gen',
          status: 'completed'
        },
        {
          nodeId: 'task-1:turn-1:attachment:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'attachment',
          attachmentId: 'attachment-1',
          attachmentKind: 'image',
          originalName: '1.jpg'
        },
        {
          nodeId: 'task-1:turn-1:thought:2',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'thought',
          text: '再写一句'
        },
        {
          nodeId: 'task-1:turn-1:message:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '伸懒腰这张好了：\n\nimages/4.jpg\n\n还想回头看，直接说。'
        }
      ])
    )

    expect(blocks.map((block) => block.kind)).toEqual([
      'user',
      'thought',
      'tool',
      'thought',
      'message',
      'attachment',
      'message'
    ])
    expect(blocks.filter((block) => block.kind === 'message')).toEqual([
      expect.objectContaining({ text: '伸懒腰这张好了：' }),
      expect.objectContaining({ text: '还想回头看，直接说。' })
    ])
    expect(blocks.find((block) => block.kind === 'attachment')).toMatchObject({
      attachmentIds: ['attachment-1']
    })
    expect(JSON.stringify(blocks)).not.toContain('images/4.jpg')
  })

  it('前置助手消息不会抢先承接后续 Runtime 图片', () => {
    const blocks = projectConversationTurn(
      turn('completed', [
        {
          nodeId: 'task-1:turn-1:message:before',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '先看看这张图，再帮你修得更好看。'
        },
        {
          nodeId: 'task-1:turn-1:tool:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'tool',
          toolCallId: 'tool-1',
          title: 'image_gen',
          status: 'completed'
        },
        {
          nodeId: 'task-1:turn-1:attachment:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'attachment',
          attachmentId: 'attachment-1',
          attachmentKind: 'image',
          originalName: '1.jpg'
        },
        {
          nodeId: 'task-1:turn-1:message:after',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '修好了，胡大帅：\n\nimages/1.jpg\n\n想再亮一点，直接说。'
        }
      ])
    )

    expect(blocks.map((block) => block.kind)).toEqual([
      'user',
      'message',
      'tool',
      'message',
      'attachment',
      'message'
    ])
    expect(blocks[1]).toMatchObject({ kind: 'message', text: '先看看这张图，再帮你修得更好看。' })
    expect(blocks[3]).toMatchObject({ kind: 'message', text: '修好了，胡大帅：' })
    expect(blocks[4]).toMatchObject({ kind: 'attachment', attachmentIds: ['attachment-1'] })
    expect(blocks[5]).toMatchObject({ kind: 'message', text: '想再亮一点，直接说。' })
  })

  it('连续 Runtime 图片绑定同一条路径消息时合并展示且不丢失', () => {
    const blocks = projectConversationTurn(
      turn('completed', [
        {
          nodeId: 'task-1:turn-1:attachment:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'attachment',
          attachmentId: 'attachment-1',
          attachmentKind: 'image',
          originalName: '1.jpg'
        },
        {
          nodeId: 'task-1:turn-1:attachment:2',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'attachment',
          attachmentId: 'attachment-2',
          attachmentKind: 'image',
          originalName: '2.jpg'
        },
        {
          nodeId: 'task-1:turn-1:message:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '两张都好了：\n\nimages/1.jpg\n\n可以继续调整。'
        }
      ])
    )

    expect(blocks.filter((block) => block.kind === 'attachment')).toEqual([
      expect.objectContaining({ attachmentIds: ['attachment-1', 'attachment-2'] })
    ])
  })

  it('被工具节点分隔的图片组仍绑定到同一条路径消息', () => {
    const blocks = projectConversationTurn(
      turn('completed', [
        {
          nodeId: 'task-1:turn-1:attachment:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'attachment',
          attachmentId: 'attachment-1',
          attachmentKind: 'image',
          originalName: '1.jpg'
        },
        {
          nodeId: 'task-1:turn-1:tool:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'tool',
          toolCallId: 'tool-1',
          title: '读取图片',
          status: 'completed'
        },
        {
          nodeId: 'task-1:turn-1:attachment:2',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'attachment',
          attachmentId: 'attachment-2',
          attachmentKind: 'image',
          originalName: '2.jpg'
        },
        {
          nodeId: 'task-1:turn-1:message:1',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '都修好了：\n\nimages/2.jpg\n\n可以继续调整。'
        }
      ])
    )

    expect(blocks.filter((block) => block.kind === 'attachment')).toEqual([
      expect.objectContaining({ attachmentIds: ['attachment-1'] }),
      expect.objectContaining({ attachmentIds: ['attachment-2'] })
    ])
    expect(blocks.map((block) => block.kind)).toEqual([
      'user',
      'tool',
      'message',
      'attachment',
      'attachment',
      'message'
    ])
  })
})

describe('权限卡主按钮', () => {
  it('L1/L2 主按钮文案是「本任务允许」且决策为本任务授权', () => {
    expect(PERMISSION_ALLOW_TASK_LABEL).toBe('本任务允许')
    expect(resolvePermissionPrimaryAction({ allowedScopes: ['once', 'task'], risk: 'L1' })).toEqual(
      {
        decision: 'allow-task',
        label: '本任务允许'
      }
    )
    expect(resolvePermissionPrimaryAction({ allowedScopes: ['once', 'task'], risk: 'L2' })).toEqual(
      {
        decision: 'allow-task',
        label: '本任务允许'
      }
    )
  })

  it('L3 主按钮不是本任务允许，只能仅本次', () => {
    expect(resolvePermissionPrimaryAction({ allowedScopes: ['once'], risk: 'L3' })).toEqual({
      decision: 'allow-once',
      label: '仅允许这一次'
    })
    expect(
      resolvePermissionPrimaryAction({ allowedScopes: ['once', 'task'], risk: 'L3' }).decision
    ).not.toBe('allow-task')
  })

  it('Enter 走主按钮，Esc 拒绝，输入法确认中不触发', () => {
    expect(resolvePermissionCardKeyDecision({ key: 'Enter' }, 'allow-task')).toBe('allow-task')
    expect(resolvePermissionCardKeyDecision({ key: 'Enter' }, 'allow-once')).toBe('allow-once')
    expect(resolvePermissionCardKeyDecision({ key: 'Escape' }, 'allow-task')).toBe('deny')
    expect(
      resolvePermissionCardKeyDecision({ key: 'Enter', isComposing: true }, 'allow-task')
    ).toBeNull()
    expect(
      resolvePermissionCardKeyDecision({ key: 'Enter', keyCode: 229 }, 'allow-task')
    ).toBeNull()
    expect(
      resolvePermissionCardKeyDecision({ key: 'Enter', shiftKey: true }, 'allow-task')
    ).toBeNull()
    expect(
      resolvePermissionCardKeyDecision({ key: 'Enter' }, 'allow-task', {
        targetIsNonPrimaryButton: true
      })
    ).toBeNull()
  })

  it('卡上能看到操作类型；证据不够时写明不能自动过', () => {
    const writeRequest: AgentPermissionRequest = {
      approvalId: 'approval-write',
      initiator: 'runtime',
      runtimeId: 'grok',
      taskId: 'task-1',
      turnId: 'turn-1',
      projectId: 'project-1',
      environmentId: 'local:test',
      operationType: 'write-file',
      risk: 'L1',
      title: '修改文件',
      impact: '本任务允许写入项目内文件。',
      targets: ['path: src/auth.ts', 'path: src/main/index.ts'],
      allowedScopes: ['once', 'task'],
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
    const unknownExecute: AgentPermissionRequest = {
      ...writeRequest,
      approvalId: 'approval-unknown',
      operationType: 'execute-command',
      risk: 'L3',
      title: '执行命令',
      impact: 'Runtime 请求执行命令，但当前 ACP 请求无法准确展示命令与参数。',
      targets: ['command: Runtime 未提供可信的结构化命令。'],
      allowedScopes: ['once']
    }

    expect(PERMISSION_INSUFFICIENT_EVIDENCE_NOTICE).toBe('证据不够，不能自动过')
    expect(resolvePermissionEvidenceNotice(writeRequest)).toBeNull()
    expect(resolvePermissionEvidenceNotice(unknownExecute)).toBe('证据不够，不能自动过')
    expect(
      resolvePermissionEvidenceNotice({
        targets: ['unknown: Runtime 未提供可信的目标 origin。']
      })
    ).toBe('证据不够，不能自动过')
    expect(
      resolvePermissionEvidenceNotice({
        targets: ['command: pnpm test']
      })
    ).toBeNull()

    const blocks = projectConversationTurn(
      turn('waiting-permission', [
        {
          nodeId: 'task-1:turn-1:agent-message:id:',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '准备改文件'
        }
      ]),
      { pendingPermission: writeRequest }
    )
    const permission = blocks.find((block) => block.kind === 'permission')
    expect(permission).toMatchObject({
      kind: 'permission',
      request: expect.objectContaining({
        operationType: 'write-file',
        impact: '本任务允许写入项目内文件。',
        targets: ['path: src/auth.ts', 'path: src/main/index.ts']
      })
    })
    if (permission?.kind === 'permission') {
      expect(permission.request.impact).not.toContain('指定文件')
      expect(permission.request.targets).toEqual(['path: src/auth.ts', 'path: src/main/index.ts'])
    }
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

describe('静默权限折叠摘要', () => {
  it('连续自动允许读取合成「已自动允许 12 次读取」，不是 12 张审批卡', () => {
    expect(formatSilentPermissionSummary('read-project', 12)).toBe('已自动允许 12 次读取')
    const silentReads = Array.from({ length: 12 }, (_, index) =>
      permissionAuditNode({
        auditId: `read-${index + 1}`,
        operationType: 'read-project',
        reason: index === 0 ? 'auto-allowed' : 'grant-reused'
      })
    )
    const writeRequest: AgentPermissionRequest = {
      approvalId: 'approval-write',
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
          nodeId: 'task-1:turn-1:user',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'admission',
          kind: 'user-prompt',
          text: '请改登录'
        },
        ...silentReads,
        permissionAuditNode({
          auditId: 'write-user',
          operationType: 'write-file',
          reason: 'user-allowed',
          risk: 'L1'
        })
      ]),
      { pendingPermission: writeRequest }
    )
    const auditBlocks = blocks.filter((block) => block.kind === 'permission-audit')
    const liveCards = blocks.filter((block) => block.kind === 'permission')

    expect(auditBlocks).toHaveLength(1)
    expect(auditBlocks[0]).toMatchObject({
      kind: 'permission-audit',
      summary: '已自动允许 12 次读取',
      count: 12
    })
    expect(liveCards).toHaveLength(1)
    expect(liveCards[0]).toMatchObject({
      kind: 'permission',
      primaryLabel: '本任务允许',
      request: expect.objectContaining({ approvalId: 'approval-write' })
    })
    expect(JSON.stringify(auditBlocks)).not.toContain('user-allowed')
    expect(JSON.stringify(blocks)).not.toContain('allow_always')
  })

  it('静默读取摘要不能把 live 审批卡吸到助手回复后面', () => {
    const writeRequest: AgentPermissionRequest = {
      approvalId: 'approval-write',
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
    const silentReads = Array.from({ length: 12 }, (_, index) =>
      permissionAuditNode({
        auditId: `read-${index + 1}`,
        operationType: 'read-project',
        reason: index === 0 ? 'auto-allowed' : 'grant-reused'
      })
    )
    const blocks = projectConversationTurn(
      turn('waiting-permission', [
        {
          nodeId: 'task-1:turn-1:user',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'admission',
          kind: 'user-prompt',
          text: '请改登录'
        },
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
          text: '先说明一下再改文件'
        },
        ...silentReads
      ]),
      { pendingPermission: writeRequest }
    )
    const kinds = blocks.map((block) => block.kind)
    const permissionIndex = kinds.indexOf('permission')
    const messageIndex = kinds.indexOf('message')
    const planIndex = kinds.indexOf('plan')

    expect(kinds).toEqual(['user', 'plan', 'permission', 'message', 'permission-audit'])
    expect(planIndex).toBeGreaterThanOrEqual(0)
    expect(permissionIndex).toBeGreaterThan(planIndex)
    expect(permissionIndex).toBeLessThan(messageIndex)
    expect(blocks.find((block) => block.kind === 'permission-audit')).toMatchObject({
      summary: '已自动允许 12 次读取',
      count: 12
    })
  })
})

function permissionAuditNode(
  overrides: Partial<PermissionAuditRecord> &
    Pick<PermissionAuditRecord, 'auditId' | 'operationType' | 'reason'>
): TimelinePermissionNode {
  const audit: PermissionAuditRecord = {
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
  return {
    nodeId: `task-1:turn-1:audit:${audit.auditId}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    source: 'permission-audit',
    kind: 'permission-audit',
    audit,
    foldedCount: 1
  }
}

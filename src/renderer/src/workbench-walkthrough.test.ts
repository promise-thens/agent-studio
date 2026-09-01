import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { projectConversationTurn } from './conversation-turn-view'
import { isolateSubagentToolOwnership, shouldMountSubagentCard } from './conversation-subagent-view'
import { evaluateTaskComposerSend } from './task-composer-actions'
import { resolvePermissionCardPresentation } from './conversation-turn-view'
import {
  collectWorkbenchWalkthroughFacts,
  completedPlanCheckMarkRotation
} from './workbench-walkthrough'
import type { TimelineToolNode, TurnTimelineViewModel } from './task-timeline-reducer'
import type { ConversationSubagentBlock } from './conversation-turn-view'

const root = dirname(fileURLToPath(import.meta.url))
const mainCss = readFileSync(join(root, 'assets/main.css'), 'utf8')
const baseCss = readFileSync(join(root, 'assets/base.css'), 'utf8')
const conversationTurnSource = readFileSync(join(root, 'components/ConversationTurn.vue'), 'utf8')
const subagentCardSource = readFileSync(join(root, 'components/SubagentCard.vue'), 'utf8')
const conversationTurnViewSource = readFileSync(join(root, 'conversation-turn-view.ts'), 'utf8')
const toolRowSource = readFileSync(join(root, 'components/ToolRow.vue'), 'utf8')
const permissionSource = readFileSync(join(root, 'components/PermissionPrompt.vue'), 'utf8')
const composerSource = readFileSync(join(root, 'components/TaskComposer.vue'), 'utf8')
const permissionModeSource = readFileSync(
  join(root, 'components/TaskPermissionModeMenu.vue'),
  'utf8'
)
const takeoverConfirmSource = readFileSync(
  join(root, 'components/TaskTakeoverConfirmDialog.vue'),
  'utf8'
)

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

function turn(nodes: TurnTimelineViewModel['nodes']): TurnTimelineViewModel {
  return {
    taskId: 'task-1',
    turnId: 'turn-1',
    prompt: '请改登录',
    model: { modelId: 'model-1' },
    status: 'waiting-permission',
    statusProvisional: false,
    statusConflict: false,
    createdAt: '2026-08-12T00:00:00.000Z',
    nodes,
    usage: { contextSamples: [] },
    historyTruncated: false
  }
}

describe('工作台对照走查（夹具，非桌面 GUI）', () => {
  it('大修后主列是对话密度，不是日志；历史可打字、执行可停、审批不挡、子 Agent 不串', () => {
    const blocks = projectConversationTurn(
      turn([
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
        tool('read-1', '读取 package.json', 'completed'),
        tool('read-2', '读取 src/auth.ts', 'completed'),
        {
          nodeId: 'task-1:turn-1:agent-message:id:',
          taskId: 'task-1',
          turnId: 'turn-1',
          source: 'agent-event',
          kind: 'message',
          text: '正在改登录'
        }
      ]),
      {
        pendingPermission: {
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
      }
    )

    const historySend = evaluateTaskComposerSend({
      prompt: '补一个测试',
      selectedTaskId: 'task-1',
      activeExecution: null,
      restore: 'ready',
      providerConfigured: true,
      projectSelectionPending: false,
      turnTiming: false,
      promptSubmissionPending: false,
      promptCapabilityAvailable: true,
      runtimeConnected: false
    })

    const cards: ConversationSubagentBlock[] = [
      {
        kind: 'subagent',
        nodeId: 'task-1:turn-1:tool:child-a',
        name: '探查测试结构',
        status: 'running',
        tools: [
          {
            kind: 'tool',
            nodeId: 'task-1:turn-1:tool:read-pkg',
            label: '读了 package.json',
            status: 'completed',
            tools: [tool('read-pkg', '读取 package.json')]
          }
        ]
      },
      {
        kind: 'subagent',
        nodeId: 'task-1:turn-1:tool:child-b',
        name: '改登录逻辑',
        status: 'completed',
        tools: [
          {
            kind: 'tool',
            nodeId: 'task-1:turn-1:tool:write-auth',
            label: '写入 src/auth.ts',
            status: 'completed',
            tools: [tool('write-auth', '写入 src/auth.ts')]
          }
        ]
      }
    ]

    const facts = collectWorkbenchWalkthroughFacts({
      baseCss,
      mainCss,
      conversationTurnSource,
      toolRowSource,
      permissionSource,
      composerSource,
      subagentCardSource,
      blocks,
      historyCanSend: historySend.canSend,
      permissionPresentation: resolvePermissionCardPresentation(),
      subagentOwnership: isolateSubagentToolOwnership(cards)
    })

    expect(facts.titlebarHeight).toBe('46px')
    expect(facts.workspaceColumns).toBe('220px 1fr')
    expect(facts.conversationMaxWidth).toBe('840px')
    expect(facts.toolLooksLikeLog).toBe(false)
    expect(facts.hasContinueTask).toBe(false)
    expect(facts.historyAllowsTyping).toBe(true)
    expect(facts.stopReachableWhileExecuting).toBe(true)
    expect(facts.permissionBlocksConversation).toBe(false)
    expect(facts.subagentMountedWithoutParent).toBe(false)
    expect(facts.twoSubagentsShareTools).toBe(false)
    expect(facts.hasFakeSubagentChildCancel).toBe(false)
    expect(subagentCardSource).not.toMatch(/<SubagentCard\b/)
    expect(subagentCardSource).toContain('v-for="tool in rows"')
    expect(subagentCardSource).toContain(':key="tool.key"')
    expect(subagentCardSource).toContain('执行结果')
    expect(subagentCardSource).not.toContain('<Teleport')
    expect(blocks.some(shouldMountSubagentCard)).toBe(false)
    expect(facts.enterSendsWithImeGuard).toBe(true)
    expect(permissionSource).toContain('resolvePermissionOriginLabel')
    expect(permissionSource).toContain('permission-inline-origin')
    expect(permissionSource).toContain('resolvePermissionCardKeyDecision')
    expect(permissionSource).toContain('resolvePermissionEvidenceNotice')
    expect(conversationTurnViewSource).toContain('证据不够，不能自动过')
    expect(conversationTurnViewSource).toContain('formatSilentPermissionSummary')
    expect(conversationTurnSource).toContain("block.kind === 'permission-audit'")
    expect(conversationTurnSource).not.toMatch(
      /block\.kind === 'permission-audit'[\s\S]{0,200}PermissionPrompt/
    )
    expect(permissionSource).not.toContain('role="dialog"')
    expect(composerSource).toContain('TaskPermissionModeMenu')
    expect(composerSource).toContain('TaskTakeoverConfirmDialog')
    expect(composerSource).toContain('openPermissionModeFromSlash')
    expect(permissionModeSource).toContain('shouldResubmitPermissionMode')
    expect(permissionModeSource).toContain('takeoverMayStillBeActive')
    expect(permissionModeSource).toContain('应如何批准操作？')
    expect(permissionModeSource).toContain('请求批准')
    expect(permissionModeSource).toContain('帮我批准')
    expect(permissionModeSource).toContain('完全访问')
    expect(takeoverConfirmSource).toContain('让 Grok 完全接管当前任务？')
    expect(takeoverConfirmSource).toContain('将不再询问工具权限')
    expect(takeoverConfirmSource).toContain('桌面看不到未上报的操作')
    expect(takeoverConfirmSource).toContain('命令、改文件、出网都会自己做')
    expect(takeoverConfirmSource).toContain('若已启用浏览器或 Computer Use 插件，也会自己点')
  })
})

describe('计划完成勾', () => {
  it('completed 使用 45deg 打勾，而不是未旋转的 L', () => {
    expect(completedPlanCheckMarkRotation(mainCss)).toBe('45deg')
  })
})

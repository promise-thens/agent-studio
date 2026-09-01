import { describe, expect, it } from 'vitest'
import {
  COMPOSER_COMPACT_ALWAYS_VISIBLE,
  COMPOSER_COMPACT_MIN_WIDTH_PX,
  canSendWhileConversationRestoring,
  evaluateTaskComposerSend,
  isForeignExecutionBlockingSend,
  pickLatestContextUsage,
  resolveCancelTurnRequest,
  resolveComposerAction,
  resolveComposerChrome,
  resolveComposerContextUsage,
  resolveProviderModelLabel,
  resolveStopButtonAriaLabel,
  resolveStopButtonTitle,
  restoreComposerPromptAfterFailure,
  resolveTaskHeaderFacts,
  resolveTaskHeaderMainPath,
  shouldShowTaskHeaderFacts
} from './task-composer-actions'
import { resolveConversationConnectFailure } from './task-conversation-view'

const runningExecution = {
  executionId: 'exec-a',
  taskId: 'task-a',
  turnId: 'turn-a',
  state: 'running' as const,
  model: { modelId: 'grok-code', displayName: '  Code Fast  ' }
}

describe('模型标签', () => {
  it('只使用真实 displayName 或原样 modelId，不加 Grok · 前缀', () => {
    expect(resolveProviderModelLabel({ modelId: 'grok-code', displayName: '  Code Fast  ' })).toBe(
      'Code Fast'
    )
    expect(resolveProviderModelLabel({ modelId: 'grok-code', displayName: '   ' })).toBe(
      'grok-code'
    )
    expect(resolveProviderModelLabel({ modelId: 'grok-code' })).toBe('grok-code')
    expect(resolveProviderModelLabel({ modelId: 'grok-code', displayName: 'Grok · Code' })).toBe(
      'Grok · Code'
    )
    expect(resolveProviderModelLabel({ modelId: 'grok-code' })).not.toMatch(/^Grok ·/)
    expect(resolveProviderModelLabel(null)).toBe('')
  })
})

describe('发送与停止身份', () => {
  it('停止始终打到 activeExecution，即使 selectedTaskId 是另一个 Task', () => {
    const request = resolveCancelTurnRequest(runningExecution, 'task-b')
    expect(request).toEqual({
      executionId: 'exec-a',
      taskId: 'task-a',
      turnId: 'turn-a'
    })
    expect(request?.taskId).not.toBe('task-b')
    expect(resolveComposerAction(runningExecution)).toBe('stop')
    expect(resolveStopButtonTitle(runningExecution)).toBe('停止 Task task-a')
    expect(resolveStopButtonAriaLabel(runningExecution, '后台调研')).toBe('停止 后台调研')
    expect(resolveStopButtonAriaLabel(runningExecution, undefined)).toBe('停止 Task task-a')
  })

  it('外槽执行占用单执行槽时禁止向当前选中 Task 发送', () => {
    expect(isForeignExecutionBlockingSend(runningExecution, 'task-b')).toBe(true)
    expect(isForeignExecutionBlockingSend(runningExecution, 'task-a')).toBe(false)
    expect(
      isForeignExecutionBlockingSend({ ...runningExecution, state: 'completed' }, 'task-b')
    ).toBe(false)

    const blocked = evaluateTaskComposerSend({
      prompt: '继续改登录',
      selectedTaskId: 'task-b',
      activeExecution: runningExecution,
      restore: 'ready',
      providerConfigured: true,
      projectSelectionPending: false,
      turnTiming: false,
      promptSubmissionPending: false,
      promptCapabilityAvailable: true,
      runtimeConnected: true
    })
    expect(blocked.canSend).toBe(false)
    expect(blocked.reason).toBe('先停掉当前任务。')
  })

  it('GACP-02：restore 为 connecting/degraded/ready/idle 时 Composer 仍可发送', () => {
    for (const restore of ['connecting', 'degraded', 'ready', 'idle'] as const) {
      expect(canSendWhileConversationRestoring(restore)).toBe(true)
      const result = evaluateTaskComposerSend({
        prompt: '补一个测试',
        selectedTaskId: 'task-b',
        activeExecution: null,
        restore,
        providerConfigured: true,
        projectSelectionPending: false,
        turnTiming: false,
        promptSubmissionPending: false,
        promptCapabilityAvailable: true,
        runtimeConnected: false
      })
      expect(result.canSend).toBe(true)
    }

    expect(canSendWhileConversationRestoring('unavailable')).toBe(false)
    expect(
      evaluateTaskComposerSend({
        prompt: '补一个测试',
        selectedTaskId: 'task-b',
        activeExecution: null,
        restore: 'unavailable',
        providerConfigured: true,
        projectSelectionPending: false,
        turnTiming: false,
        promptSubmissionPending: false,
        promptCapabilityAvailable: true,
        runtimeConnected: true
      }).canSend
    ).toBe(false)
  })

  it('只有附件没有正文时也可以发送', () => {
    const ready = {
      prompt: '   ',
      selectedTaskId: 'task-a',
      activeExecution: null,
      restore: 'ready' as const,
      providerConfigured: true,
      projectSelectionPending: false,
      turnTiming: false,
      promptSubmissionPending: false,
      promptCapabilityAvailable: true,
      runtimeConnected: true
    }
    expect(evaluateTaskComposerSend(ready).canSend).toBe(false)
    expect(evaluateTaskComposerSend({ ...ready, hasAttachments: true }).canSend).toBe(true)
  })

  it('发送失败后恢复已清空的草稿，不覆盖用户新输入', () => {
    expect(restoreComposerPromptAfterFailure('', '原来的草稿')).toBe('原来的草稿')
    expect(restoreComposerPromptAfterFailure('用户又打了字', '原来的草稿')).toBe('用户又打了字')
  })

  it('空闲发送、执行中停止；模型 busy，输入框仍在，980 宽仍见模型和停止', () => {
    const idle = resolveComposerChrome({ activeExecution: null })
    expect(idle.action).toBe('send')
    expect(idle.modelBusy).toBe(false)
    expect(idle.textareaVisible).toBe(true)
    expect(resolveComposerAction(null)).toBe('send')

    const running = resolveComposerChrome({ activeExecution: runningExecution })
    expect(running.action).toBe('stop')
    expect(running.modelBusy).toBe(true)
    expect(running.textareaVisible).toBe(true)
    expect(running.keepVisibleAtCompactWidth).toEqual([
      'model',
      'permission-mode',
      'plan',
      'send-or-stop'
    ])
    expect(COMPOSER_COMPACT_MIN_WIDTH_PX).toBe(980)
    expect(COMPOSER_COMPACT_ALWAYS_VISIBLE).toEqual([
      'model',
      'permission-mode',
      'plan',
      'send-or-stop'
    ])

    expect(
      resolveComposerChrome({
        activeExecution: null,
        projectInteractionBlocked: true
      }).modelBusy
    ).toBe(true)
  })

  it('输入框只展示上下文 used/limit，没数据就藏', () => {
    expect(
      resolveComposerContextUsage({ scope: 'context', usedTokens: 120, limitTokens: 4096 })
    ).toBe('120/4096')
    expect(resolveComposerContextUsage(null)).toBeNull()
    expect(
      resolveComposerContextUsage({ scope: 'turn', usedTokens: 12, limitTokens: 100 })
    ).toBeNull()
    expect(
      resolveComposerContextUsage({
        scope: 'context',
        usedTokens: Number.NaN,
        limitTokens: 4096
      })
    ).toBeNull()

    expect(pickLatestContextUsage(null)).toBeNull()
    expect(
      pickLatestContextUsage({
        turns: [
          { usage: { contextSamples: [] } },
          {
            usage: {
              contextSamples: [{ scope: 'context', usedTokens: 88, limitTokens: 2048 }]
            }
          }
        ]
      })
    ).toEqual({ scope: 'context', usedTokens: 88, limitTokens: 2048 })
    expect(
      resolveComposerContextUsage(
        pickLatestContextUsage({
          turns: [{ usage: { contextSamples: [] } }]
        })
      )
    ).toBeNull()
  })
})

describe('Task 页眉事实', () => {
  it('运行中展示执行快照模型，并区分选中 Task 与后台运行 Task', () => {
    const viewingB = resolveTaskHeaderFacts({
      selectedTaskId: 'task-b',
      selectedTitle: '改登录',
      selectedProjectName: 'studio',
      selectedRuntimeId: 'grok',
      selectedState: 'completed',
      createdAt: '2026-08-12T00:00:00.000Z',
      selectedModel: { modelId: 'other-model', displayName: 'Other' },
      activeExecution: runningExecution,
      runningTaskTitle: '后台调研',
      restore: 'ready'
    })

    expect(viewingB.runtimeLabel).toBe('Grok Build')
    expect(viewingB.modelLabel).toBe('Other')
    expect(viewingB.modelLabel).not.toMatch(/^Grok ·/)
    expect(viewingB.environmentLabel).toBe('Local')
    expect(viewingB.worktreeLabel).toContain('尚未接入')
    expect(viewingB.viewingForeignExecution).toBe(true)
    expect(viewingB.executionScope).toBe('foreign')
    expect(viewingB.modelReadOnly).toBe(false)
    expect(viewingB.weakStatusLine).toContain('后台调研')

    const viewingA = resolveTaskHeaderFacts({
      selectedTaskId: 'task-a',
      selectedTitle: '后台调研',
      selectedProjectName: 'studio',
      selectedRuntimeId: 'grok',
      selectedState: 'running',
      createdAt: '2026-08-12T00:00:00.000Z',
      selectedModel: { modelId: 'other-model', displayName: 'Other' },
      activeExecution: runningExecution,
      runningTaskTitle: '后台调研',
      restore: 'connecting',
      restoreReason: '正在接回上次上下文…'
    })
    expect(viewingA.modelLabel).toBe('Code Fast')
    expect(viewingA.modelReadOnly).toBe(true)
    expect(viewingA.viewingForeignExecution).toBe(false)
    expect(viewingA.executionScope).toBe('selected')
    expect(viewingA.weakStatusLine).toBe('正在接回上次上下文…')
  })

  it('切到无选中 Task 的 Project 时仍标记 foreign 并保留后台状态文案', () => {
    const viewingNone = resolveTaskHeaderFacts({
      selectedTaskId: '',
      selectedProjectName: 'other',
      activeExecution: runningExecution
    })

    expect(viewingNone.executionScope).toBe('foreign')
    expect(viewingNone.viewingForeignExecution).toBe(true)
    expect(viewingNone.weakStatusLine).toMatch(/后台/)
  })

  it('无活动执行时页眉提供弱状态连接钩子，而不是主按钮文案', () => {
    const idle = resolveTaskHeaderFacts({
      selectedTaskId: 'task-b',
      selectedTitle: '改登录',
      selectedProjectName: 'studio',
      selectedRuntimeId: 'grok',
      runtimeState: 'idle',
      runtimeMessage: '尚未连接 Grok Build',
      providerConfigured: true,
      activeExecution: null
    })
    expect(idle.runtimeState).toBe('idle')
    expect(idle.executionScope).toBe('none')
    expect(idle.canRetryConnect).toBe(true)
    expect(idle.weakStatusLine).not.toContain('连接 Grok')

    const crashed = resolveTaskHeaderFacts({
      selectedTaskId: 'task-b',
      selectedTitle: '改登录',
      selectedProjectName: 'studio',
      selectedRuntimeId: 'grok',
      runtimeState: 'error',
      runtimeMessage: 'Runtime 异常退出（代码 17）',
      providerConfigured: true,
      activeExecution: null
    })
    expect(crashed.runtimeState).toBe('error')
    expect(crashed.canRetryConnect).toBe(true)
    expect(crashed.weakStatusLine).toBe('连接异常')
    expect(crashed.weakStatusLine).not.toContain('代码 17')
  })

  it('对话流已展示连接失败全文时，页眉弱状态不再重复完整 Runtime 文案', () => {
    const runtimeMessage = 'Runtime 异常退出（代码 17）'
    const facts = resolveTaskHeaderFacts({
      selectedTaskId: 'task-b',
      selectedTitle: '改登录',
      selectedProjectName: 'studio',
      selectedRuntimeId: 'grok',
      runtimeState: 'error',
      runtimeMessage,
      providerConfigured: true,
      activeExecution: null
    })
    const main = resolveTaskHeaderMainPath(facts)
    const stream = resolveConversationConnectFailure({
      runtimeState: facts.runtimeState,
      runtimeMessage,
      providerConfigured: true,
      hasActiveExecution: false
    })

    expect(stream?.message).toBe(runtimeMessage)
    expect(stream?.canRetry).toBe(true)
    expect(main.weakStatusLine).not.toBe(runtimeMessage)
    expect(main.weakStatusLine).not.toContain('代码 17')
    expect(main.weakStatusLine).toBe('连接异常')
  })

  it('主路径页眉只暴露标题和弱状态，不把 Project/Runtime/环境当必显运维芯片', () => {
    const facts = resolveTaskHeaderFacts({
      selectedTaskId: 'task-b',
      selectedTitle: '改登录',
      selectedProjectName: 'studio',
      selectedRuntimeId: 'grok',
      selectedState: 'completed',
      createdAt: '2026-08-12T00:00:00.000Z',
      selectedModel: { modelId: 'other-model', displayName: 'Other' },
      runtimeState: 'idle',
      runtimeMessage: '尚未连接 Grok Build',
      providerConfigured: true,
      activeExecution: null
    })
    const main = resolveTaskHeaderMainPath(facts)

    expect(shouldShowTaskHeaderFacts()).toBe(false)
    expect(Object.keys(main).sort()).toEqual(
      ['canRetryConnect', 'executionScope', 'runtimeState', 'title', 'weakStatusLine'].sort()
    )
    expect(main.title).toBe('改登录')
    expect(main).not.toHaveProperty('projectName')
    expect(main).not.toHaveProperty('runtimeLabel')
    expect(main).not.toHaveProperty('environmentLabel')
    expect(main).not.toHaveProperty('worktreeLabel')
    expect(`${main.title}${main.weakStatusLine}`).not.toContain('连接 Grok')
    expect(`${main.title}${main.weakStatusLine}`).not.toContain('继续任务')
  })
})

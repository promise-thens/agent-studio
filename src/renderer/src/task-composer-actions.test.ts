import { describe, expect, it } from 'vitest'
import {
  COMPOSER_COMPACT_ALWAYS_VISIBLE,
  COMPOSER_COMPACT_MIN_WIDTH_PX,
  canSendWhileConversationRestoring,
  evaluateTaskComposerSend,
  formatComposerContextUsageRingLabel,
  isForeignExecutionBlockingSend,
  pickLatestContextUsage,
  presentComposerContextUsage,
  resolveCancelTurnRequest,
  resolveComposerAction,
  resolveComposerAddMenuFocusIndex,
  resolveComposerChrome,
  resolveComposerContextUsage,
  resolveComposerContextUsagePresentation,
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

describe('添加能力菜单键盘导航', () => {
  it('方向键循环，Home/End 直达边界，缺少当前项时选择对应端点', () => {
    expect(resolveComposerAddMenuFocusIndex('ArrowDown', 0, 2)).toBe(1)
    expect(resolveComposerAddMenuFocusIndex('ArrowDown', 1, 2)).toBe(0)
    expect(resolveComposerAddMenuFocusIndex('ArrowUp', 0, 2)).toBe(1)
    expect(resolveComposerAddMenuFocusIndex('ArrowUp', -1, 2)).toBe(1)
    expect(resolveComposerAddMenuFocusIndex('Home', 1, 2)).toBe(0)
    expect(resolveComposerAddMenuFocusIndex('End', 0, 2)).toBe(1)
    expect(resolveComposerAddMenuFocusIndex('ArrowDown', 0, 0)).toBeNull()
  })
})

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

  it('切换 Runtime 或创建新对话期间禁用发送，避免草稿撞上未完成的 Task 身份', () => {
    const ready = {
      prompt: '立即发送',
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

    expect(evaluateTaskComposerSend({ ...ready, projectConnectionPending: true })).toEqual({
      canSend: false,
      reason: '正在准备项目，请稍候。'
    })
    expect(evaluateTaskComposerSend({ ...ready, taskCreationPending: true })).toEqual({
      canSend: false,
      reason: '正在创建对话，请稍候。'
    })
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

  it('上下文用量展示同时提供占比、title 和无障碍文案', () => {
    expect(
      resolveComposerContextUsagePresentation({
        scope: 'context',
        usedTokens: 120,
        limitTokens: 4096
      })
    ).toMatchObject({
      label: '120/4096',
      compactLabel: '120 / 4.1k',
      percentage: 2.9,
      percentLabel: '2.9%',
      title: '上下文用量：120/4096 tokens（2.9%）',
      ariaLabel: '上下文已使用 120 / 4096 tokens，占 2.9%'
    })
    expect(
      resolveComposerContextUsagePresentation({
        scope: 'context',
        usedTokens: 5000,
        limitTokens: 4096
      })?.percentage
    ).toBe(100)
    expect(resolveComposerContextUsagePresentation(null)?.percentage).toBeNull()
    expect(
      resolveComposerContextUsagePresentation({
        scope: 'context',
        usedTokens: 24280,
        limitTokens: 500000
      })
    ).toMatchObject({
      compactLabel: '24.3k / 500k',
      percentLabel: '4.9%'
    })
  })

  it('新对话尚无快照时标为未知，不能冒充真实零', () => {
    expect(presentComposerContextUsage(null)).toBeNull()
    expect(presentComposerContextUsage({ turns: [] })).toBeNull()
    expect(
      presentComposerContextUsage({
        turns: [{ status: 'running', usage: { contextSamples: [] } }]
      })
    ).toMatchObject({
      compactLabel: '未知',
      label: '未知',
      percentage: null
    })
    expect(
      presentComposerContextUsage({
        turns: [{ status: 'completed', usage: { contextSamples: [] } }]
      })?.compactLabel
    ).toBe('未知')
  })

  it('首轮保留包含记忆基线的真实上下文样本，不冒充累计消耗', () => {
    const baseline = {
      scope: 'context' as const,
      usedTokens: 142000,
      limitTokens: 500000
    }
    expect(
      presentComposerContextUsage({
        turns: [
          {
            status: 'running',
            usage: { contextSamples: [baseline] }
          }
        ]
      })
    ).toMatchObject({
      compactLabel: '142k / 500k',
      label: '142000/500000',
      percentage: 28.4
    })
    expect(
      presentComposerContextUsage({
        turns: [
          {
            status: 'pending',
            usage: { contextSamples: [baseline] }
          }
        ]
      })?.compactLabel
    ).toBe('142k / 500k')
    expect(
      presentComposerContextUsage({
        turns: [
          {
            status: 'completed',
            usage: { contextSamples: [baseline] }
          }
        ]
      })
    ).toMatchObject({
      compactLabel: '142k / 500k',
      label: '142000/500000'
    })
  })

  it('真实零、无效上限和超限分别展示，圆环夹紧但详情不截断比例', () => {
    const sample = { scope: 'context' as const, usedTokens: 0, limitTokens: 100 }
    expect(resolveComposerContextUsagePresentation(sample)?.percentLabel).toBe('0%')
    expect(resolveComposerContextUsagePresentation({ ...sample, limitTokens: 0 })).toMatchObject({
      percentage: null,
      percentLabel: '未知',
      usedLabel: '0'
    })
    expect(resolveComposerContextUsagePresentation({ ...sample, usedTokens: 150 })).toMatchObject({
      percentage: 100,
      percentLabel: '150%'
    })
    for (const usedTokens of [-1, NaN, Infinity]) {
      expect(
        resolveComposerContextUsagePresentation({ ...sample, usedTokens })?.percentage
      ).toBeNull()
    }
  })

  it('小于 1% 的真实占用不在圆环中显示成零', () => {
    for (const usedTokens of [1, 4]) {
      const presentation = resolveComposerContextUsagePresentation({
        scope: 'context',
        usedTokens,
        limitTokens: 1000
      })
      expect(presentation.percentage).toBe(usedTokens / 10)
      expect(presentation.percentLabel).toBe(`${usedTokens / 10}%`)
      expect(formatComposerContextUsageRingLabel(presentation.percentage)).toBe('<1')
    }
    expect(formatComposerContextUsageRingLabel(0)).toBe('0')
    expect(formatComposerContextUsageRingLabel(null)).toBe('?')
  })

  it('卡片主副标题正确格式化为对标图3的友好美观展示', () => {
    // 典型场景：35k / 258k
    const normal = resolveComposerContextUsagePresentation({
      scope: 'context',
      usedTokens: 35000,
      limitTokens: 258000
    })
    expect(normal.cardHeadline).toBe('13.6% 已用（剩余 86.4%）')
    expect(normal.cardTokenDetail).toBe('已用 35k 标记，共 258k')

    // 小比例场景：2985 / 500000
    const small = resolveComposerContextUsagePresentation({
      scope: 'context',
      usedTokens: 2985,
      limitTokens: 500000
    })
    expect(small.cardHeadline).toBe('0.6% 已用（剩余 99.4%）')
    expect(small.cardTokenDetail).toBe('已用 3k 标记，共 500k')

    // 超限场景
    const overflow = resolveComposerContextUsagePresentation({
      scope: 'context',
      usedTokens: 150,
      limitTokens: 100
    })
    expect(overflow.cardHeadline).toBe('150% 已用（已超限）')
    expect(overflow.cardTokenDetail).toBe('已用 150 标记，共 100')

    // 空/未知场景
    const empty = resolveComposerContextUsagePresentation(null)
    expect(empty.cardHeadline).toBe('用量统计中...')
    expect(empty.cardTokenDetail).toBe('容量尚未同步')
  })

  it('跳过坏样本回看可信样本，旧轮样本明确提示非实时，切任务不缓存', () => {
    const sample = { scope: 'context' as const, usedTokens: 20, limitTokens: 100 }
    expect(
      pickLatestContextUsage({
        turns: [{ usage: { contextSamples: [sample, { ...sample, usedTokens: NaN }] } }]
      })
    ).toEqual(sample)
    expect(
      presentComposerContextUsage({
        turns: [{ usage: { contextSamples: [sample] } }, { usage: { contextSamples: [] } }]
      })?.sourceLabel
    ).toContain('较早轮次')
    expect(
      presentComposerContextUsage({
        turns: [{ usage: { contextSamples: [] } }]
      })?.percentage
    ).toBeNull()
  })

  it('第二轮执行期间上一轮终态尚未回填时，Composer 不把真实用量清零', () => {
    const previousTurnUsage = {
      scope: 'context' as const,
      usedTokens: 142000,
      limitTokens: 500000
    }
    expect(
      presentComposerContextUsage({
        turns: [
          {
            // 实时 Timeline 可能暂时仍是 pending，直到历史记录异步刷新。
            status: 'pending',
            usage: { contextSamples: [previousTurnUsage] }
          },
          {
            status: 'running',
            usage: { contextSamples: [] }
          }
        ]
      })
    ).toMatchObject({
      compactLabel: '142k / 500k',
      label: '142000/500000',
      percentage: 28.4
    })
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

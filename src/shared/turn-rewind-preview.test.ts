import { describe, expect, it } from 'vitest'
import type { LatestTurnRestorePreview, TaskChangeSet } from './git-review'
import {
  GROK_REWIND_SLASH_COMMAND,
  GROK_UNDO_SLASH_COMMAND,
  TURN_REWIND_COMMAND_MISSING_COPY,
  TURN_REWIND_CONVERSATION_DESCRIPTION,
  buildTurnRewindPreview,
  clampTurnRewindSelection,
  defaultTurnRewindSelection,
  isTurnRewindBusy,
  nextTurnRewindSelection,
  presentTurnRewindCard,
  resolveTurnRewindConversationPrompt
} from './turn-rewind-preview'

const compactOnly = [{ name: 'compact' }, { name: 'help' }, { name: 'view-rewind' }]

function latestTurnPreview(): LatestTurnRestorePreview {
  return {
    taskId: 'task-1',
    revertible: {
      kind: 'latest-turn',
      turnId: 'turn-1',
      paths: ['README.md'],
      restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
    },
    willLosePaths: ['README.md']
  }
}

function nonePreview(reason: string): LatestTurnRestorePreview {
  return {
    taskId: 'task-1',
    revertible: { kind: 'none', reason },
    willLosePaths: []
  }
}

function latestTurnRevertible(): Extract<TaskChangeSet['revertible'], { kind: 'latest-turn' }> {
  return {
    kind: 'latest-turn',
    turnId: 'turn-1',
    paths: ['README.md'],
    restorePlan: [{ path: 'README.md', action: 'write', from: 'head' }]
  }
}

describe('buildTurnRewindPreview 对话状态', () => {
  it('无 rewind/undo 广告时是 command-missing，没有 conversationCommandName', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(preview.conversation).toBe('command-missing')
    expect(preview.conversationCommandName).toBeUndefined()
    expect(preview).not.toHaveProperty('conversationCommandName')
  })

  it('view-rewind、/rewind、子串匹配都不算广告', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [
        { name: 'view-rewind' },
        { name: '/rewind' },
        { name: 'rewind-session' },
        { name: 'prewind' }
      ],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(preview.conversation).toBe('command-missing')
    expect(preview.conversationCommandName).toBeUndefined()
  })

  it('夹具广告 rewind 且空闲时 available，commandName 是 rewind', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'compact' }, { name: 'rewind' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(preview.conversation).toBe('available')
    expect(preview.conversationCommandName).toBe('rewind')
  })

  it('夹具只广告 undo 时 commandName 是 undo', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'undo' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(preview.conversation).toBe('available')
    expect(preview.conversationCommandName).toBe('undo')
  })

  it('同时广告 rewind 与 undo 时 rewind 优先', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'undo' }, { name: 'rewind' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(preview.conversationCommandName).toBe('rewind')
  })

  it('busy 时 conversation=busy，即使有广告也没有 commandName', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: true,
      restorePreview: latestTurnPreview()
    })
    expect(preview.conversation).toBe('busy')
    expect(preview.conversationCommandName).toBeUndefined()
  })
})

describe('buildTurnRewindPreview 文件状态', () => {
  it('revertible.kind=none 且原因含漂移时 files.blocked，文案含原因', () => {
    const reason = '执行环境已漂移，不能自动恢复上一轮文件。'
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: nonePreview(reason)
    })
    expect(preview.files.blocked).toBe(true)
    expect(preview.files.reason).toBe(reason)
    expect(preview.files.reason).toMatch(/漂移/)
    expect(preview.files.preview?.revertible.kind).toBe('none')
  })

  it('revertible.kind=none 且原因含无检查点时 files.blocked，文案含原因', () => {
    const reason = '没有已完成的写入型最新一轮。'
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: nonePreview(reason)
    })
    expect(preview.files.blocked).toBe(true)
    expect(preview.files.reason).toBe(reason)
    expect(preview.files.reason).toMatch(/没有已完成的写入型最新一轮/)
  })

  it('preview 缺失且无 changeSet revertible 时 files.blocked', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: null
    })
    expect(preview.files.blocked).toBe(true)
    expect(preview.files.preview).toBeNull()
    expect(preview.files.reason).toMatch(/不能自动恢复上一轮文件|不提供一键恢复上一轮文件/)
  })

  it('尚未拉 IPC 预览但 changeSet 是 latest-turn 时文件行不 blocked', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: null,
      changeSetRevertible: latestTurnRevertible()
    })
    expect(preview.files.blocked).toBe(false)
    expect(preview.files.preview).toBeNull()
  })

  it('IPC 预览已是 latest-turn 时文件行不 blocked 并保留预览', () => {
    const restorePreview = latestTurnPreview()
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview
    })
    expect(preview.files.blocked).toBe(false)
    expect(preview.files.preview).toBe(restorePreview)
    expect(preview.files.reason).toBeUndefined()
  })
})

describe('对话 prompt 与默认勾选', () => {
  it('command-missing 时不得把 prompt 设成 /rewind 或 /undo', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(resolveTurnRewindConversationPrompt(preview)).toBeNull()
    expect(presentTurnRewindCard(preview).conversationPrompt).toBeNull()
  })

  it('busy 时即使广告了 rewind 也不产出 prompt', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: true,
      restorePreview: latestTurnPreview()
    })
    expect(resolveTurnRewindConversationPrompt(preview)).toBeNull()
  })

  it('空闲且广告 rewind 时 prompt 才是快照真名', () => {
    const rewind = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    const undo = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'undo' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(resolveTurnRewindConversationPrompt(rewind)).toBe('/rewind')
    expect(resolveTurnRewindConversationPrompt(undo)).toBe('/undo')
  })

  it('能用的行默认勾；disabled 行不得勾成将要执行', () => {
    const available = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(defaultTurnRewindSelection(available)).toEqual({ conversation: true, files: true })

    const missing = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: nonePreview('执行环境已漂移，不能自动恢复上一轮文件。')
    })
    expect(defaultTurnRewindSelection(missing)).toEqual({ conversation: false, files: false })
    expect(clampTurnRewindSelection(missing, { conversation: true, files: true })).toEqual({
      conversation: false,
      files: false
    })

    const busy = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: true,
      restorePreview: latestTurnPreview()
    })
    expect(defaultTurnRewindSelection(busy)).toEqual({ conversation: false, files: false })
  })

  it('取消对话后，相同 conversation/blocked 的新预览对象不得把对话重新勾上', () => {
    const previous = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: false,
      restorePreview: null,
      changeSetRevertible: latestTurnRevertible()
    })
    const next = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    expect(previous.conversation).toBe('available')
    expect(next.conversation).toBe('available')
    expect(previous.files.blocked).toBe(false)
    expect(next.files.blocked).toBe(false)
    expect(previous).not.toBe(next)
    expect(
      nextTurnRewindSelection({
        previousConversation: previous.conversation,
        previousFilesBlocked: previous.files.blocked,
        next,
        selection: { conversation: false, files: true }
      })
    ).toEqual({ conversation: false, files: true })
  })
})

describe('presentTurnRewindCard 禁用态', () => {
  it('command-missing 时对话 checkbox disabled，说明当前会话未提供 rewind', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: latestTurnPreview()
    })
    const view = presentTurnRewindCard(preview)
    expect(view.conversationCheckboxDisabled).toBe(true)
    expect(view.conversationChecked).toBe(false)
    expect(view.conversationDescription).toBe(TURN_REWIND_CONVERSATION_DESCRIPTION)
    expect(view.conversationStatusCopy).toBe(TURN_REWIND_COMMAND_MISSING_COPY)
    expect(view.conversationStatusCopy).toMatch(/当前会话未提供 rewind/)
    expect(view.conversationPrompt).toBeNull()
  })

  it('busy 时对话 checkbox disabled，文件按钮也 disabled', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: true,
      restorePreview: latestTurnPreview()
    })
    const view = presentTurnRewindCard(preview)
    expect(view.conversationCheckboxDisabled).toBe(true)
    expect(view.conversationChecked).toBe(false)
    expect(view.filesCheckboxDisabled).toBe(true)
    expect(view.filesChecked).toBe(false)
    expect(view.filesButtonDisabled).toBe(true)
  })

  it('漂移/无检查点时文件按钮 disabled 且文案含原因', () => {
    const drift = presentTurnRewindCard(
      buildTurnRewindPreview({
        advertisedCommands: compactOnly,
        busy: false,
        restorePreview: nonePreview('执行环境已漂移，不能自动恢复上一轮文件。')
      })
    )
    expect(drift.filesButtonDisabled).toBe(true)
    expect(drift.filesCheckboxDisabled).toBe(true)
    expect(drift.filesChecked).toBe(false)
    expect(drift.filesReason).toMatch(/漂移/)

    const missingCheckpoint = presentTurnRewindCard(
      buildTurnRewindPreview({
        advertisedCommands: compactOnly,
        busy: false,
        restorePreview: nonePreview('没有已完成的写入型最新一轮。')
      })
    )
    expect(missingCheckpoint.filesButtonDisabled).toBe(true)
    expect(missingCheckpoint.filesReason).toMatch(/没有已完成的写入型最新一轮/)
  })

  it('空闲且 latest-turn 时文件按钮不 disabled；广告 rewind 时对话可勾选', () => {
    const view = presentTurnRewindCard(
      buildTurnRewindPreview({
        advertisedCommands: [{ name: 'rewind' }],
        busy: false,
        restorePreview: latestTurnPreview()
      })
    )
    expect(view.conversationCheckboxDisabled).toBe(false)
    expect(view.conversationChecked).toBe(true)
    expect(view.filesButtonDisabled).toBe(false)
    expect(view.filesChecked).toBe(true)
    expect(view.filesReason).toBeNull()
  })

  it('available 但用户取消对话时不得暴露可发送的 /rewind prompt', () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    const view = presentTurnRewindCard(preview, { conversation: false, files: true })
    expect(view.conversationChecked).toBe(false)
    expect(view.conversationPrompt).toBeNull()
    expect(view.conversationPrompt).not.toBe('/rewind')
    expect(resolveTurnRewindConversationPrompt(preview, { conversation: false, files: true })).toBe(
      null
    )
  })
})

describe('isTurnRewindBusy 与 Composer 对齐', () => {
  it('活动 Turn、停止中、modelBusy 都算忙碌', () => {
    expect(
      isTurnRewindBusy({ modelBusy: true, composerAction: 'send', hasActiveExecution: false })
    ).toBe(true)
    expect(
      isTurnRewindBusy({ modelBusy: false, composerAction: 'stop', hasActiveExecution: false })
    ).toBe(true)
    expect(
      isTurnRewindBusy({ modelBusy: false, composerAction: 'send', hasActiveExecution: true })
    ).toBe(true)
    expect(
      isTurnRewindBusy({ modelBusy: false, composerAction: 'send', hasActiveExecution: false })
    ).toBe(false)
  })
})

describe('冻结命令名', () => {
  it('导出的广告 name 不含前导斜杠，也没有未广告后门', () => {
    expect(GROK_REWIND_SLASH_COMMAND).toBe('rewind')
    expect(GROK_UNDO_SLASH_COMMAND).toBe('undo')
    expect(GROK_REWIND_SLASH_COMMAND.startsWith('/')).toBe(false)
    expect(TURN_REWIND_CONVERSATION_DESCRIPTION).toBe('只影响 Grok 上下文，不改磁盘')
  })
})

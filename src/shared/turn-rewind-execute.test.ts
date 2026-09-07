import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, type Mock } from 'vitest'
import type { LatestTurnRestorePreview, TaskChangeSet } from './git-review'
import {
  executeTurnRewind,
  type ExecuteTurnRewindRestoreResult,
  type ExecuteTurnRewindResult
} from './turn-rewind-execute'
import {
  buildTurnRewindPreview,
  resolveTurnRewindConversationPrompt,
  type TurnRewindPreview,
  type TurnRewindSelection
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

function advertisedRewind(
  restorePreview: LatestTurnRestorePreview | null = latestTurnPreview()
): TurnRewindPreview {
  return buildTurnRewindPreview({
    advertisedCommands: [{ name: 'rewind' }],
    busy: false,
    restorePreview
  })
}

async function run(
  preview: TurnRewindPreview,
  selection: TurnRewindSelection,
  overrides: {
    restoreLatestTurn?: () => Promise<ExecuteTurnRewindRestoreResult>
    startTurn?: (prompt: string) => Promise<void>
  } = {}
): Promise<{
  result: ExecuteTurnRewindResult
  restoreLatestTurn: Mock<() => Promise<ExecuteTurnRewindRestoreResult>>
  startTurn: Mock<(prompt: string) => Promise<void>>
}> {
  const restoreLatestTurn = vi.fn(
    overrides.restoreLatestTurn ??
      (async () => ({ ok: true, message: '已恢复上一轮文件，历史检查点仍保留。' }))
  )
  const startTurn = vi.fn(overrides.startTurn ?? (async () => undefined))
  const result = await executeTurnRewind({
    preview,
    selection,
    restoreLatestTurn,
    startTurn
  })
  return { result, restoreLatestTurn, startTurn }
}

describe('executeTurnRewind 源码约束', () => {
  it('执行路径不得硬编码 /rewind 或 /undo，必须走 resolveTurnRewindConversationPrompt', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'turn-rewind-execute.ts'),
      'utf8'
    )
    expect(source).toContain('clampTurnRewindSelection')
    expect(source).toContain('resolveTurnRewindConversationPrompt(preview')
    expect(source).not.toContain("'/rewind'")
    expect(source).not.toContain('"/rewind"')
    expect(source).not.toContain("'/undo'")
    expect(source).not.toContain('"/undo"')
    expect(source).not.toContain('allowUnadvertised')
    expect(source).not.toContain('git reset')
    expect(source).not.toContain('git checkout')
  })
})

describe('executeTurnRewind 勾选与顺序', () => {
  it('两行都未勾选时不调用 restore 或 startTurn', async () => {
    const preview = advertisedRewind()
    const { result, restoreLatestTurn, startTurn } = await run(preview, {
      conversation: false,
      files: false
    })
    expect(result.status).toBe('noop')
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('只勾文件时只 restore，不 startTurn', async () => {
    const preview = advertisedRewind()
    const { result, restoreLatestTurn, startTurn } = await run(preview, {
      conversation: false,
      files: true
    })
    expect(restoreLatestTurn).toHaveBeenCalledTimes(1)
    expect(startTurn).not.toHaveBeenCalled()
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.files?.ok).toBe(true)
      expect(result.conversationPrompt).toBeUndefined()
    }
  })

  it('只勾对话时不碰磁盘，startTurn 参数等于 resolve 返回值', async () => {
    const preview = advertisedRewind()
    const selection = { conversation: true, files: false }
    const { result, restoreLatestTurn, startTurn } = await run(preview, selection)
    const prompt = resolveTurnRewindConversationPrompt(preview, selection)
    expect(prompt).toBe('/rewind')
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(startTurn).toHaveBeenCalledWith(prompt)
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.conversationPrompt).toBe(prompt)
      expect(result.files).toBeUndefined()
    }
  })

  it('prompt 为 null 时只勾对话也不 startTurn', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: latestTurnPreview()
    })
    const { result, restoreLatestTurn, startTurn } = await run(preview, {
      conversation: true,
      files: false
    })
    expect(
      resolveTurnRewindConversationPrompt(preview, { conversation: true, files: false })
    ).toBeNull()
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
    expect(result.status).toBe('noop')
  })

  it('夹具广告 rewind 时两行都勾：先 restore 再 startTurn，参数等于 resolve', async () => {
    const preview = advertisedRewind()
    const selection = { conversation: true, files: true }
    const order: string[] = []
    const restoreLatestTurn = vi.fn(async () => {
      order.push('restore')
      return { ok: true, message: '已恢复上一轮文件，历史检查点仍保留。' }
    })
    const startTurn = vi.fn(async () => {
      order.push('startTurn')
    })
    const { result } = await run(preview, selection, { restoreLatestTurn, startTurn })
    const prompt = resolveTurnRewindConversationPrompt(preview, selection)
    expect(order).toEqual(['restore', 'startTurn'])
    expect(startTurn).toHaveBeenCalledWith(prompt)
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.files?.ok).toBe(true)
      expect(result.conversationPrompt).toBe(prompt)
    }
  })

  it('夹具只广告 undo 时 startTurn 参数是 /undo 而不是伪造 /rewind', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'undo' }],
      busy: false,
      restorePreview: latestTurnPreview()
    })
    const selection = { conversation: true, files: false }
    const { startTurn } = await run(preview, selection)
    const prompt = resolveTurnRewindConversationPrompt(preview, selection)
    expect(prompt).toBe('/undo')
    expect(startTurn).toHaveBeenCalledWith(prompt)
    expect(startTurn).not.toHaveBeenCalledWith('/rewind')
  })
})

describe('executeTurnRewind 失败与跳过', () => {
  it('restore ok !== true 时不 startTurn，返回文件失败且不回滚', async () => {
    const preview = advertisedRewind()
    const restoreLatestTurn = vi.fn(async () => ({
      ok: false,
      message: '待删除路径在写回后已漂移，已停止删除。',
      appliedPaths: ['README.md']
    }))
    const { result, startTurn } = await run(
      preview,
      { conversation: true, files: true },
      {
        restoreLatestTurn
      }
    )
    expect(restoreLatestTurn).toHaveBeenCalledTimes(1)
    expect(startTurn).not.toHaveBeenCalled()
    expect(result.status).toBe('files-failed')
    if (result.status === 'files-failed') {
      expect(result.error).toMatch(/漂移/)
      expect(result.files?.appliedPaths).toEqual(['README.md'])
    }
  })

  it('restore 抛错时不 startTurn，已改磁盘不回滚', async () => {
    const preview = advertisedRewind()
    const restoreLatestTurn = vi.fn(async () => {
      throw new Error('恢复未完成。')
    })
    const { result, startTurn } = await run(
      preview,
      { conversation: true, files: true },
      {
        restoreLatestTurn
      }
    )
    expect(startTurn).not.toHaveBeenCalled()
    expect(result.status).toBe('files-failed')
    if (result.status === 'files-failed') {
      expect(result.error).toBe('恢复未完成。')
    }
  })

  it('startTurn 失败不回滚文件，结果里保留已恢复文件', async () => {
    const preview = advertisedRewind()
    const restoreLatestTurn = vi.fn(async () => ({
      ok: true,
      message: '已恢复上一轮文件，历史检查点仍保留。',
      appliedPaths: ['README.md']
    }))
    const startTurn = vi.fn(async () => {
      throw new Error('Runtime 暂时不可用。')
    })
    const { result } = await run(
      preview,
      { conversation: true, files: true },
      {
        restoreLatestTurn,
        startTurn
      }
    )
    expect(restoreLatestTurn).toHaveBeenCalledTimes(1)
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(result.status).toBe('conversation-failed')
    if (result.status === 'conversation-failed') {
      expect(result.error).toBe('Runtime 暂时不可用。')
      expect(result.files?.ok).toBe(true)
      expect(result.files?.appliedPaths).toEqual(['README.md'])
      expect(result.conversationPrompt).toBe(
        resolveTurnRewindConversationPrompt(preview, { conversation: true, files: true })
      )
    }
  })

  it('漂移时 clamp 掉文件勾选：不 restore；对话 available 且勾选则可只发对话', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: false,
      restorePreview: nonePreview('执行环境已漂移，不能自动恢复上一轮文件。')
    })
    const selection = { conversation: true, files: true }
    const { result, restoreLatestTurn, startTurn } = await run(preview, selection)
    expect(preview.files.blocked).toBe(true)
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledTimes(1)
    expect(startTurn).toHaveBeenCalledWith(resolveTurnRewindConversationPrompt(preview, selection))
    expect(result.status).toBe('completed')
  })

  it('无检查点时不改盘；无广告则 startTurn 次数为 0', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: nonePreview('没有已完成的写入型最新一轮。')
    })
    const { result, restoreLatestTurn, startTurn } = await run(preview, {
      conversation: true,
      files: true
    })
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledTimes(0)
    expect(result.status).toBe('noop')
  })

  it('干净 latest-turn 只勾文件时 restore 被调用且 ok', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: latestTurnPreview()
    })
    const restoreLatestTurn = vi.fn(async () => ({
      ok: true,
      message: '已恢复上一轮文件，历史检查点仍保留。'
    }))
    const { result, startTurn } = await run(
      preview,
      { conversation: true, files: true },
      { restoreLatestTurn }
    )
    expect(restoreLatestTurn).toHaveBeenCalledTimes(1)
    expect(startTurn).toHaveBeenCalledTimes(0)
    expect(result.status).toBe('completed')
    if (result.status === 'completed') {
      expect(result.files?.ok).toBe(true)
    }
  })

  it('command-missing 时 startTurn 调用次数为 0', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: compactOnly,
      busy: false,
      restorePreview: latestTurnPreview()
    })
    const { startTurn } = await run(preview, { conversation: true, files: false })
    expect(startTurn).toHaveBeenCalledTimes(0)
  })

  it('busy 时即使广告 rewind 也不发送', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: true,
      restorePreview: latestTurnPreview()
    })
    const { result, restoreLatestTurn, startTurn } = await run(preview, {
      conversation: true,
      files: true
    })
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledTimes(0)
    expect(result.status).toBe('noop')
  })

  it('文件未预览却勾了文件：不 restore、不 startTurn', async () => {
    const preview = buildTurnRewindPreview({
      advertisedCommands: [{ name: 'rewind' }],
      busy: false,
      restorePreview: null,
      changeSetRevertible: latestTurnRevertible()
    })
    expect(preview.files.blocked).toBe(false)
    expect(preview.files.preview).toBeNull()
    const { result, restoreLatestTurn, startTurn } = await run(preview, {
      conversation: true,
      files: true
    })
    expect(restoreLatestTurn).not.toHaveBeenCalled()
    expect(startTurn).toHaveBeenCalledTimes(0)
    expect(result.status).toBe('files-failed')
  })
})

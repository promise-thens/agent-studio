import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeStatus } from '../../shared/agent'
import {
  canSendRuntimePrompt,
  chooseWorkspaceWhenIdle,
  createAsyncSingleFlight
} from './runtime-session-actions'

const readyStatus: AgentRuntimeStatus = {
  runtimeId: 'grok',
  state: 'ready',
  message: '已连接',
  workspace: '/tmp/project',
  runtimeSessionId: 'session-old'
}

describe('Runtime 会话操作', () => {
  it('同一时刻只执行一次异步操作，并在完成后释放门禁', async () => {
    let release!: () => void
    const pendingStates: boolean[] = []
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const action = vi.fn(async () => blocked)
    const runSingleFlight = createAsyncSingleFlight((pending) => pendingStates.push(pending))

    const first = runSingleFlight(action)
    const duplicate = runSingleFlight(action)

    expect(action).toHaveBeenCalledTimes(1)
    await expect(duplicate).resolves.toBe(false)
    expect(pendingStates).toEqual([true])

    release()
    await expect(first).resolves.toBe(true)
    await expect(runSingleFlight(action)).resolves.toBe(true)
    expect(action).toHaveBeenCalledTimes(2)
    expect(pendingStates).toEqual([true, false, true, false])
  })

  it('初始 busy 时不打开目录选择器', async () => {
    const chooseWorkspace = vi.fn(async () => '/tmp/other-project')

    await expect(chooseWorkspaceWhenIdle(() => true, chooseWorkspace)).resolves.toBeNull()
    expect(chooseWorkspace).not.toHaveBeenCalled()
  })

  it('目录选择等待期间转为 busy 时丢弃返回结果', async () => {
    let busy = false
    let resolveWorkspace!: (workspace: string | null) => void
    const pickerResult = new Promise<string | null>((resolve) => {
      resolveWorkspace = resolve
    })
    const chooseWorkspace = vi.fn(() => pickerResult)

    const selection = chooseWorkspaceWhenIdle(() => busy, chooseWorkspace)
    expect(chooseWorkspace).toHaveBeenCalledTimes(1)

    busy = true
    resolveWorkspace('/tmp/other-project')

    await expect(selection).resolves.toBeNull()
  })

  it('发送判断同时校验文本、ready 状态和 Prompt 能力', () => {
    expect(canSendRuntimePrompt('执行测试', readyStatus, true)).toBe(true)
    expect(canSendRuntimePrompt('执行测试', readyStatus, false)).toBe(false)
    expect(canSendRuntimePrompt('   ', readyStatus, true)).toBe(false)
    expect(canSendRuntimePrompt('执行测试', { ...readyStatus, state: 'busy' }, true)).toBe(false)
  })
})

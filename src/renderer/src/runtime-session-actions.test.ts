import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeStatus } from '../../shared/agent'
import { canSendRuntimePrompt, rebuildRuntimeSession } from './runtime-session-actions'

const readyStatus: AgentRuntimeStatus = {
  runtimeId: 'grok',
  state: 'ready',
  message: '已连接',
  workspace: '/tmp/project',
  runtimeSessionId: 'session-old'
}

describe('Runtime 会话操作', () => {
  it('已连接时先断开再连接，并只返回带新 sessionId 的 ready 状态', async () => {
    const calls: string[] = []
    const nextStatus: AgentRuntimeStatus = {
      ...readyStatus,
      runtimeSessionId: 'session-new'
    }

    const result = await rebuildRuntimeSession({
      status: readyStatus,
      workspace: '/tmp/project',
      chooseWorkspace: vi.fn(),
      disconnect: vi.fn(async (): Promise<AgentRuntimeStatus> => {
        calls.push('disconnect')
        return { runtimeId: 'grok', state: 'idle', message: '已断开' }
      }),
      connect: vi.fn(async () => {
        calls.push('connect')
        return nextStatus
      })
    })

    expect(calls).toEqual(['disconnect', 'connect'])
    expect(result).toEqual({ workspace: '/tmp/project', status: nextStatus })
  })

  it('连接失败或缺少 Runtime sessionId 时拒绝确认新对话', async () => {
    await expect(
      rebuildRuntimeSession({
        status: { runtimeId: 'grok', state: 'idle', message: '未连接' },
        workspace: '/tmp/project',
        chooseWorkspace: vi.fn(),
        disconnect: vi.fn(),
        connect: vi.fn(async (): Promise<AgentRuntimeStatus> => ({
          runtimeId: 'grok',
          state: 'error',
          message: '连接失败'
        }))
      })
    ).rejects.toThrow('旧对话记录已保留')
  })

  it('目录选择取消时不连接，也不生成本地伪会话', async () => {
    const connect = vi.fn()
    const result = await rebuildRuntimeSession({
      status: { runtimeId: 'grok', state: 'idle', message: '未连接' },
      workspace: '',
      chooseWorkspace: vi.fn(async () => null),
      disconnect: vi.fn(),
      connect
    })

    expect(result).toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })

  it('发送判断同时校验文本、ready 状态和 Prompt 能力', () => {
    expect(canSendRuntimePrompt('执行测试', readyStatus, true)).toBe(true)
    expect(canSendRuntimePrompt('执行测试', readyStatus, false)).toBe(false)
    expect(canSendRuntimePrompt('   ', readyStatus, true)).toBe(false)
    expect(canSendRuntimePrompt('执行测试', { ...readyStatus, state: 'busy' }, true)).toBe(false)
  })
})

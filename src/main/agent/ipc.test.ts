import { describe, expect, it, vi } from 'vitest'
import type {
  AgentRuntimeStatus,
  AgentTaskRuntimeState,
  AgentTurnExecutionResult
} from '../../shared/agent'
import { AGENT_INVOKE_CHANNELS } from '../../shared/agent-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcHandler } from '../ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { AgentServiceError } from './agent-service'
import { registerAgentIpcHandlers, type AgentIpcRuntime } from './ipc'

const event = {} as TrustedIpcInvokeEvent

function createFixture(initialStatus?: AgentRuntimeStatus): {
  handlers: Map<string, DesktopIpcHandler>
  runtime: AgentIpcRuntime
  status: AgentRuntimeStatus
  assertTrustedSender: ReturnType<typeof vi.fn>
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<DesktopIpcResult<T>>
} {
  const handlers = new Map<string, DesktopIpcHandler>()
  const status =
    initialStatus ??
    ({
      runtimeId: 'grok',
      state: 'ready',
      message: '已连接',
      workspace: '/tmp/project',
      runtimeSessionId: 'session-1'
    } satisfies AgentRuntimeStatus)
  const task: AgentTaskRuntimeState = {
    taskId: 'task-1',
    runtimeId: 'grok',
    workspace: '/tmp/project',
    state: 'pending',
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z'
  }
  const turn: AgentTurnExecutionResult = {
    taskId: 'task-1',
    turnId: 'turn-1',
    outcome: 'completed',
    task: { ...task, state: 'completed', lastTurnId: 'turn-1' }
  }
  const runtime: AgentIpcRuntime = {
    getStatus: vi.fn(() => status),
    connect: vi.fn(async () => status),
    disconnect: vi.fn(async (): Promise<AgentRuntimeStatus> => ({
      runtimeId: 'grok',
      state: 'idle',
      message: '已断开'
    })),
    createTask: vi.fn(async () => task),
    startTurn: vi.fn(async () => turn),
    cancelTurn: vi.fn(async () => undefined),
    getTaskRuntimeState: vi.fn(() => task),
    respondPermission: vi.fn()
  }
  const assertTrustedSender = vi.fn()
  registerAgentIpcHandlers({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    },
    assertTrustedSender,
    getAgent: () => runtime,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })

  return {
    handlers,
    runtime,
    status,
    assertTrustedSender,
    invoke: async <T>(channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`缺少 Handler: ${channel}`)
      return (await handler(event, ...args)) as DesktopIpcResult<T>
    }
  }
}

describe('Agent IPC Handler', () => {
  it('只注册固定的八个 Agent invoke channel', () => {
    const fixture = createFixture()
    expect([...fixture.handlers.keys()]).toEqual(Object.values(AGENT_INVOKE_CHANNELS))
  })

  it('来源拒绝发生在参数读取、目录访问和 Runtime 调用之前', async () => {
    const fixture = createFixture()
    fixture.assertTrustedSender.mockImplementation(() => {
      throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
    })

    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.connect, {
      workspace: '/tmp/project'
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden', message: '拒绝此 IPC 调用。' }
    })
    expect(fixture.runtime.connect).not.toHaveBeenCalled()
  })

  it('连接只接收 projectId 并委托给 Runtime 服务', async () => {
    const fixture = createFixture({ runtimeId: 'grok', state: 'idle', message: '未连接' })
    const projectId = 'project-1'

    const result = await fixture.invoke<AgentRuntimeStatus>(AGENT_INVOKE_CHANNELS.connect, {
      projectId
    })

    expect(result.ok).toBe(true)
    expect(fixture.runtime.connect).toHaveBeenCalledWith(projectId)
  })

  it.each(['connecting', 'busy'] as const)('在 %s 状态拒绝连接', async (state) => {
    const fixture = createFixture({ runtimeId: 'grok', state, message: state })
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.connect, {
      projectId: 'project-1'
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(fixture.runtime.connect).not.toHaveBeenCalled()
  })

  it.each(['idle', 'error', 'ready'] as const)('在 %s 状态允许连接委托', async (state) => {
    const fixture = createFixture({ runtimeId: 'grok', state, message: state })
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.connect, {
      projectId: 'project-1'
    })

    expect(result.ok).toBe(true)
    expect(fixture.runtime.connect).toHaveBeenCalledOnce()
  })

  it('创建 Task 只接收 projectId，公共响应不包含 Runtime session 引用', async () => {
    const fixture = createFixture()
    const result = await fixture.invoke<AgentTaskRuntimeState>(AGENT_INVOKE_CHANNELS.createTask, {
      projectId: 'project-1'
    })

    expect(result).toMatchObject({ ok: true, value: { taskId: 'task-1' } })
    expect(fixture.runtime.createTask).toHaveBeenCalledWith('project-1')
    expect(JSON.stringify(result)).not.toContain('runtimeSessionId')
  })

  it('Turn 只在 ready 状态委托，并保留 Task ID 与 Prompt 首尾内容', async () => {
    const fixture = createFixture()
    const prompt = '  请执行测试  '

    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
      taskId: 'task-1',
      prompt
    })

    expect(result).toMatchObject({ ok: true, value: { taskId: 'task-1', turnId: 'turn-1' } })
    expect(fixture.runtime.startTurn).toHaveBeenCalledWith('task-1', prompt)
  })

  it('接受 null prototype 的普通请求对象', async () => {
    const fixture = createFixture()
    const request = Object.create(null) as { taskId: string; prompt: string }
    request.taskId = 'task-1'
    request.prompt = '执行测试'

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, request)).toMatchObject({
      ok: true,
      value: { taskId: 'task-1' }
    })
  })

  it('Runtime 返回有限 Turn 结果时原样封装成功响应', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.runtime.startTurn).mockResolvedValue({
      taskId: 'task-1',
      turnId: 'turn-failed',
      outcome: 'failed',
      task: {
        taskId: 'task-1',
        runtimeId: 'grok',
        workspace: '/tmp/project',
        state: 'failed',
        lastTurnId: 'turn-failed',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:01.000Z'
      }
    })

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
        taskId: 'task-1',
        prompt: '执行测试'
      })
    ).toMatchObject({ ok: true, value: { outcome: 'failed' } })
  })

  it('无返回值操作统一返回 null，并保留权限幂等委托', async () => {
    const fixture = createFixture()

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.cancelTurn, { taskId: 'task-1' })).toEqual({
      ok: true,
      value: null
    })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId: 'task-1' })
    ).toMatchObject({ ok: true, value: { taskId: 'task-1' } })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.respondPermission, {
        requestId: 'request-1',
        optionId: 'allow-once'
      })
    ).toEqual({ ok: true, value: null })
    expect(fixture.runtime.respondPermission).toHaveBeenCalledWith('request-1', 'allow-once')
  })

  it.each([
    ['额外参数', AGENT_INVOKE_CHANNELS.getStatus, [{}], 'invalid-input'],
    ['数组请求', AGENT_INVOKE_CHANNELS.startTurn, [['执行测试']], 'invalid-input'],
    ['Date 请求', AGENT_INVOKE_CHANNELS.startTurn, [new Date()], 'invalid-input'],
    ['Map 请求', AGENT_INVOKE_CHANNELS.startTurn, [new Map()], 'invalid-input'],
    [
      '伪造 Runtime session 字段',
      AGENT_INVOKE_CHANNELS.startTurn,
      [{ prompt: '执行测试', taskId: 'task-1', runtimeSessionId: 'fake-session' }],
      'invalid-input'
    ],
    [
      '空白 Prompt',
      AGENT_INVOKE_CHANNELS.startTurn,
      [{ taskId: 'task-1', prompt: '   ' }],
      'invalid-input'
    ],
    [
      'NUL Prompt',
      AGENT_INVOKE_CHANNELS.startTurn,
      [{ taskId: 'task-1', prompt: '执行\0测试' }],
      'invalid-input'
    ],
    [
      '空白 Task ID',
      AGENT_INVOKE_CHANNELS.startTurn,
      [{ taskId: '   ', prompt: '执行测试' }],
      'invalid-input'
    ],
    ['NUL Task ID', AGENT_INVOKE_CHANNELS.cancelTurn, [{ taskId: 'task\0-1' }], 'invalid-input'],
    [
      '伪造 workspace 字段',
      AGENT_INVOKE_CHANNELS.connect,
      [{ workspace: '/tmp/project' }],
      'invalid-input'
    ],
    [
      '创建 Task 伪造 workspace 字段',
      AGENT_INVOKE_CHANNELS.createTask,
      [{ workspace: '/tmp/project' }],
      'invalid-input'
    ]
  ] as const)('拒绝%s', async (_name, channel, args, code) => {
    const fixture = createFixture()
    const result = await fixture.invoke(channel, ...args)
    expect(result).toMatchObject({ ok: false, error: { code } })
  })

  it('按 UTF-8 字节接受临界 Prompt，并拒绝超过一个字节的内容', async () => {
    const fixture = createFixture()
    const exactAscii = 'a'.repeat(64 * 1024)
    const exactEmoji = '😀'.repeat((64 * 1024) / 4)

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
        taskId: 'task-1',
        prompt: exactAscii
      })
    ).toMatchObject({ ok: true })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
        taskId: 'task-1',
        prompt: exactEmoji
      })
    ).toMatchObject({ ok: true })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
        taskId: 'task-1',
        prompt: `${exactAscii}a`
      })
    ).toMatchObject({ ok: false, error: { code: 'payload-too-large' } })
  })

  it('整体请求超过 512 KiB 时在 Runtime 副作用前拒绝', async () => {
    const fixture = createFixture()
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.respondPermission, {
      requestId: 'request-1',
      optionId: 'a'.repeat(512 * 1024)
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'payload-too-large' } })
    expect(fixture.runtime.respondPermission).not.toHaveBeenCalled()
  })

  it('Runtime 未初始化时返回稳定错误码', async () => {
    const handlers = new Map<string, DesktopIpcHandler>()
    registerAgentIpcHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      assertTrustedSender: vi.fn(),
      getAgent: () => null,
      sanitizeError: String
    })

    const result = (await handlers.get(AGENT_INVOKE_CHANNELS.getStatus)?.(
      event
    )) as DesktopIpcResult<unknown>
    expect(result).toMatchObject({ ok: false, error: { code: 'runtime-unavailable' } })
  })

  it('AgentService 有限错误码跨 IPC 保持稳定', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.runtime.getTaskRuntimeState).mockImplementation(() => {
      throw new AgentServiceError('task-not-found', '未找到指定 Task。')
    })

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId: 'missing-task' })
    ).toEqual({
      ok: false,
      error: { code: 'task-not-found', message: '未找到指定 Task。' }
    })
  })

  it('未知异常只返回脱敏后的 operation-failed', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.runtime.disconnect).mockRejectedValue(
      new Error('Bearer fake-secret https://internal.example /Users/test/private')
    )

    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.disconnect)

    expect(result).toMatchObject({ ok: false, error: { code: 'operation-failed' } })
    if (!result.ok) {
      expect(result.error.message).not.toContain('internal.example')
      expect(result.error.message).not.toContain('/Users/test')
    }
  })
})

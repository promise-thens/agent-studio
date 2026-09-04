import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentRuntimeStatus,
  AgentTaskRuntimeState,
  AgentTurnExecutionResult
} from '../../shared/agent'
import { AGENT_INVOKE_CHANNELS } from '../../shared/agent-ipc'
import {
  GROK_TAKEOVER_CONTROL_PROMPT,
  PUBLIC_TAKEOVER_CONTROL_PROMPT_BLOCKED_MESSAGE
} from '../../shared/task-takeover'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcHandler } from '../ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { AgentServiceError } from './agent-service'
import { registerAgentIpcHandlers, type AgentIpcRuntime } from './ipc'

const event = {} as TrustedIpcInvokeEvent
const validPermissionResponse = {
  approvalId: 'approval-1',
  taskId: 'task-1',
  turnId: 'turn-1',
  decision: 'deny'
} as const

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
    updatedAt: '2026-08-11T00:00:00.000Z',
    takeoverEnabled: false,
    permissionPromptStyle: 'assist',
    takeoverApplied: false
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
    enterTask: vi.fn(async () => ({
      taskId: 'task-1',
      historyReady: true,
      restore: 'ready' as const,
      method: 'resume' as const,
      verification: 'declared' as const
    })),
    startTurn: vi.fn(async () => turn),
    cancelTurn: vi.fn(async () => undefined),
    getTaskRuntimeState: vi.fn(() => task),
    getAvailableCommands: vi.fn(() => ({
      taskId: 'task-1',
      revision: 0,
      commands: []
    })),
    respondPermission: vi.fn(async () => undefined),
    respondQuestion: vi.fn(),
    setPermissionMode: vi.fn(async () => ({
      task,
      decision: { kind: 'noop' as const }
    }))
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
  it('只注册固定的 Agent invoke channel', () => {
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

  it('进入对话只接收 taskId，返回恢复结论且不包含 Runtime session 引用', async () => {
    const fixture = createFixture()
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.enterTask, { taskId: 'task-1' })

    expect(result).toMatchObject({
      ok: true,
      value: { taskId: 'task-1', historyReady: true, restore: 'ready', method: 'resume' }
    })
    expect(fixture.runtime.enterTask).toHaveBeenCalledWith('task-1')
    expect(JSON.stringify(result)).not.toContain('runtimeSessionId')
  })

  it('公开 startTurn 拒绝字面量 /always-approve，不得调用 Runtime', async () => {
    const fixture = createFixture()
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
        taskId: 'task-1',
        prompt: GROK_TAKEOVER_CONTROL_PROMPT
      })
    ).toEqual({
      ok: false,
      error: {
        code: 'invalid-input',
        message: PUBLIC_TAKEOVER_CONTROL_PROMPT_BLOCKED_MESSAGE
      }
    })
    expect(fixture.runtime.startTurn).not.toHaveBeenCalled()
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

  it('允许空白 Prompt 搭配 attachmentIds 发送', async () => {
    const fixture = createFixture()
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
      taskId: 'task-1',
      prompt: '   ',
      attachmentIds: ['att-1']
    })
    expect(result).toMatchObject({ ok: true })
    expect(fixture.runtime.startTurn).toHaveBeenCalledWith('task-1', '   ', ['att-1'])
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
        updatedAt: '2026-08-11T00:00:01.000Z',
        takeoverEnabled: false,
        permissionPromptStyle: 'assist',
        takeoverApplied: false
      }
    })

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.startTurn, {
        taskId: 'task-1',
        prompt: '执行测试'
      })
    ).toMatchObject({ ok: true, value: { outcome: 'failed' } })
  })

  it('无返回值操作统一返回 null', async () => {
    const fixture = createFixture()

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.cancelTurn, {
        executionId: 'execution-1',
        taskId: 'task-1',
        turnId: 'turn-1'
      })
    ).toEqual({
      ok: true,
      value: null
    })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.getTaskRuntimeState, { taskId: 'task-1' })
    ).toMatchObject({ ok: true, value: { taskId: 'task-1' } })
  })

  it.each(['allow-once', 'allow-task', 'deny'] as const)(
    '权限响应接受 %s 产品级决策并完整委托给 Service',
    async (decision) => {
      const fixture = createFixture()
      const request = { ...validPermissionResponse, decision }

      expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.respondPermission, request)).toEqual({
        ok: true,
        value: null
      })
      expect(fixture.runtime.respondPermission).toHaveBeenCalledWith(request)
    }
  )

  it('语法合法但不匹配的 Task/Turn 身份交给 Service 幂等处理', async () => {
    const fixture = createFixture()
    const request = {
      ...validPermissionResponse,
      taskId: 'other-task',
      turnId: 'other-turn'
    }

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.respondPermission, request)).toEqual({
      ok: true,
      value: null
    })
    expect(fixture.runtime.respondPermission).toHaveBeenCalledWith(request)
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
      '空白 Prompt 且无附件',
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
    ],
    [
      '权限响应携带 Runtime optionId',
      AGENT_INVOKE_CHANNELS.respondPermission,
      [{ ...validPermissionResponse, optionId: 'allow-once' }],
      'invalid-input'
    ],
    [
      '权限响应携带额外字段',
      AGENT_INVOKE_CHANNELS.respondPermission,
      [{ ...validPermissionResponse, runtimeSessionId: 'fake-session' }],
      'invalid-input'
    ],
    [
      '非法权限决策',
      AGENT_INVOKE_CHANNELS.respondPermission,
      [{ ...validPermissionResponse, decision: 'allow-always' }],
      'invalid-input'
    ],
    [
      '装箱字符串权限决策',
      AGENT_INVOKE_CHANNELS.respondPermission,
      [{ ...validPermissionResponse, decision: new String('deny') }],
      'invalid-input'
    ]
  ] as const)('拒绝%s', async (_name, channel, args, code) => {
    const fixture = createFixture()
    const result = await fixture.invoke(channel, ...args)
    expect(result).toMatchObject({ ok: false, error: { code } })
  })

  it.each([
    ['approvalId 类型错误', { ...validPermissionResponse, approvalId: 1 }, 'invalid-input'],
    ['taskId 类型错误', { ...validPermissionResponse, taskId: 1 }, 'invalid-input'],
    ['turnId 类型错误', { ...validPermissionResponse, turnId: 1 }, 'invalid-input'],
    ['approvalId 为空', { ...validPermissionResponse, approvalId: '   ' }, 'invalid-input'],
    ['taskId 为空', { ...validPermissionResponse, taskId: '   ' }, 'invalid-input'],
    ['turnId 为空', { ...validPermissionResponse, turnId: '   ' }, 'invalid-input'],
    [
      'approvalId 包含 NUL',
      { ...validPermissionResponse, approvalId: 'approval\0-1' },
      'invalid-input'
    ],
    ['taskId 包含 NUL', { ...validPermissionResponse, taskId: 'task\0-1' }, 'invalid-input'],
    ['turnId 包含 NUL', { ...validPermissionResponse, turnId: 'turn\0-1' }, 'invalid-input'],
    [
      'approvalId 超限',
      { ...validPermissionResponse, approvalId: 'a'.repeat(4 * 1024 + 1) },
      'payload-too-large'
    ],
    [
      'taskId 超限',
      { ...validPermissionResponse, taskId: 'a'.repeat(4 * 1024 + 1) },
      'payload-too-large'
    ],
    [
      'turnId 超限',
      { ...validPermissionResponse, turnId: 'a'.repeat(4 * 1024 + 1) },
      'payload-too-large'
    ]
  ] as const)('拒绝%s的权限身份', async (_name, request, code) => {
    const fixture = createFixture()

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.respondPermission, request)).toMatchObject({
      ok: false,
      error: { code }
    })
    expect(fixture.runtime.respondPermission).not.toHaveBeenCalled()
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
      ...validPermissionResponse,
      approvalId: 'a'.repeat(512 * 1024)
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'payload-too-large' } })
    expect(fixture.runtime.respondPermission).not.toHaveBeenCalled()
  })

  it('问答提交必须调用 Runtime.respondQuestion，accept 不得静默丢弃', async () => {
    const fixture = createFixture()
    const request = {
      questionId: 'question-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      response: { action: 'accept' as const, answers: { q1: '在家休息' } }
    }

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.respondQuestion, request)).toEqual({
      ok: true,
      value: null
    })
    expect(fixture.runtime.respondQuestion).toHaveBeenCalledWith(request)
  })

  it('Runtime 未实现 respondQuestion 时必须失败，不能假装提交成功', async () => {
    const fixture = createFixture()
    ;(fixture.runtime as { respondQuestion?: AgentIpcRuntime['respondQuestion'] }).respondQuestion =
      undefined

    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.respondQuestion, {
      questionId: 'question-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      response: { action: 'accept', answers: { q1: '在家休息' } }
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'operation-failed', message: '当前 Runtime 不支持问答提交。' }
    })
  })

  it('生产 IPC 门面必须转发 respondQuestion，避免提交成功但 Adapter 无感', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8'
    )
    expect(source).toMatch(
      /respondQuestion:\s*\(request\)\s*=>\s*service\.respondQuestion\(request\)/
    )
    expect(source).not.toContain('respondQuestion?.(request)')
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

  it('命令快照读取委托 Service，并原样返回已投影快照', async () => {
    const fixture = createFixture()
    const snapshot = {
      taskId: 'task-1',
      revision: 2,
      commands: [{ name: 'compact', description: '压缩上下文', inputHint: '可选主题' }]
    }
    vi.mocked(fixture.runtime.getAvailableCommands).mockReturnValue(snapshot)

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.getAvailableCommands, { taskId: 'task-1' })
    ).toEqual({ ok: true, value: snapshot })
    expect(fixture.runtime.getAvailableCommands).toHaveBeenCalledWith('task-1')
  })

  it('命令快照未知 Task 对外映射为 invalid-input，不泄露 task-not-found', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.runtime.getAvailableCommands).mockImplementation(() => {
      throw new AgentServiceError('task-not-found', '未找到指定 Task。')
    })

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.getAvailableCommands, { taskId: 'missing-task' })
    ).toEqual({
      ok: false,
      error: { code: 'invalid-input', message: '未找到指定 Task。' }
    })
  })

  it('命令快照请求参数畸形时在 Service 调用前拒绝', async () => {
    const fixture = createFixture()

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.getAvailableCommands)).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' }
    })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.getAvailableCommands, { taskId: '' })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.getAvailableCommands, { taskId: 'task\0-1' })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.runtime.getAvailableCommands).not.toHaveBeenCalled()
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

  it('未 confirmed 的 takeover 必须拒绝，且不得调用 Runtime', async () => {
    const fixture = createFixture()

    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.setPermissionMode, {
        taskId: 'task-1',
        mode: 'takeover'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.setPermissionMode, {
        taskId: 'task-1',
        mode: 'takeover',
        confirmed: false
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.runtime.setPermissionMode).not.toHaveBeenCalled()
  })

  it('普通 set assist 成功委托 Service', async () => {
    const fixture = createFixture()
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.setPermissionMode, {
      taskId: 'task-1',
      mode: 'assist'
    })
    expect(result).toMatchObject({
      ok: true,
      value: { task: { taskId: 'task-1' }, decision: { kind: 'noop' } }
    })
    expect(fixture.runtime.setPermissionMode).toHaveBeenCalledWith({
      taskId: 'task-1',
      mode: 'assist'
    })
  })

  it('活动 Turn 时切换批准模式映射为 invalid-state', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.runtime.setPermissionMode).mockRejectedValue(
      new AgentServiceError('invalid-state', '任务执行中不能切换批准模式。')
    )
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.setPermissionMode, {
        taskId: 'task-1',
        mode: 'ask'
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
  })

  it('confirmed 的 takeover 才委托 Service', async () => {
    const fixture = createFixture()
    await fixture.invoke(AGENT_INVOKE_CHANNELS.setPermissionMode, {
      taskId: 'task-1',
      mode: 'takeover',
      confirmed: true
    })
    expect(fixture.runtime.setPermissionMode).toHaveBeenCalledWith({
      taskId: 'task-1',
      mode: 'takeover',
      confirmed: true
    })
  })
})

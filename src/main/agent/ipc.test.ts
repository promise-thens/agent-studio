import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeStatus } from '../../shared/agent'
import { AGENT_INVOKE_CHANNELS } from '../../shared/agent-ipc'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import type { DesktopIpcHandler } from '../ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { registerAgentIpcHandlers, type AgentIpcRuntime } from './ipc'

const event = {} as TrustedIpcInvokeEvent

function createFixture(initialStatus?: AgentRuntimeStatus): {
  handlers: Map<string, DesktopIpcHandler>
  runtime: AgentIpcRuntime
  status: AgentRuntimeStatus
  assertTrustedSender: ReturnType<typeof vi.fn>
  statPath: ReturnType<typeof vi.fn>
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
  const runtime: AgentIpcRuntime = {
    getStatus: vi.fn(() => status),
    connect: vi.fn(async () => status),
    disconnect: vi.fn(async (): Promise<AgentRuntimeStatus> => ({
      runtimeId: 'grok',
      state: 'idle',
      message: '已断开'
    })),
    sendPrompt: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    respondPermission: vi.fn()
  }
  const assertTrustedSender = vi.fn()
  const statPath = vi.fn(async () => ({ isDirectory: () => true }))

  registerAgentIpcHandlers({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler)
      }
    },
    assertTrustedSender,
    getAgent: () => runtime,
    statPath,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })

  return {
    handlers,
    runtime,
    status,
    assertTrustedSender,
    statPath,
    invoke: async <T>(channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`缺少 Handler: ${channel}`)
      return (await handler(event, ...args)) as DesktopIpcResult<T>
    }
  }
}

describe('Agent IPC Handler', () => {
  it('只注册固定的六个 Agent invoke channel', () => {
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
    expect(fixture.statPath).not.toHaveBeenCalled()
    expect(fixture.runtime.connect).not.toHaveBeenCalled()
  })

  it('连接前验证目录并把原始 workspace 委托给 Runtime', async () => {
    const fixture = createFixture({ runtimeId: 'grok', state: 'idle', message: '未连接' })
    const workspace = '/tmp/project with spaces '

    const result = await fixture.invoke<AgentRuntimeStatus>(AGENT_INVOKE_CHANNELS.connect, {
      workspace
    })

    expect(result.ok).toBe(true)
    expect(fixture.statPath).toHaveBeenCalledWith(workspace)
    expect(fixture.runtime.connect).toHaveBeenCalledWith(workspace)
  })

  it.each(['connecting', 'busy'] as const)('在 %s 状态拒绝连接', async (state) => {
    const fixture = createFixture({ runtimeId: 'grok', state, message: state })
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.connect, {
      workspace: '/tmp/project'
    })

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-state' } })
    expect(fixture.runtime.connect).not.toHaveBeenCalled()
  })

  it.each(['idle', 'error', 'ready'] as const)('在 %s 状态允许连接委托', async (state) => {
    const fixture = createFixture({ runtimeId: 'grok', state, message: state })
    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.connect, {
      workspace: '/tmp/project'
    })

    expect(result.ok).toBe(true)
    expect(fixture.runtime.connect).toHaveBeenCalledOnce()
  })

  it('Prompt 只在 ready 状态委托，并保留原始首尾内容', async () => {
    const fixture = createFixture()
    const prompt = '  请执行测试  '

    const result = await fixture.invoke(AGENT_INVOKE_CHANNELS.sendPrompt, { prompt })

    expect(result).toEqual({ ok: true, value: null })
    expect(fixture.runtime.sendPrompt).toHaveBeenCalledWith(prompt)
  })

  it('接受 null prototype 的普通请求对象', async () => {
    const fixture = createFixture()
    const request = Object.create(null) as { prompt: string }
    request.prompt = '执行测试'

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.sendPrompt, request)).toEqual({
      ok: true,
      value: null
    })
  })

  it('Runtime 执行期 Prompt 失败由 Bridge 自行收束时仍返回成功委托', async () => {
    const fixture = createFixture()
    vi.mocked(fixture.runtime.sendPrompt).mockResolvedValue(undefined)

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.sendPrompt, { prompt: '执行测试' })).toEqual({
      ok: true,
      value: null
    })
  })

  it('无返回值操作统一返回 null，并保留权限幂等委托', async () => {
    const fixture = createFixture()

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.cancel)).toEqual({ ok: true, value: null })
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
    ['数组请求', AGENT_INVOKE_CHANNELS.sendPrompt, [['执行测试']], 'invalid-input'],
    ['Date 请求', AGENT_INVOKE_CHANNELS.sendPrompt, [new Date()], 'invalid-input'],
    ['Map 请求', AGENT_INVOKE_CHANNELS.sendPrompt, [new Map()], 'invalid-input'],
    [
      '未知字段',
      AGENT_INVOKE_CHANNELS.sendPrompt,
      [{ prompt: '执行测试', taskId: 'fake' }],
      'invalid-input'
    ],
    ['空白 Prompt', AGENT_INVOKE_CHANNELS.sendPrompt, [{ prompt: '   ' }], 'invalid-input'],
    ['NUL Prompt', AGENT_INVOKE_CHANNELS.sendPrompt, [{ prompt: '执行\0测试' }], 'invalid-input'],
    [
      '相对目录',
      AGENT_INVOKE_CHANNELS.connect,
      [{ workspace: 'relative/path' }],
      'invalid-workspace'
    ]
  ] as const)('拒绝%s', async (_name, channel, args, code) => {
    const fixture = createFixture()
    const result = await fixture.invoke(channel, ...args)
    expect(result).toMatchObject({ ok: false, error: { code } })
  })

  it('拒绝文件路径和不存在目录', async () => {
    const fixture = createFixture()
    fixture.statPath.mockResolvedValueOnce({ isDirectory: () => false })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.connect, { workspace: '/tmp/file.txt' })
    ).toMatchObject({ ok: false, error: { code: 'invalid-workspace' } })

    fixture.statPath.mockRejectedValueOnce(new Error('ENOENT'))
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.connect, { workspace: '/tmp/missing' })
    ).toMatchObject({ ok: false, error: { code: 'invalid-workspace' } })
  })

  it('按 UTF-8 字节接受临界 Prompt，并拒绝超过一个字节的内容', async () => {
    const fixture = createFixture()
    const exactAscii = 'a'.repeat(64 * 1024)
    const exactEmoji = '😀'.repeat((64 * 1024) / 4)

    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.sendPrompt, { prompt: exactAscii })).toEqual({
      ok: true,
      value: null
    })
    expect(await fixture.invoke(AGENT_INVOKE_CHANNELS.sendPrompt, { prompt: exactEmoji })).toEqual({
      ok: true,
      value: null
    })
    expect(
      await fixture.invoke(AGENT_INVOKE_CHANNELS.sendPrompt, { prompt: `${exactAscii}a` })
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
      statPath: vi.fn(),
      sanitizeError: String
    })

    const result = (await handlers.get(AGENT_INVOKE_CHANNELS.getStatus)?.(
      event
    )) as DesktopIpcResult<unknown>
    expect(result).toMatchObject({ ok: false, error: { code: 'runtime-unavailable' } })
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

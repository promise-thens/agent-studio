import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AgentPermissionRequest,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus
} from '../../shared/agent'
import { createAgentRuntimeCapabilitySnapshot } from './runtime-capabilities'
import type {
  AgentRuntimeAdapter,
  AgentRuntimeSessionContext,
  AgentRuntimeSessionRef,
  AgentRuntimeTurnContext,
  AgentRuntimeTurnResult
} from './agent-runtime-adapter'
import { AgentRuntimeAdapterError } from './agent-runtime-adapter'
import { AgentService, AgentServiceError } from './agent-service'
import { TaskExecutionController } from './task-execution-controller'
import { ProjectRegistry } from '../project/project-registry'
import { TaskStore } from './task-store'

const WORKSPACE = '/tmp/agent-studio-project'

describe('AgentService Task / Turn 编排', () => {
  it('同 Task 连续 Turn 复用 session，Task A → B → A 时恢复 A 原会话', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, [
      'task-a',
      'turn-a1',
      'turn-a2',
      'task-b',
      'turn-b1',
      'turn-a3'
    ])

    const taskA = await service.createTask(WORKSPACE)
    const firstTurn = await service.startTurn(taskA.taskId, 'A 的第一轮')
    await service.startTurn(taskA.taskId, 'A 的第二轮')
    const taskB = await service.createTask(WORKSPACE)
    await service.startTurn(taskB.taskId, 'B 的第一轮')
    const resumedTurn = await service.startTurn(taskA.taskId, 'A 的第三轮')

    expect(JSON.stringify(taskA)).not.toContain('runtimeSessionId')
    expect(JSON.stringify(taskB)).not.toContain('runtimeSessionId')
    expect(firstTurn.taskId).toBe(resumedTurn.taskId)
    expect(firstTurn.turnId).not.toBe(resumedTurn.turnId)
    expect(adapter.createSession).toHaveBeenCalledTimes(2)
    expect(adapter.resumeSession).toHaveBeenCalledTimes(1)
    expect(adapter.resumeSession).toHaveBeenCalledWith({
      runtimeId: 'grok',
      runtimeSessionId: 'runtime-session-1',
      workspace: WORKSPACE
    })
    expect(adapter.loadSession).not.toHaveBeenCalled()
    expect(adapter.startTurn.mock.calls.map(([context]) => context)).toMatchObject([
      { taskId: 'task-a', turnId: 'turn-a1', runtimeSessionId: 'runtime-session-1' },
      { taskId: 'task-a', turnId: 'turn-a2', runtimeSessionId: 'runtime-session-1' },
      { taskId: 'task-b', turnId: 'turn-b1', runtimeSessionId: 'runtime-session-2' },
      { taskId: 'task-a', turnId: 'turn-a3', runtimeSessionId: 'runtime-session-1' }
    ])
  })

  it('resume 不可用时回退到 load，两项均未验证时明确阻断切换', async () => {
    const loadAdapter = new FakeRuntimeAdapter({ resume: false, load: true })
    const loadService = createService(loadAdapter, ['task-a', 'task-b', 'turn-a'])
    const taskA = await loadService.createTask(WORKSPACE)
    await loadService.createTask(WORKSPACE)

    await expect(loadService.startTurn(taskA.taskId, '切回 A')).resolves.toMatchObject({
      taskId: 'task-a',
      turnId: 'turn-a'
    })
    expect(loadAdapter.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeSessionId: 'runtime-session-1' })
    )

    const fallbackAdapter = new FakeRuntimeAdapter({ resume: true, load: true })
    fallbackAdapter.resumeSession.mockRejectedValueOnce(
      new AgentRuntimeAdapterError('operation-failed', 'resume 调用失败。')
    )
    const fallbackService = createService(fallbackAdapter, ['task-a', 'task-b', 'turn-a'])
    const fallbackTaskA = await fallbackService.createTask(WORKSPACE)
    await fallbackService.createTask(WORKSPACE)
    await fallbackService.startTurn(fallbackTaskA.taskId, 'resume 失败后 load')
    expect(fallbackAdapter.resumeSession).toHaveBeenCalledTimes(1)
    expect(fallbackAdapter.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeSessionId: 'runtime-session-1' })
    )

    const blockedAdapter = new FakeRuntimeAdapter({ resume: false, load: false })
    const blockedService = createService(blockedAdapter, ['task-a', 'task-b', 'turn-a'])
    const blockedTaskA = await blockedService.createTask(WORKSPACE)
    await blockedService.createTask(WORKSPACE)

    await expect(
      blockedService.startTurn(blockedTaskA.taskId, '不能串错上下文')
    ).rejects.toMatchObject({ code: 'session-restore-unsupported' })
    expect(blockedAdapter.startTurn).not.toHaveBeenCalled()
    expect(blockedService.getTaskRuntimeState(blockedTaskA.taskId)).toMatchObject({
      state: 'failed',
      lastTurnId: 'turn-a'
    })
  })

  it('resume 安全失败并废弃连接时保留原始诊断，不再用 load 错误覆盖根因', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const originalError = new AgentRuntimeAdapterError('operation-failed', '模型绑定失败。')
    adapter.resumeSession.mockImplementationOnce(async () => {
      await adapter.disconnect()
      throw originalError
    })
    const service = createService(adapter, ['task-a', 'task-b', 'turn-a'])
    const taskA = await service.createTask(WORKSPACE)
    await service.createTask(WORKSPACE)

    await expect(service.startTurn(taskA.taskId, '切回 A')).rejects.toEqual(
      new AgentServiceError('operation-failed', '模型绑定失败。')
    )
    expect(adapter.loadSession).not.toHaveBeenCalled()
  })

  it('重启后 resumeTask 重新校验 Project，resume 失败但连接可信时回退 load', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'agent-service-resume-'))
    const projectPath = join(userDataPath, 'project')
    await mkdir(projectPath)
    try {
      const registry = new ProjectRegistry({ userDataPath, createId: () => 'project-1' })
      await registry.initialize()
      const project = await registry.register(projectPath)
      const store = new TaskStore({ projectRegistry: registry })
      await store.initialize()
      await store.createTask({
        taskId: 'task-1',
        projectId: project.projectId,
        root: project.canonicalRoot,
        runtimeId: 'grok',
        session: {
          runtimeId: 'grok',
          runtimeSessionId: 'persisted-session',
          workspace: project.canonicalRoot
        },
        capabilitySnapshot: restoreSnapshot({ resume: true, load: true })
      })
      const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
      adapter.resumeSession.mockRejectedValueOnce(
        new AgentRuntimeAdapterError('session-not-found', 'resume session 不存在。')
      )
      const service = new AgentService(adapter, new TaskExecutionController(), {
        projectRegistry: registry,
        taskStore: store
      })

      await expect(service.resumeTask('task-1')).resolves.toMatchObject({
        resumed: true,
        method: 'load',
        task: { taskId: 'task-1' }
      })
      expect(adapter.connect).toHaveBeenCalledWith(project.canonicalRoot)
      expect(adapter.resumeSession).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeSessionId: 'persisted-session' })
      )
      expect(adapter.loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeSessionId: 'persisted-session' })
      )
    } finally {
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('单执行槽拒绝第二个 Turn，取消请求和终态收束保持幂等', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const turnResult = deferred<AgentRuntimeTurnResult>()
    adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    const service = createService(adapter, ['task-a', 'turn-a1', 'turn-a2'])
    const task = await service.createTask(WORKSPACE)

    const firstExecution = service.startTurn(task.taskId, '长任务')
    await vi.waitFor(() => expect(adapter.startTurn).toHaveBeenCalledTimes(1))
    await expect(service.startTurn(task.taskId, '重复点击')).rejects.toMatchObject({
      code: 'invalid-state'
    })

    await service.cancelTurn(task.taskId)
    await service.cancelTurn(task.taskId)
    expect(adapter.cancelTurn).toHaveBeenCalledTimes(1)

    turnResult.resolve({ outcome: 'cancelled' })
    await expect(firstExecution).resolves.toMatchObject({ outcome: 'cancelled' })
    expect(service.getTaskRuntimeState(task.taskId)).toMatchObject({ state: 'cancelled' })
    expect(service.getTaskRuntimeState(task.taskId).activeTurnId).toBeUndefined()
  })

  it('取消失败会解除 Controller 门禁，允许用户再次尝试', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const turnResult = deferred<AgentRuntimeTurnResult>()
    adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    adapter.cancelTurn.mockRejectedValueOnce(
      new AgentRuntimeAdapterError('operation-failed', '取消失败。')
    )
    const service = createService(adapter, ['task-a', 'turn-a1'])
    const task = await service.createTask(WORKSPACE)
    const execution = service.startTurn(task.taskId, '长任务')
    await vi.waitFor(() => expect(adapter.startTurn).toHaveBeenCalledTimes(1))

    await expect(service.cancelTurn(task.taskId)).rejects.toMatchObject({
      code: 'operation-failed'
    })
    await expect(service.cancelTurn(task.taskId)).resolves.toBeUndefined()
    expect(adapter.cancelTurn).toHaveBeenCalledTimes(2)

    turnResult.resolve({ outcome: 'cancelled' })
    await execution
  })

  it('Runtime 崩溃后重新连接会清除旧选择指针，并在下一轮恢复原 Task session', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a', 'turn-a1', 'turn-a2'])
    const task = await service.createTask(WORKSPACE)
    await service.startTurn(task.taskId, '第一轮')

    await service.connect(WORKSPACE)
    await service.startTurn(task.taskId, '重连后的第二轮')

    expect(adapter.resumeSession).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeSessionId: 'runtime-session-1' })
    )
  })

  it('并发创建 Task 时只允许一个 session 操作进入 Runtime', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const sessionResult = deferred<AgentRuntimeSessionRef>()
    adapter.createSession.mockImplementationOnce(() => sessionResult.promise)
    const service = createService(adapter, ['task-a'])

    const firstTask = service.createTask(WORKSPACE)
    await vi.waitFor(() => expect(adapter.createSession).toHaveBeenCalledTimes(1))
    await expect(service.createTask(WORKSPACE)).rejects.toMatchObject({ code: 'invalid-state' })

    sessionResult.resolve({
      runtimeId: 'grok',
      runtimeSessionId: 'runtime-session-1',
      workspace: WORKSPACE
    })
    await expect(firstTask).resolves.toMatchObject({ taskId: 'task-a' })
    expect(adapter.createSession).toHaveBeenCalledTimes(1)
  })

  it('权限响应只转发一次，断开可取消活动 Turn 并清理等待状态', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const turnResult = deferred<AgentRuntimeTurnResult>()
    adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    const controller = new TaskExecutionController()
    const service = createService(adapter, ['task-a', 'turn-a1'], controller)
    const task = await service.createTask(WORKSPACE)
    const execution = service.startTurn(task.taskId, '等待权限')
    await vi.waitFor(() => expect(adapter.startTurn).toHaveBeenCalledTimes(1))

    const permission = permissionRequest(task.taskId, 'turn-a1', 'runtime-session-1')
    service.handlePermissionRequest(permission)
    expect(service.getTaskRuntimeState(task.taskId).state).toBe('waiting-permission')

    service.respondPermission(permission.id, 'allow-once')
    service.respondPermission(permission.id, 'allow-once')
    expect(adapter.respondPermission).toHaveBeenCalledTimes(1)
    expect(service.getTaskRuntimeState(task.taskId).state).toBe('running')

    await service.disconnect()
    expect(adapter.cancelTurn).not.toHaveBeenCalled()
    expect(adapter.disconnect).toHaveBeenCalledTimes(1)
    expect(controller.getActiveTurn()).toBeNull()
    expect(service.getTaskRuntimeState(task.taskId).state).toBe('cancelled')
    expect(service.getSelectedTaskId()).toBeNull()

    turnResult.resolve({ outcome: 'cancelled' })
    await execution
  })

  it('断开时等待历史队列并把持久化 Turn 收束为 cancelled', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const turnResult = deferred<AgentRuntimeTurnResult>()
    adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    const historyWrite = deferred<void>()
    const taskStore = {
      listTaskRecords: vi.fn(() => []),
      createTask: vi.fn(async () => undefined),
      createTurn: vi.fn(async () => undefined),
      markTurnDispatched: vi.fn(async () => undefined),
      appendEvent: vi.fn(() => historyWrite.promise),
      setPermissionState: vi.fn(async () => undefined),
      finishTurn: vi.fn(async () => undefined)
    }
    let idIndex = 0
    const service = new AgentService(adapter, new TaskExecutionController(), {
      createId: () => ['task-a', 'turn-a1'][idIndex++]!,
      taskStore: taskStore as never
    })
    const task = await service.createTask(WORKSPACE)
    const execution = service.startTurn(task.taskId, '等待落盘')
    await vi.waitFor(() => expect(adapter.startTurn).toHaveBeenCalledOnce())
    service.handleRuntimeEvent({
      runtimeId: 'grok',
      runtimeSessionId: 'runtime-session-1',
      capabilityState: 'native',
      taskId: task.taskId,
      turnId: 'turn-a1',
      sequence: 1,
      observedAt: '2026-08-12T00:00:00.000Z',
      kind: 'agent-message',
      text: '输出'
    })

    const disconnecting = service.disconnect()
    await Promise.resolve()
    expect(taskStore.finishTurn).not.toHaveBeenCalled()
    historyWrite.resolve()
    await disconnecting
    expect(taskStore.finishTurn).toHaveBeenCalledWith('task-a', 'turn-a1', 'cancelled')

    turnResult.resolve({ outcome: 'cancelled' })
    await execution
  })

  it('旧 Turn 的晚到终态不能覆盖当前新 Turn，错误 session 的权限请求也会被忽略', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a', 'turn-a1', 'turn-a2'])
    const task = await service.createTask(WORKSPACE)
    await service.startTurn(task.taskId, '第一轮')

    const secondResult = deferred<AgentRuntimeTurnResult>()
    adapter.startTurn.mockImplementationOnce(() => secondResult.promise)
    const secondExecution = service.startTurn(task.taskId, '第二轮')
    await vi.waitFor(() => expect(adapter.startTurn).toHaveBeenCalledTimes(2))

    service.handleRuntimeEvent({
      runtimeId: 'grok',
      runtimeSessionId: 'runtime-session-1',
      capabilityState: 'native',
      taskId: task.taskId,
      turnId: 'turn-a1',
      sequence: 99,
      observedAt: '2026-08-11T00:00:00.000Z',
      kind: 'turn-complete',
      outcome: 'failed'
    })
    service.handlePermissionRequest(permissionRequest(task.taskId, 'turn-a2', 'wrong-session'))
    service.handlePermissionRequest({
      ...permissionRequest(task.taskId, 'turn-a2', 'runtime-session-1'),
      runtimeId: 'codex'
    })
    expect(service.getTaskRuntimeState(task.taskId)).toMatchObject({
      state: 'running',
      activeTurnId: 'turn-a2'
    })

    secondResult.resolve({ outcome: 'completed' })
    await secondExecution
    expect(service.getTaskRuntimeState(task.taskId).state).toBe('completed')
  })

  it('服务层再次校验工作区、Prompt 与未知 Task，不信任 IPC 前置校验', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a', 'turn-a'])

    await expect(service.createTask('relative/path')).rejects.toMatchObject({
      code: 'invalid-input'
    })
    await expect(service.createTask('/tmp/another-project')).rejects.toMatchObject({
      code: 'workspace-mismatch'
    })
    await expect(service.startTurn('unknown-task', '测试')).rejects.toMatchObject({
      code: 'task-not-found'
    })

    const task = await service.createTask(WORKSPACE)
    await expect(service.startTurn(task.taskId, '   ')).rejects.toMatchObject({
      code: 'invalid-input'
    })
    await expect(service.startTurn(task.taskId, 'x'.repeat(64 * 1024 + 1))).rejects.toMatchObject({
      code: 'payload-too-large'
    })
  })

  it('未知 Runtime 异常统一收敛为有限 operation-failed 错误', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    adapter.createSession.mockRejectedValueOnce(new Error('raw runtime secret'))
    const service = createService(adapter, ['task-a'])

    await expect(service.createTask(WORKSPACE)).rejects.toEqual(
      new AgentServiceError('operation-failed', 'Agent Runtime 操作失败。')
    )
  })
})

class FakeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = 'grok' as const
  private sessionSequence = 0
  private snapshot: AgentRuntimeCapabilitySnapshot
  private status: AgentRuntimeStatus

  readonly connect = vi.fn(async (workspace: string): Promise<AgentRuntimeStatus> => {
    this.status = {
      runtimeId: 'grok',
      state: 'ready',
      workspace,
      message: '已连接',
      capabilitySnapshot: this.snapshot
    }
    return this.status
  })

  readonly disconnect = vi.fn(async (): Promise<AgentRuntimeStatus> => {
    this.status = {
      runtimeId: 'grok',
      state: 'idle',
      message: '已断开',
      capabilitySnapshot: this.snapshot
    }
    return this.status
  })

  readonly createSession = vi.fn(
    async (context: AgentRuntimeSessionContext): Promise<AgentRuntimeSessionRef> => {
      this.sessionSequence += 1
      const session = {
        runtimeId: 'grok' as const,
        runtimeSessionId: `runtime-session-${this.sessionSequence}`,
        workspace: context.workspace
      }
      this.status = { ...this.status, runtimeSessionId: session.runtimeSessionId }
      return session
    }
  )

  readonly loadSession = vi.fn(async (session: AgentRuntimeSessionRef): Promise<void> => {
    this.status = { ...this.status, runtimeSessionId: session.runtimeSessionId }
  })

  readonly resumeSession = vi.fn(async (session: AgentRuntimeSessionRef): Promise<void> => {
    this.status = { ...this.status, runtimeSessionId: session.runtimeSessionId }
  })

  readonly closeSession = vi.fn(async (): Promise<void> => undefined)
  readonly startTurn = vi.fn<(context: AgentRuntimeTurnContext) => Promise<AgentRuntimeTurnResult>>(
    async () => ({ outcome: 'completed' })
  )
  readonly cancelTurn = vi.fn(async (): Promise<void> => undefined)
  readonly respondPermission = vi.fn((): void => undefined)

  constructor(capabilities: { resume: boolean; load: boolean }) {
    this.snapshot = restoreSnapshot(capabilities)
    this.status = {
      runtimeId: 'grok',
      state: 'ready',
      message: '已连接',
      workspace: WORKSPACE,
      capabilitySnapshot: this.snapshot
    }
  }

  getStatus(): AgentRuntimeStatus {
    return this.status
  }

  getCapabilitySnapshot(): AgentRuntimeCapabilitySnapshot {
    return this.snapshot
  }
}

/** 使用协议声明证据模拟已经通过迁移前本机验证、可首次调用的恢复能力。 */
function restoreSnapshot({
  resume,
  load
}: {
  resume: boolean
  load: boolean
}): AgentRuntimeCapabilitySnapshot {
  return createAgentRuntimeCapabilitySnapshot({
    runtimeId: 'grok',
    capabilities: [
      resume
        ? {
            capabilityId: 'session.resume',
            support: 'native',
            maturity: 'stable',
            verification: 'declared',
            source: 'protocol'
          }
        : {
            capabilityId: 'session.resume',
            support: 'unknown',
            verification: 'unverified',
            source: 'fallback'
          },
      load
        ? {
            capabilityId: 'session.load',
            support: 'native',
            maturity: 'stable',
            verification: 'declared',
            source: 'protocol'
          }
        : {
            capabilityId: 'session.load',
            support: 'unknown',
            verification: 'unverified',
            source: 'fallback'
          }
    ]
  })
}

function createService(
  adapter: FakeRuntimeAdapter,
  ids: string[],
  controller = new TaskExecutionController()
): AgentService {
  let idIndex = 0
  let clock = 0
  return new AgentService(adapter, controller, {
    createId: () => ids[idIndex++] ?? `unexpected-id-${idIndex}`,
    now: () => new Date(Date.UTC(2026, 7, 11, 0, 0, clock++)).toISOString()
  })
}

function permissionRequest(
  taskId: string,
  turnId: string,
  runtimeSessionId: string
): AgentPermissionRequest {
  return {
    id: 'permission-1',
    runtimeId: 'grok',
    taskId,
    turnId,
    runtimeSessionId,
    title: '运行测试',
    options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }]
  }
}

/** 构造可控结果，验证取消、权限和断开的异步收束。 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

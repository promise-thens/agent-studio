import { execFile as execFileCallback } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type { AgentRuntimeCapabilitySnapshot, AgentRuntimeStatus } from '../../shared/agent'
import {
  createEnsureTaskChangeBaseline,
  TaskChangeBaselineStore
} from '../git/task-change-baseline'
import { ProjectRegistry } from '../project/project-registry'
import type {
  AgentRuntimeAdapter,
  AgentRuntimeSessionRef,
  AgentRuntimeTurnContext,
  AgentRuntimeTurnResult
} from './agent-runtime-adapter'
import { OperationGate } from './operation-gate'
import {
  TaskExecutor,
  type TaskExecutorOptions,
  type TaskExecutorStartInput
} from './task-executor'
import { TaskStore } from './task-store'

const execFile = promisify(execFileCallback)

const temporaryDirectories: string[] = []

class ExecutorAdapter implements AgentRuntimeAdapter {
  readonly runtimeId = 'grok' as const
  readonly startTurn =
    vi.fn<(context: AgentRuntimeTurnContext) => Promise<AgentRuntimeTurnResult>>()
  readonly cancelTurn = vi.fn(async () => undefined)
  readonly createSession = vi.fn(async () => SESSION)
  readonly loadSession = vi.fn(async () => undefined)
  readonly resumeSession = vi.fn(async () => undefined)
  readonly closeSession = vi.fn(async () => undefined)
  readonly connect = vi.fn(async (): Promise<AgentRuntimeStatus> => STATUS)
  readonly disconnect = vi.fn(async (): Promise<AgentRuntimeStatus> => STATUS)
  readonly respondPermission = vi.fn()

  getStatus(): AgentRuntimeStatus {
    return STATUS
  }

  getCapabilitySnapshot(): AgentRuntimeCapabilitySnapshot {
    return capabilitySnapshot()
  }
}

const SESSION: AgentRuntimeSessionRef = {
  runtimeId: 'grok',
  runtimeSessionId: 'session-1',
  workspace: '/tmp/project'
}

const STATUS: AgentRuntimeStatus = {
  runtimeId: 'grok',
  state: 'ready',
  message: 'ready',
  workspace: SESSION.workspace
}

describe('TaskExecutor', () => {
  it('admission 持久化未完成时原子拒绝第二个 start', async () => {
    const fixture = await createFixture()
    const writer = (
      fixture.store as unknown as {
        writer: { write(path: string, value: unknown): Promise<void> }
      }
    ).writer
    const originalWrite = writer.write.bind(writer)
    const turnWriteStarted = deferred<void>()
    const releaseTurnWrite = deferred<void>()
    writer.write = async (path: string, value: unknown): Promise<void> => {
      if (path.endsWith('/turns/turn-1/turn.json')) {
        turnWriteStarted.resolve()
        await releaseTurnWrite.promise
      }
      return originalWrite(path, value)
    }

    const first = fixture.executor.start(fixture.input)
    await turnWriteStarted.promise
    await expect(fixture.executor.start(fixture.input)).rejects.toMatchObject({
      code: 'invalid-state'
    })
    expect(fixture.adapter.startTurn).not.toHaveBeenCalled()

    releaseTurnWrite.resolve()
    await first
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    expect((await fixture.store.listTurns('task-1')).items).toHaveLength(1)
  })

  it('queued 持久化后快速返回，不等待 Runtime Turn Promise', async () => {
    const fixture = await createFixture()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)

    const snapshot = await fixture.executor.start(fixture.input)
    expect(snapshot.execution).toMatchObject({ state: 'queued', taskId: 'task-1' })
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    expect(fixture.executor.getSnapshot()).toMatchObject({
      executionRevision: 2,
      execution: { state: 'running' }
    })

    runtimeResult.resolve({ outcome: 'completed' })
    await vi.waitFor(() =>
      expect(fixture.executor.getSnapshot()).toMatchObject({
        execution: { state: 'completed' }
      })
    )
    expect(fixture.executor.hasActiveExecution()).toBe(false)
  })

  it('running 持久化失败时不调用 Adapter，并收束为 failed', async () => {
    const fixture = await createFixture()
    const writer = (
      fixture.store as unknown as {
        writer: { write(path: string, value: unknown): Promise<void> }
      }
    ).writer
    const originalWrite = writer.write.bind(writer)
    let failed = false
    writer.write = async (path: string, value: unknown): Promise<void> => {
      if (!failed && path.endsWith('/turns/turn-1/turn.json')) {
        const record = value as { state?: string }
        if (record.state === 'running') {
          failed = true
          throw new Error('模拟 running 写入失败')
        }
      }
      return originalWrite(path, value)
    }

    await fixture.executor.start(fixture.input)
    await vi.waitFor(() =>
      expect(fixture.executor.getSnapshot()).toMatchObject({ execution: { state: 'failed' } })
    )
    expect(fixture.adapter.startTurn).not.toHaveBeenCalled()
  })

  it('事件持久化完成后才发布，重复和截断事件不会形成正式实时节点', async () => {
    const fixture = await createFixture()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    const admitted = await fixture.executor.start(fixture.input)
    const execution = admitted.execution
    if (!execution) throw new Error('缺少 execution。')
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())

    const writer = (
      fixture.store as unknown as {
        writer: { write(path: string, value: unknown): Promise<void> }
      }
    ).writer
    const originalWrite = writer.write.bind(writer)
    const eventWriteStarted = deferred<void>()
    const releaseEventWrite = deferred<void>()
    writer.write = async (path: string, value: unknown): Promise<void> => {
      if (path.endsWith('/events/000001.json')) {
        eventWriteStarted.resolve()
        await releaseEventWrite.promise
      }
      return originalWrite(path, value)
    }
    const event = {
      runtimeId: 'grok' as const,
      capabilityState: 'native' as const,
      runtimeSessionId: SESSION.runtimeSessionId,
      taskId: execution.taskId,
      turnId: execution.turnId,
      sequence: 1,
      observedAt: '2026-08-17T10:00:02.000Z',
      kind: 'agent-message' as const,
      text: '已提交后发布'
    }

    expect(fixture.executor.handleRuntimeEvent(event)).toBe(true)
    await eventWriteStarted.promise
    expect(fixture.onEvent).not.toHaveBeenCalled()
    releaseEventWrite.resolve()
    await vi.waitFor(() => expect(fixture.onEvent).toHaveBeenCalledWith(event))

    fixture.executor.handleRuntimeEvent(event)
    await vi.waitFor(() => expect(fixture.onEvent).toHaveBeenCalledTimes(1))
    fixture.executor.handleRuntimeEvent({
      ...event,
      sequence: 2,
      text: 'x'.repeat(257 * 1024)
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fixture.onEvent).toHaveBeenCalledTimes(1)

    runtimeResult.resolve({ outcome: 'completed' })
    await fixture.executor.waitForTerminal()
  })

  it('拒绝 sequence gap 与终态后晚到事件，并把终态 Usage 原子写入 Turn', async () => {
    const fixture = await createFixture()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    const admitted = await fixture.executor.start(fixture.input)
    const execution = admitted.execution
    if (!execution) throw new Error('缺少 execution。')
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())

    expect(
      fixture.executor.handleRuntimeEvent({
        runtimeId: 'grok',
        capabilityState: 'native',
        runtimeSessionId: SESSION.runtimeSessionId,
        taskId: execution.taskId,
        turnId: execution.turnId,
        sequence: 2,
        observedAt: '2026-08-17T10:00:02.000Z',
        kind: 'agent-message',
        text: '跳号事件'
      })
    ).toBe(false)
    expect(fixture.onEvent).not.toHaveBeenCalled()

    const terminal = {
      runtimeId: 'grok' as const,
      capabilityState: 'native' as const,
      runtimeSessionId: SESSION.runtimeSessionId,
      taskId: execution.taskId,
      turnId: execution.turnId,
      sequence: 1,
      observedAt: '2026-08-17T10:00:03.000Z',
      kind: 'turn-complete' as const,
      outcome: 'completed' as const,
      usage: {
        scope: 'turn' as const,
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30
      }
    }
    expect(fixture.executor.handleRuntimeEvent(terminal)).toBe(true)
    expect(
      fixture.executor.handleRuntimeEvent({
        ...terminal,
        sequence: 2,
        kind: 'agent-message' as const,
        text: '终态后晚到'
      })
    ).toBe(false)
    runtimeResult.resolve({ outcome: 'failed' })
    await fixture.executor.waitForTerminal()

    expect((await fixture.store.listTurns('task-1')).items[0]).toMatchObject({
      state: 'completed',
      usage: { totalTokens: 30 }
    })
    expect(fixture.onEvent).toHaveBeenCalledTimes(1)
    expect(fixture.onEvent).toHaveBeenCalledWith(terminal)
  })

  it('事件落盘先做安全投影，不保存 Runtime session 或未脱敏文本', async () => {
    const fixture = await createFixture({
      redactText: (text) => text.replaceAll('fake-secret', '[REDACTED]')
    })
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    const admitted = await fixture.executor.start(fixture.input)
    const execution = admitted.execution
    if (!execution) throw new Error('缺少 execution。')
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())

    fixture.executor.handleRuntimeEvent({
      runtimeId: 'grok',
      capabilityState: 'native',
      runtimeSessionId: SESSION.runtimeSessionId,
      taskId: execution.taskId,
      turnId: execution.turnId,
      sequence: 1,
      observedAt: '2026-08-17T10:00:02.000Z',
      kind: 'agent-message',
      text: 'Bearer fake-secret'
    })
    runtimeResult.resolve({ outcome: 'completed' })
    await vi.waitFor(() => expect(fixture.executor.hasActiveExecution()).toBe(false))

    const serialized = JSON.stringify(await fixture.store.listEvents('task-1', execution.turnId))
    expect(serialized).not.toContain(SESSION.runtimeSessionId)
    expect(serialized).not.toContain('fake-secret')
    expect(serialized).toContain('[REDACTED]')
  })

  it('observer 抛错不会阻断 dispatch 或终态释放', async () => {
    const fixture = await createFixture()
    fixture.onSnapshot.mockImplementation(() => {
      throw new Error('observer failed')
    })
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)

    await fixture.executor.start(fixture.input)
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    runtimeResult.resolve({ outcome: 'completed' })
    await vi.waitFor(() => expect(fixture.executor.hasActiveExecution()).toBe(false))
  })

  it('终态持久化短暂失败后可显式重试并释放执行槽', async () => {
    const fixture = await createFixture()
    const writer = (
      fixture.store as unknown as {
        writer: { write(path: string, value: unknown): Promise<void> }
      }
    ).writer
    const originalWrite = writer.write.bind(writer)
    let failTaskTerminal = true
    writer.write = async (path: string, value: unknown): Promise<void> => {
      if (
        failTaskTerminal &&
        path.endsWith('/tasks/task-1/task.json') &&
        (value as { state?: string }).state === 'completed'
      ) {
        failTaskTerminal = false
        throw new Error('模拟 Task terminal 写入失败')
      }
      return originalWrite(path, value)
    }
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)

    await fixture.executor.start(fixture.input)
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    runtimeResult.resolve({ outcome: 'completed' })
    await vi.waitFor(() => expect(fixture.executor.hasActiveExecution()).toBe(true))
    expect(await fixture.executor.retryPersistence()).toBe(true)
    expect(fixture.executor.hasActiveExecution()).toBe(false)
    expect((await fixture.store.listTurns('task-1')).items[0]?.state).toBe('completed')
  })

  it('Runtime event 与 Promise 重复终态只发布一次终态 revision', async () => {
    const fixture = await createFixture()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    const snapshots: string[] = []
    fixture.onSnapshot.mockImplementation((snapshot) => {
      if (snapshot.execution) snapshots.push(snapshot.execution.state)
    })

    const admitted = await fixture.executor.start(fixture.input)
    const execution = admitted.execution
    if (!execution) throw new Error('缺少 execution。')
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    fixture.executor.handleRuntimeEvent({
      runtimeId: 'grok',
      capabilityState: 'native',
      runtimeSessionId: SESSION.runtimeSessionId,
      taskId: execution.taskId,
      turnId: execution.turnId,
      sequence: 1,
      observedAt: '2026-08-17T10:00:02.000Z',
      kind: 'turn-complete',
      outcome: 'completed'
    })
    runtimeResult.resolve({ outcome: 'failed' })

    await vi.waitFor(() => expect(fixture.executor.hasActiveExecution()).toBe(false))
    expect(snapshots.filter((state) => state === 'completed')).toHaveLength(1)
    expect(snapshots).not.toContain('failed')
    expect((await fixture.store.listTurns('task-1')).items[0]?.state).toBe('completed')
  })

  it('prepareRuntime 持有 execution lease 时拒绝第二次执行和其它主进程事务', async () => {
    const fixture = await createFixture()
    const prepareStarted = deferred<void>()
    const releasePrepare = deferred<void>()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    const input: TaskExecutorStartInput = {
      ...fixture.input,
      prepareRuntime: async (lease) => {
        expect(fixture.gate.ownsCurrentLease(lease)).toBe(true)
        prepareStarted.resolve()
        await releasePrepare.promise
      }
    }

    await fixture.executor.start(input)
    await prepareStarted.promise
    expect(() => fixture.gate.acquireProviderMutation()).toThrow()
    expect(() => fixture.gate.acquireSessionOperation()).toThrow()
    await expect(fixture.executor.start(fixture.input)).rejects.toMatchObject({
      code: 'invalid-state'
    })
    expect(fixture.adapter.startTurn).not.toHaveBeenCalled()

    releasePrepare.resolve()
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    runtimeResult.resolve({ outcome: 'completed' })
    await fixture.executor.waitForTerminal()
    expect(fixture.gate.getState()).toBe('idle')
  })

  it('prepareRuntime 失败时不发送 Prompt，并可靠收束为 failed', async () => {
    const fixture = await createFixture()

    await fixture.executor.start({
      ...fixture.input,
      prepareRuntime: async () => {
        throw new Error('模拟恢复失败')
      }
    })
    await fixture.executor.waitForTerminal()

    expect(fixture.adapter.startTurn).not.toHaveBeenCalled()
    expect(fixture.executor.getSnapshot()).toMatchObject({
      execution: { state: 'failed', reason: 'dispatch-failed' }
    })
    expect(fixture.gate.getState()).toBe('idle')
  })

  it('waitForTerminal 在 prepareRuntime 与 Runtime 均未结束时保持 pending', async () => {
    const fixture = await createFixture()
    const prepareStarted = deferred<void>()
    const releasePrepare = deferred<void>()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)

    await fixture.executor.start({
      ...fixture.input,
      prepareRuntime: async () => {
        prepareStarted.resolve()
        await releasePrepare.promise
      }
    })
    await prepareStarted.promise
    let settled = false
    const waiting = fixture.executor.waitForTerminal().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releasePrepare.resolve()
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(settled).toBe(false)

    runtimeResult.resolve({ outcome: 'completed' })
    await waiting
    expect(settled).toBe(true)
  })

  it('同 tick 双 cancel 共享一次 Adapter 调用和同一个结果', async () => {
    const fixture = await createFixture()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    const cancelResult = deferred<undefined>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    fixture.adapter.cancelTurn.mockReturnValue(cancelResult.promise)
    const admitted = await fixture.executor.start(fixture.input)
    const execution = admitted.execution
    if (!execution) throw new Error('缺少 execution。')
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())

    const request = {
      executionId: execution.executionId,
      taskId: execution.taskId,
      turnId: execution.turnId
    }
    const first = fixture.executor.cancel(request)
    const second = fixture.executor.cancel(request)
    await vi.waitFor(() => expect(fixture.adapter.cancelTurn).toHaveBeenCalledOnce())
    cancelResult.resolve(undefined)

    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(fixture.adapter.cancelTurn).toHaveBeenCalledOnce()
    runtimeResult.resolve({ outcome: 'cancelled' })
    await fixture.executor.waitForTerminal()
  })

  it('cancel 失败恢复原状态并允许再次尝试', async () => {
    const fixture = await createFixture()
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    fixture.adapter.cancelTurn.mockRejectedValueOnce(new Error('模拟 cancel 失败'))
    const admitted = await fixture.executor.start(fixture.input)
    const execution = admitted.execution
    if (!execution) throw new Error('缺少 execution。')
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
    const request = {
      executionId: execution.executionId,
      taskId: execution.taskId,
      turnId: execution.turnId
    }

    await expect(fixture.executor.cancel(request)).resolves.toBe(false)
    expect(fixture.executor.getSnapshot()).toMatchObject({ execution: { state: 'running' } })
    await expect(fixture.executor.cancel(request)).resolves.toBe(true)
    expect(fixture.adapter.cancelTurn).toHaveBeenCalledTimes(2)

    runtimeResult.resolve({ outcome: 'cancelled' })
    await fixture.executor.waitForTerminal()
  })

  it('cancel deadline 清理 Broker 与 Runtime 后提交 interrupted/cancel-timeout', async () => {
    const scheduler = createManualScheduler()
    const onCancelTimeout = vi.fn(async () => undefined)
    const fixture = await createFixture({
      cancelTimeoutMs: 5_000,
      forceDisconnectTimeoutMs: 2_000,
      scheduleTimeout: scheduler.schedule,
      clearScheduledTimeout: scheduler.clear,
      onCancelTimeout
    })
    const runtimeResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockReturnValue(runtimeResult.promise)
    const admitted = await fixture.executor.start(fixture.input)
    const execution = admitted.execution
    if (!execution) throw new Error('缺少 execution。')
    await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())

    await expect(
      fixture.executor.cancel({
        executionId: execution.executionId,
        taskId: execution.taskId,
        turnId: execution.turnId
      })
    ).resolves.toBe(true)
    expect(fixture.executor.getSnapshot()).toMatchObject({ execution: { state: 'cancelling' } })
    expect(scheduler.pendingDelays()).toContain(5_000)

    await scheduler.runNext(5_000)
    await fixture.executor.waitForTerminal()
    expect(onCancelTimeout).toHaveBeenCalledWith({
      executionId: execution.executionId,
      taskId: execution.taskId,
      turnId: execution.turnId
    })
    expect(fixture.adapter.disconnect).toHaveBeenCalledOnce()
    expect(fixture.executor.getSnapshot()).toMatchObject({
      execution: { state: 'interrupted', reason: 'cancel-timeout' }
    })
    expect(fixture.gate.getState()).toBe('idle')
  })

  it('无 ensureChangeBaseline hook 时现有 start 行为不变', async () => {
    const fixture = await createFixture()
    fixture.adapter.startTurn.mockResolvedValue({ outcome: 'completed' })
    const snapshot = await fixture.executor.start(fixture.input)
    expect(snapshot.execution).toMatchObject({ state: 'queued', taskId: 'task-1' })
    await fixture.executor.waitForTerminal()
    expect(fixture.adapter.startTurn).toHaveBeenCalledOnce()
    expect(fixture.executor.hasActiveExecution()).toBe(false)
  })

  it('有 hook 时第一轮 start 捕获基线，第二轮不 recapture', async () => {
    const reviewRoot = await mkdtemp(join(tmpdir(), 'task-executor-git-review-'))
    temporaryDirectories.push(reviewRoot)
    const baselineStore = new TaskChangeBaselineStore({ rootDir: reviewRoot })
    const hooked = await createFixture({
      ensureChangeBaseline: createEnsureTaskChangeBaseline({
        store: baselineStore,
        getProjectAvailability: async () => ({ state: 'available' })
      })
    })
    hooked.adapter.startTurn.mockResolvedValue({ outcome: 'completed' })
    await initGitRepo(hooked.input.resolvedExecutionRoot)
    await writeFile(join(hooked.input.resolvedExecutionRoot, 'README.md'), 'hello\n')
    await runGit(hooked.input.resolvedExecutionRoot, ['add', 'README.md'])
    await runGit(hooked.input.resolvedExecutionRoot, ['commit', '-m', 'init'])

    await hooked.executor.start(hooked.input)
    await hooked.executor.waitForTerminal()
    const first = await baselineStore.get(hooked.input.taskId, hooked.input.environmentId)
    expect(first?.status).toBe('captured')
    expect(first?.baseCommit).toMatch(/^[0-9a-f]{40,64}$/)

    await hooked.executor.start(hooked.input)
    await hooked.executor.waitForTerminal()
    const second = await baselineStore.get(hooked.input.taskId, hooked.input.environmentId)
    expect(second?.capturedAt).toBe(first?.capturedAt)
    expect(second?.baseCommit).toBe(first?.baseCommit)
    expect(hooked.adapter.startTurn).toHaveBeenCalledTimes(2)
  })

  it('hook 抛错或 git 不可用时不得拒绝 Turn', async () => {
    const throwing = await createFixture({
      ensureChangeBaseline: async () => {
        throw new Error('模拟基线捕获失败')
      }
    })
    throwing.adapter.startTurn.mockResolvedValue({ outcome: 'completed' })
    await throwing.executor.start(throwing.input)
    await throwing.executor.waitForTerminal()
    expect(throwing.adapter.startTurn).toHaveBeenCalledOnce()
    expect(throwing.executor.getSnapshot()).toMatchObject({
      execution: { state: 'completed' }
    })

    const reviewRoot = await mkdtemp(join(tmpdir(), 'task-executor-git-unavailable-'))
    temporaryDirectories.push(reviewRoot)
    const unavailable = await createFixture({
      ensureChangeBaseline: createEnsureTaskChangeBaseline({
        store: new TaskChangeBaselineStore({ rootDir: reviewRoot }),
        getProjectAvailability: async () => ({ state: 'available' }),
        gitExecutable: join(reviewRoot, 'no-such-git-binary')
      })
    })
    unavailable.adapter.startTurn.mockResolvedValue({ outcome: 'completed' })
    await unavailable.executor.start(unavailable.input)
    await unavailable.executor.waitForTerminal()
    expect(unavailable.adapter.startTurn).toHaveBeenCalledOnce()
  })
})

async function createFixture(
  options: {
    redactText?: (text: string) => string
    cancelTimeoutMs?: number
    forceDisconnectTimeoutMs?: number
    scheduleTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
    clearScheduledTimeout?: (timer: ReturnType<typeof setTimeout>) => void
    onCancelTimeout?: (identity: {
      executionId: string
      taskId: string
      turnId: string
    }) => Promise<void>
    ensureChangeBaseline?: TaskExecutorOptions['ensureChangeBaseline']
  } = {}
): Promise<{
  store: TaskStore
  adapter: ExecutorAdapter
  executor: TaskExecutor
  gate: OperationGate
  onSnapshot: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  input: ReturnType<typeof startInput>
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'task-executor-'))
  temporaryDirectories.push(userDataPath)
  const projectPath = join(userDataPath, 'project')
  await mkdir(projectPath)
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
    session: { ...SESSION, workspace: project.canonicalRoot },
    capabilitySnapshot: capabilitySnapshot()
  })
  const adapter = new ExecutorAdapter()
  const onSnapshot = vi.fn()
  const onEvent = vi.fn()
  const gate = new OperationGate()
  const ids = ['execution-1', 'turn-1', 'execution-2', 'turn-2']
  const executor = new TaskExecutor({
    taskStore: store,
    adapter,
    operationGate: gate,
    createId: () => ids.shift() ?? 'unexpected-id',
    executorEpoch: 'epoch-1',
    now: createClock(),
    onSnapshot,
    onEvent,
    redactText: options.redactText,
    cancelTimeoutMs: options.cancelTimeoutMs,
    forceDisconnectTimeoutMs: options.forceDisconnectTimeoutMs,
    scheduleTimeout: options.scheduleTimeout,
    clearScheduledTimeout: options.clearScheduledTimeout,
    onCancelTimeout: options.onCancelTimeout,
    ...(options.ensureChangeBaseline ? { ensureChangeBaseline: options.ensureChangeBaseline } : {})
  })
  const input = startInput({
    projectId: project.projectId,
    environmentId: store.getTaskRecord('task-1').environment.environmentId,
    workspace: project.canonicalRoot
  })
  return { store, adapter, executor, gate, onSnapshot, onEvent, input }
}

function startInput(identity: {
  projectId: string
  environmentId: string
  workspace: string
}): TaskExecutorStartInput {
  return {
    taskId: 'task-1',
    projectId: identity.projectId,
    runtimeId: 'grok' as const,
    session: { ...SESSION, workspace: identity.workspace },
    environmentId: identity.environmentId,
    resolvedExecutionRoot: identity.workspace,
    prompt: '测试 Prompt',
    promptDisplayText: '测试 Prompt',
    model: { modelId: 'model-1' },
    capabilitySnapshot: capabilitySnapshot()
  }
}

function capabilitySnapshot(): AgentRuntimeCapabilitySnapshot {
  const capabilities = {} as AgentRuntimeCapabilitySnapshot['capabilities']
  for (const capabilityId of [
    'runtime.connect',
    'session.create',
    'session.prompt.text',
    'session.cancel',
    'session.load',
    'session.resume',
    'event.agent-message',
    'event.agent-thought',
    'event.plan',
    'event.tool',
    'event.diff',
    'permission.request',
    'usage.context',
    'usage.turn'
  ] as const) {
    capabilities[capabilityId] = {
      capabilityId,
      support: 'unknown',
      verification: 'unverified',
      source: 'fallback'
    }
  }
  return { runtimeId: 'grok', observedAt: '2026-08-17T10:00:00.000Z', capabilities }
}

function createClock(): () => string {
  let second = 0
  return () => `2026-08-17T10:00:${String(second++).padStart(2, '0')}.000Z`
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createManualScheduler(): {
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clear: (timer: ReturnType<typeof setTimeout>) => void
  pendingDelays: () => number[]
  runNext: (delayMs: number) => Promise<void>
} {
  interface ScheduledEntry {
    callback: () => void
    delayMs: number
    cleared: boolean
    ran: boolean
  }
  const entries: ScheduledEntry[] = []
  const schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const entry: ScheduledEntry = { callback, delayMs, cleared: false, ran: false }
    entries.push(entry)
    return entry as unknown as ReturnType<typeof setTimeout>
  }
  const clear = (timer: ReturnType<typeof setTimeout>): void => {
    ;(timer as unknown as ScheduledEntry).cleared = true
  }
  return {
    schedule,
    clear,
    pendingDelays: () =>
      entries.filter((entry) => !entry.cleared && !entry.ran).map((entry) => entry.delayMs),
    runNext: async (delayMs) => {
      const entry = entries.find(
        (candidate) => !candidate.cleared && !candidate.ran && candidate.delayMs === delayMs
      )
      if (!entry) throw new Error(`未找到 ${delayMs}ms 的测试定时器。`)
      entry.ran = true
      entry.callback()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

process.on('exit', () => {
  for (const directory of temporaryDirectories) void rm(directory, { recursive: true, force: true })
})

async function initGitRepo(dir: string): Promise<void> {
  try {
    await runGit(dir, ['init', '-b', 'main'])
  } catch {
    await runGit(dir, ['init'])
  }
  await runGit(dir, ['config', 'user.email', 'baseline-test@example.test'])
  await runGit(dir, ['config', 'user.name', 'Baseline Test'])
  await runGit(dir, ['config', 'commit.gpgsign', 'false'])
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    }
  })
  return stdout.trim()
}

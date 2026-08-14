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
  AgentRuntimePermissionRequest,
  AgentRuntimePermissionResolution,
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
import { PermissionAuditStore } from '../security/permission-audit-store'
import { PermissionBroker } from '../security/permission-broker'
import { createLocalEnvironmentId } from '../security/permission-policy'

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

  it('允许一次只转发一次，错误身份与重复响应均幂等忽略', async () => {
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'])
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    try {
      const execution = fixture.service.startTurn(fixture.taskId, '等待权限')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledTimes(1))

      const permission = permissionRequest(
        fixture.taskId,
        'turn-a1',
        'runtime-session-1',
        'runtime-request-1'
      )
      fixture.service.handlePermissionRequest(permission)
      const approval = await waitForApproval(fixture.approvals, 0)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('waiting-permission')

      await fixture.service.respondPermission({
        approvalId: approval.approvalId,
        taskId: 'wrong-task',
        turnId: approval.turnId,
        decision: 'allow-once'
      })
      expect(fixture.adapter.respondPermission).not.toHaveBeenCalled()

      const response = {
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        turnId: approval.turnId,
        decision: 'allow-once' as const
      }
      await fixture.service.respondPermission(response)
      await fixture.service.respondPermission(response)

      expect(fixture.adapter.respondPermission).toHaveBeenCalledOnce()
      expect(fixture.adapter.respondPermission).toHaveBeenCalledWith(
        'runtime-request-1',
        'allow-once'
      )
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('running')

      turnResult.resolve({ outcome: 'completed' })
      await expect(execution).resolves.toMatchObject({ outcome: 'completed' })
    } finally {
      await fixture.dispose()
    }
  })

  it('两个并发审批会独立收敛，最后一个结束后才恢复 running', async () => {
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'])
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    try {
      const execution = fixture.service.startTurn(fixture.taskId, '并发等待权限')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())

      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-1',
          'src/first.ts'
        )
      )
      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-2',
          'src/second.ts'
        )
      )
      const firstApproval = await waitForApproval(fixture.approvals, 0)
      const secondApproval = await waitForApproval(fixture.approvals, 1)
      expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(2)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('waiting-permission')

      await fixture.service.respondPermission({
        approvalId: firstApproval.approvalId,
        taskId: firstApproval.taskId,
        turnId: firstApproval.turnId,
        decision: 'allow-once'
      })
      expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(1)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('waiting-permission')

      await fixture.service.respondPermission({
        approvalId: secondApproval.approvalId,
        taskId: secondApproval.taskId,
        turnId: secondApproval.turnId,
        decision: 'allow-once'
      })
      expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(0)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('running')
      expect(fixture.adapter.respondPermission.mock.calls).toEqual(
        expect.arrayContaining([
          ['runtime-request-1', 'allow-once'],
          ['runtime-request-2', 'allow-once']
        ])
      )
      expect(fixture.adapter.respondPermission).toHaveBeenCalledTimes(2)

      turnResult.resolve({ outcome: 'completed' })
      await execution
    } finally {
      await fixture.dispose()
    }
  })

  it('AgentService 不能越过 Broker 队首允许后续 Runtime 请求', async () => {
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'])
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    try {
      const execution = fixture.service.startTurn(fixture.taskId, '验证主进程 FIFO')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-first',
          'src/first.ts'
        )
      )
      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-second',
          'src/second.ts'
        )
      )
      const first = await waitForApproval(fixture.approvals, 0)
      const second = await waitForApproval(fixture.approvals, 1)

      await fixture.service.respondPermission({
        approvalId: second.approvalId,
        taskId: second.taskId,
        turnId: second.turnId,
        decision: 'allow-once'
      })
      expect(fixture.adapter.respondPermission).not.toHaveBeenCalled()
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('waiting-permission')

      await fixture.service.respondPermission({
        approvalId: first.approvalId,
        taskId: first.taskId,
        turnId: first.turnId,
        decision: 'deny'
      })
      await fixture.service.respondPermission({
        approvalId: second.approvalId,
        taskId: second.taskId,
        turnId: second.turnId,
        decision: 'allow-once'
      })
      expect(fixture.adapter.respondPermission.mock.calls).toEqual([
        ['runtime-request-first', 'deny-once'],
        ['runtime-request-second', 'allow-once']
      ])

      turnResult.resolve({ outcome: 'completed' })
      await execution
      await vi.waitFor(() =>
        expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(0)
      )
    } finally {
      await fixture.dispose()
    }
  })

  it('ToolCall 终态精确撤销目标审批，晚到 allow-task 不执行也不注册 grant', async () => {
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'])
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    try {
      const execution = fixture.service.startTurn(fixture.taskId, '精确撤销权限')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
      const firstRequest = permissionRequest(
        fixture.taskId,
        'turn-a1',
        'runtime-session-1',
        'runtime-request-cancelled'
      )
      fixture.service.handlePermissionRequest(firstRequest)
      const approval = await waitForApproval(fixture.approvals, 0)

      fixture.service.handlePermissionCancellation({
        requestId: firstRequest.requestId,
        runtimeId: firstRequest.runtimeId,
        taskId: firstRequest.taskId,
        turnId: firstRequest.turnId,
        runtimeSessionId: firstRequest.runtimeSessionId,
        toolCallId: firstRequest.toolCallId
      })
      await vi.waitFor(() =>
        expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(0)
      )
      await fixture.service.respondPermission({
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        turnId: approval.turnId,
        decision: 'allow-task'
      })
      expect(fixture.adapter.respondPermission.mock.calls).toEqual([
        ['runtime-request-cancelled', 'cancelled']
      ])

      const secondRequest = {
        ...permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-after-cancel'
        ),
        parameterFingerprint: firstRequest.parameterFingerprint
      }
      fixture.service.handlePermissionRequest(secondRequest)
      await expect(waitForApproval(fixture.approvals, 1)).resolves.toMatchObject({
        taskId: fixture.taskId
      })

      turnResult.resolve({ outcome: 'completed' })
      await execution
    } finally {
      await fixture.dispose()
    }
  })

  it('Turn 终态会取消未决审批，晚到允许不会重新执行', async () => {
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'])
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    try {
      const execution = fixture.service.startTurn(fixture.taskId, '终态收束权限')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-terminal'
        )
      )
      const approval = await waitForApproval(fixture.approvals, 0)

      turnResult.resolve({ outcome: 'completed' })
      await execution
      await vi.waitFor(() =>
        expect(fixture.adapter.respondPermission).toHaveBeenCalledWith(
          'runtime-request-terminal',
          'cancelled'
        )
      )
      expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(0)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId)).toMatchObject({
        state: 'completed',
        lastTurnId: 'turn-a1'
      })

      await fixture.service.respondPermission({
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        turnId: approval.turnId,
        decision: 'allow-once'
      })
      expect(fixture.adapter.respondPermission).toHaveBeenCalledOnce()
    } finally {
      await fixture.dispose()
    }
  })

  it('断开会取消活动 Turn 与未决审批，并清理选中会话', async () => {
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'])
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    try {
      const execution = fixture.service.startTurn(fixture.taskId, '断开时收束权限')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledOnce())
      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-disconnect'
        )
      )
      await waitForApproval(fixture.approvals, 0)

      await fixture.service.disconnect()
      await vi.waitFor(() =>
        expect(fixture.adapter.respondPermission).toHaveBeenCalledWith(
          'runtime-request-disconnect',
          'cancelled'
        )
      )
      expect(fixture.adapter.cancelTurn).not.toHaveBeenCalled()
      expect(fixture.controller.getActiveTurn()).toBeNull()
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('cancelled')
      expect(fixture.service.getSelectedTaskId()).toBeNull()

      turnResult.resolve({ outcome: 'cancelled' })
      await execution
    } finally {
      await fixture.dispose()
    }
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

  it('旧 Turn 终态不覆盖新 Turn，错误 session/runtime 的权限请求失败关闭', async () => {
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1', 'turn-a2'])
    try {
      await fixture.service.startTurn(fixture.taskId, '第一轮')

      const secondResult = deferred<AgentRuntimeTurnResult>()
      fixture.adapter.startTurn.mockImplementationOnce(() => secondResult.promise)
      const secondExecution = fixture.service.startTurn(fixture.taskId, '第二轮')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledTimes(2))

      fixture.service.handleRuntimeEvent({
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        capabilityState: 'native',
        taskId: fixture.taskId,
        turnId: 'turn-a1',
        sequence: 99,
        observedAt: '2026-08-11T00:00:00.000Z',
        kind: 'turn-complete',
        outcome: 'failed'
      })
      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a2',
          'wrong-session',
          'runtime-request-wrong-session'
        )
      )
      fixture.service.handlePermissionRequest({
        ...permissionRequest(
          fixture.taskId,
          'turn-a2',
          'runtime-session-1',
          'runtime-request-wrong-runtime'
        ),
        runtimeId: 'codex'
      })

      expect(fixture.approvals).toHaveLength(0)
      expect(fixture.adapter.respondPermission.mock.calls).toEqual([
        ['runtime-request-wrong-session', 'cancelled'],
        ['runtime-request-wrong-runtime', 'cancelled']
      ])
      expect(fixture.service.getTaskRuntimeState(fixture.taskId)).toMatchObject({
        state: 'running',
        activeTurnId: 'turn-a2'
      })

      secondResult.resolve({ outcome: 'completed' })
      await secondExecution
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('completed')
    } finally {
      await fixture.dispose()
    }
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
  readonly respondPermission = vi.fn<
    (requestId: string, resolution: AgentRuntimePermissionResolution) => void
  >((): void => undefined)

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
  runtimeSessionId: string,
  requestId: string,
  target = 'src/example.ts'
): AgentRuntimePermissionRequest {
  return {
    requestId,
    runtimeId: 'grok',
    taskId,
    turnId,
    runtimeSessionId,
    toolCallId: `tool-${requestId}`,
    operationType: 'write-file',
    targets: [{ kind: 'path', value: target }],
    parameterFingerprint: `write:${requestId}`,
    title: '写入测试文件',
    impact: '会修改当前 Project 内的文件。',
    executionSupported: true
  }
}

interface PermissionServiceFixture {
  adapter: FakeRuntimeAdapter
  broker: PermissionBroker
  controller: TaskExecutionController
  service: AgentService
  taskId: string
  approvals: AgentPermissionRequest[]
  dispose: () => Promise<void>
}

/**
 * 使用真实临时 ProjectRegistry/TaskStore 绑定 Task 身份，
 * 避免用绕过 projectId 与持久化边界的假审批制造虚假绿灯。
 */
async function createPermissionServiceFixture(ids: string[]): Promise<PermissionServiceFixture> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'agent-service-permission-'))
  const projectPath = join(userDataPath, 'project')
  await mkdir(projectPath)
  const registry = new ProjectRegistry({
    userDataPath,
    createId: () => 'project-1',
    now: () => '2026-08-12T00:00:00.000Z'
  })
  await registry.initialize()
  const project = await registry.register(projectPath)
  const taskStore = new TaskStore({ projectRegistry: registry })
  await taskStore.initialize()
  const approvals: AgentPermissionRequest[] = []
  let brokerId = 0
  const auditStore = new PermissionAuditStore({
    projectRegistry: registry,
    getTaskIdentity: (taskId) => {
      const task = taskStore.getTaskRecord(taskId)
      return { taskId: task.taskId, projectId: task.projectId }
    },
    createId: () => `quarantine-${++brokerId}`
  })
  const broker = new PermissionBroker({
    auditStore,
    onApproval: (approval) => {
      approvals.push(approval)
      return true
    },
    resolveIntentContext: (taskId, turnId) => {
      try {
        const task = taskStore.getTaskRecord(taskId)
        return {
          taskId: task.taskId,
          turnId: task.activeTurnId ?? '',
          projectId: task.projectId,
          executionRoot: task.environment.rootSnapshot,
          environmentId: createLocalEnvironmentId(task.projectId, task.environment.rootSnapshot),
          runtimeId: task.runtimeId,
          environmentKind: 'local' as const,
          active:
            task.activeTurnId === turnId &&
            (task.state === 'running' || task.state === 'waiting-permission')
        }
      } catch {
        return null
      }
    },
    createId: () => `broker-${++brokerId}`,
    now: () => Date.parse('2026-08-12T00:00:00.000Z')
  })
  const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
  const controller = new TaskExecutionController()
  let idIndex = 0
  let clock = 0
  const service = new AgentService(adapter, controller, {
    createId: () => ids[idIndex++] ?? `unexpected-id-${idIndex}`,
    now: () => new Date(Date.UTC(2026, 7, 12, 0, 0, clock++)).toISOString(),
    projectRegistry: registry,
    taskStore,
    permissionBroker: broker
  })
  await service.connect(project.projectId)
  const task = await service.createTask(project.projectId)

  return {
    adapter,
    broker,
    controller,
    service,
    taskId: task.taskId,
    approvals,
    dispose: async () => {
      await broker.shutdown()
      await rm(userDataPath, { recursive: true, force: true })
    }
  }
}

/** 等待 Broker 完成路径规范化并登记产品级审批。 */
async function waitForApproval(
  approvals: AgentPermissionRequest[],
  index: number
): Promise<AgentPermissionRequest> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const approval = approvals[index]
    if (approval) return approval
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('审批未在预期时间内登记。')
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

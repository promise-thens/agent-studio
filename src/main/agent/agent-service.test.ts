import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AgentPermissionRequest,
  AgentRuntimeCapabilitySnapshot,
  AgentRuntimeStatus,
  AgentTaskRuntimeState
} from '../../shared/agent'
import { resolveTakeoverHudCopy } from '../../shared/task-takeover'
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
import { AgentService, AgentServiceError, type AgentServiceOptions } from './agent-service'
import { OperationGate } from './operation-gate'
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
    expect(adapter.resumeSession).toHaveBeenCalledWith(
      {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        workspace: WORKSPACE
      },
      'task-a',
      []
    )
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
      expect.objectContaining({ runtimeSessionId: 'runtime-session-1' }),
      'task-a',
      []
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
      expect.objectContaining({ runtimeSessionId: 'runtime-session-1' }),
      'task-a',
      []
    )

    const blockedAdapter = new FakeRuntimeAdapter({ resume: false, load: false })
    const blockedService = createService(blockedAdapter, ['task-a', 'task-b', 'turn-a'])
    const blockedTaskA = await blockedService.createTask(WORKSPACE)
    await blockedService.createTask(WORKSPACE)

    await expect(
      blockedService.startTurn(blockedTaskA.taskId, '不能串错上下文')
    ).resolves.toMatchObject({
      taskId: blockedTaskA.taskId,
      turnId: 'turn-a'
    })
    expect(blockedAdapter.createSession).toHaveBeenCalledTimes(3)
    expect(blockedAdapter.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeSessionId: 'runtime-session-3' })
    )
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
        expect.objectContaining({ runtimeSessionId: 'persisted-session' }),
        'task-1',
        []
      )
      expect(adapter.loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeSessionId: 'persisted-session' }),
        'task-1',
        []
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
      expect.objectContaining({ runtimeSessionId: 'runtime-session-1' }),
      'task-a',
      []
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

  it('拒绝 foreign、stale 与错误类型的 inherited lease，且不触发 Runtime 副作用', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const gate = new OperationGate()
    const foreignGate = new OperationGate()
    const service = createService(adapter, [], new TaskExecutionController(), gate)

    const foreign = foreignGate.acquireProviderMutation()
    await expect(service.connect(WORKSPACE, foreign)).rejects.toMatchObject({
      code: 'invalid-state'
    })
    expect(adapter.connect).not.toHaveBeenCalled()

    const stale = gate.acquireProviderMutation()
    expect(stale.release()).toBe(true)
    await expect(service.connect(WORKSPACE, stale)).rejects.toMatchObject({
      code: 'invalid-state'
    })

    const admission = gate.acquireExecutionAdmission()
    await expect(service.connect(WORKSPACE, admission)).rejects.toMatchObject({
      code: 'invalid-state'
    })
    expect(adapter.connect).not.toHaveBeenCalled()
    expect(admission.release()).toBe(true)
    expect(foreign.release()).toBe(true)
  })

  it('inherited Provider 与 execution lease 无论成功失败都由外层释放', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const gate = new OperationGate()
    const service = createService(adapter, [], new TaskExecutionController(), gate)

    const providerLease = gate.acquireProviderMutation()
    await expect(service.connect(WORKSPACE, providerLease)).resolves.toMatchObject({
      state: 'ready'
    })
    expect(gate.ownsCurrentLease(providerLease)).toBe(true)
    expect(gate.getState()).toBe('provider-mutation')
    expect(providerLease.release()).toBe(true)

    const admission = gate.acquireExecutionAdmission()
    const executionLease = admission.activate()
    if (!executionLease) throw new Error('测试需要 execution-active lease。')
    adapter.connect.mockRejectedValueOnce(
      new AgentRuntimeAdapterError('operation-failed', '模拟连接失败。')
    )
    await expect(service.connect(WORKSPACE, executionLease)).rejects.toMatchObject({
      code: 'operation-failed'
    })
    expect(gate.ownsCurrentLease(executionLease)).toBe(true)
    expect(gate.getState()).toBe('execution-active')
    expect(executionLease.release()).toBe(true)
  })

  it('自持 session lease 在成功与异常后都恢复 Gate 空闲', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const gate = new OperationGate()
    const service = createService(adapter, [], new TaskExecutionController(), gate)

    await expect(service.connect(WORKSPACE)).resolves.toMatchObject({ state: 'ready' })
    expect(gate.getState()).toBe('idle')

    adapter.connect.mockRejectedValueOnce(
      new AgentRuntimeAdapterError('operation-failed', '模拟连接失败。')
    )
    await expect(service.connect(WORKSPACE)).rejects.toMatchObject({ code: 'operation-failed' })
    expect(gate.getState()).toBe('idle')
  })

  it('shutdown latch 后即使 inherited lease 仍 current 也不再调用 Runtime', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const gate = new OperationGate()
    const service = createService(adapter, [], new TaskExecutionController(), gate)
    const lease = gate.acquireProviderMutation()
    gate.beginShutdown()

    await expect(service.connect(WORKSPACE, lease)).rejects.toMatchObject({ code: 'invalid-state' })
    expect(adapter.connect).not.toHaveBeenCalled()
  })

  it('写入共享记忆树时自动允许，不弹出项目外审批', async () => {
    const memoryRoot = await mkdtemp(join(tmpdir(), 'agent-service-memory-'))
    await writeFile(join(memoryRoot, 'MEMORY.md'), '# Global Memory\n', 'utf8')
    const canonicalMemory = await realpath(memoryRoot)
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'], {
      getTrustedExternalRoots: () => [canonicalMemory]
    })
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementationOnce(() => turnResult.promise)
    try {
      const execution = fixture.service.startTurn(fixture.taskId, '/remember 我叫胡大帅')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalledTimes(1))
      fixture.service.handlePermissionRequest(
        permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-memory',
          join(canonicalMemory, 'MEMORY.md')
        )
      )
      await vi.waitFor(() =>
        expect(fixture.adapter.respondPermission).toHaveBeenCalledWith(
          'runtime-request-memory',
          'allow-once'
        )
      )
      expect(fixture.approvals).toHaveLength(0)
      turnResult.resolve({ outcome: 'completed' })
      await expect(execution).resolves.toMatchObject({ outcome: 'completed' })
    } finally {
      await fixture.dispose()
      await rm(memoryRoot, { recursive: true, force: true })
    }
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
      await vi.waitFor(() =>
        expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(2)
      )
      expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('waiting-permission')

      await fixture.service.respondPermission({
        approvalId: firstApproval.approvalId,
        taskId: firstApproval.taskId,
        turnId: firstApproval.turnId,
        decision: 'allow-once'
      })
      expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(1)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).state).toBe('waiting-permission')
      const secondApproval = await waitForUniqueApproval(fixture.approvals, 1)

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
      fixture.service.handlePermissionRequest({
        ...permissionRequest(
          fixture.taskId,
          'turn-a1',
          'runtime-session-1',
          'runtime-request-second',
          'src/second.ts'
        ),
        operationType: 'delete-path',
        parameterFingerprint: 'delete:runtime-request-second'
      })
      const first = await waitForApproval(fixture.approvals, 0)
      await vi.waitFor(() =>
        expect(fixture.broker.getPendingCount(fixture.taskId, 'turn-a1')).toBe(2)
      )
      expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)

      await fixture.service.respondPermission({
        approvalId: 'broker-not-head',
        taskId: first.taskId,
        turnId: first.turnId,
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
      const second = await waitForUniqueApproval(fixture.approvals, 1)
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

  it('点进历史走 enterTask：恢复失败不抛错，晚到 resume 不得绑错 Task', async () => {
    const fixture = await createHistoryServiceFixture(['task-a', 'task-b', 'turn-a'])
    try {
      const taskA = await fixture.service.createTask(fixture.project.projectId)
      const taskB = await fixture.service.createTask(fixture.project.projectId)
      const resumeStarted = deferred<void>()
      const releaseFirstResume = deferred<void>()
      let resumeCalls = 0
      fixture.adapter.resumeSession.mockImplementation(async (session) => {
        resumeCalls += 1
        if (resumeCalls === 1) {
          resumeStarted.resolve()
          await releaseFirstResume.promise
        }
        fixture.adapter.assignSession(session)
      })

      const firstEnter = fixture.service.enterTask(taskA.taskId)
      await resumeStarted.promise
      const secondEnter = fixture.service.enterTask(taskB.taskId)
      releaseFirstResume.resolve()
      const [firstResult, secondResult] = await Promise.all([firstEnter, secondEnter])

      expect(firstResult).toMatchObject({
        taskId: taskA.taskId,
        historyReady: true,
        restore: 'idle'
      })
      expect(secondResult).toMatchObject({
        taskId: taskB.taskId,
        historyReady: true,
        restore: 'ready',
        method: 'resume',
        verification: 'declared'
      })
      expect(JSON.stringify(firstResult)).not.toContain('runtimeSessionId')
      expect(JSON.stringify(secondResult)).not.toContain('runtimeSessionId')
      expect(fixture.service.getSelectedTaskId()).toBe(taskB.taskId)
    } finally {
      await fixture.dispose()
    }
  })

  it('enterTask 在 Project 不可用或恢复能力缺失时不打断浏览，发送时同 Task 重建 session', async () => {
    const missingRoot = await createHistoryServiceFixture(['task-a'])
    try {
      const task = await missingRoot.service.createTask(missingRoot.project.projectId)
      await rm(missingRoot.project.canonicalRoot, { recursive: true, force: true })
      await expect(missingRoot.service.enterTask(task.taskId)).resolves.toMatchObject({
        taskId: task.taskId,
        historyReady: true,
        restore: 'unavailable'
      })
      expect(missingRoot.adapter.resumeSession).not.toHaveBeenCalled()
    } finally {
      await missingRoot.dispose()
    }

    const rebuild = await createHistoryServiceFixture(['task-a', 'turn-a'], {
      resume: false,
      load: false
    })
    try {
      const task = await rebuild.service.createTask(rebuild.project.projectId)
      await rebuild.service.disconnect()
      const entered = await rebuild.service.enterTask(task.taskId)
      expect(entered).toMatchObject({
        taskId: task.taskId,
        restore: 'degraded',
        verification: 'unverified'
      })
      expect(rebuild.adapter.resumeSession).not.toHaveBeenCalled()

      await expect(rebuild.service.startTurn(task.taskId, '接着聊')).resolves.toMatchObject({
        taskId: task.taskId,
        turnId: 'turn-a'
      })
      expect(rebuild.adapter.createSession).toHaveBeenCalledTimes(2)
      expect(rebuild.store.getTaskRecord(task.taskId).runtimeSession.runtimeSessionId).toBe(
        'runtime-session-2'
      )
      expect(JSON.stringify(rebuild.service.getTaskRuntimeState(task.taskId))).not.toContain(
        'runtimeSessionId'
      )
    } finally {
      await rebuild.dispose()
    }
  })

  it('Adapter 进程已死后 enterTask 不会因 selectedTaskId 短路而假成功', async () => {
    const fixture = await createHistoryServiceFixture(['task-a'])
    try {
      const task = await fixture.service.createTask(fixture.project.projectId)
      expect(fixture.service.getSelectedTaskId()).toBe(task.taskId)
      await fixture.adapter.disconnect()

      await expect(fixture.service.enterTask(task.taskId)).resolves.toMatchObject({
        taskId: task.taskId,
        restore: 'ready',
        method: 'resume'
      })
      expect(fixture.adapter.connect).toHaveBeenCalledWith(fixture.project.canonicalRoot)
      expect(fixture.adapter.resumeSession).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeSessionId: 'runtime-session-1' }),
        task.taskId,
        []
      )
    } finally {
      await fixture.dispose()
    }
  })

  it('创建 Task 成功后立刻捕获变更基线，失败不得回滚 Task', async () => {
    const ensureChangeBaseline = vi.fn(async () => undefined)
    const fixture = await createHistoryServiceFixture(
      ['task-a'],
      { resume: true, load: true },
      { ensureChangeBaseline }
    )
    try {
      const task = await fixture.service.createTask(fixture.project.projectId)
      expect(ensureChangeBaseline).toHaveBeenCalledWith({
        taskId: task.taskId,
        projectId: fixture.project.projectId,
        environmentId: createLocalEnvironmentId(
          fixture.project.projectId,
          fixture.project.canonicalRoot
        ),
        executionRoot: fixture.project.canonicalRoot
      })
      expect(fixture.store.getTaskRecord(task.taskId).taskId).toBe(task.taskId)
    } finally {
      await fixture.dispose()
    }

    const failingEnsure = vi.fn(async () => {
      throw new Error('baseline-unavailable')
    })
    const failing = await createHistoryServiceFixture(
      ['task-b'],
      { resume: true, load: true },
      { ensureChangeBaseline: failingEnsure }
    )
    try {
      const task = await failing.service.createTask(failing.project.projectId)
      expect(failingEnsure).toHaveBeenCalledOnce()
      expect(failing.store.getTaskRecord(task.taskId).taskId).toBe(task.taskId)
    } finally {
      await failing.dispose()
    }
  })

  it('createSession 期间到达的命令快照在 createTask 返回后仍可读取', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    adapter.createSession.mockImplementation(async (context) => {
      service.handleAvailableCommands({
        taskId: context.taskId,
        revision: 1,
        commands: [{ name: 'compact', description: '压缩上下文' }]
      })
      return {
        runtimeId: 'grok',
        runtimeSessionId: 'runtime-session-1',
        workspace: context.workspace
      }
    })

    const task = await service.createTask(WORKSPACE)

    expect(service.getAvailableCommands(task.taskId)).toEqual({
      taskId: 'task-a',
      revision: 1,
      commands: [{ name: 'compact', description: '压缩上下文' }]
    })
  })

  it('createSession 失败时丢弃期间登记的命令快照', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    adapter.createSession.mockImplementation(async (context) => {
      service.handleAvailableCommands({
        taskId: context.taskId,
        revision: 1,
        commands: [{ name: 'compact', description: '压缩上下文' }]
      })
      throw new AgentRuntimeAdapterError('operation-failed', '创建 Runtime 会话失败')
    })

    await expect(service.createTask(WORKSPACE)).rejects.toMatchObject({
      code: 'operation-failed'
    })

    try {
      service.getAvailableCommands('task-a')
      throw new Error('expected AgentServiceError')
    } catch (error) {
      expect(error).toEqual(new AgentServiceError('task-not-found', '未找到指定 Task。'))
    }
  })

  it('createTask 后尚未收到快照时返回 revision 0 空列表', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)

    expect(service.getAvailableCommands(task.taskId)).toEqual({
      taskId: 'task-a',
      revision: 0,
      commands: []
    })
  })

  it('命令快照按 taskId 保存，较新 revision 覆盖、较旧或相同则忽略', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a', 'task-b'])
    const taskA = await service.createTask(WORKSPACE)
    const taskB = await service.createTask(WORKSPACE)

    service.handleAvailableCommands({
      taskId: taskA.taskId,
      revision: 1,
      commands: [{ name: 'compact', description: '压缩' }]
    })
    service.handleAvailableCommands({
      taskId: taskA.taskId,
      revision: 1,
      commands: [{ name: 'stale-same', description: '同修订不应覆盖' }]
    })
    service.handleAvailableCommands({
      taskId: taskA.taskId,
      revision: 0,
      commands: [{ name: 'stale-old', description: '更旧不应覆盖' }]
    })
    service.handleAvailableCommands({
      taskId: taskA.taskId,
      revision: 2,
      commands: [{ name: 'dream', description: '整理记忆', inputHint: '主题' }]
    })

    expect(service.getAvailableCommands(taskA.taskId)).toEqual({
      taskId: 'task-a',
      revision: 2,
      commands: [{ name: 'dream', description: '整理记忆', inputHint: '主题' }]
    })
    expect(service.getAvailableCommands(taskB.taskId)).toEqual({
      taskId: 'task-b',
      revision: 0,
      commands: []
    })
  })

  it('未知 Task 的快照推送被忽略，读取则按邻近风格拒绝', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)

    service.handleAvailableCommands({
      taskId: 'unknown-task',
      revision: 1,
      commands: [{ name: 'compact', description: '压缩' }]
    })
    expect(service.getAvailableCommands(task.taskId)).toEqual({
      taskId: 'task-a',
      revision: 0,
      commands: []
    })

    try {
      service.getAvailableCommands('unknown-task')
      throw new Error('expected AgentServiceError')
    } catch (error) {
      expect(error).toEqual(new AgentServiceError('task-not-found', '未找到指定 Task。'))
    }

    try {
      service.getAvailableCommands('')
      throw new Error('expected AgentServiceError')
    } catch (error) {
      expect(error).toEqual(new AgentServiceError('invalid-input', 'Task ID 无效。'))
    }
  })

  it('createTask 默认未接管，createSession 不传 takeoverEnabled 键', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    expect(task.takeoverEnabled).toBe(false)
    expect(task.permissionPromptStyle).toBe('assist')
    expect(task.takeoverApplied).toBe(false)
    expect(task).not.toHaveProperty('takeoverUpdatedAt')
    expect(adapter.createSession).toHaveBeenCalledTimes(1)
    expect(adapter.createSession.mock.calls[0]?.[0]).toEqual({
      workspace: WORKSPACE,
      taskId: 'task-a',
      mcpServers: []
    })
    expect(adapter.createSession.mock.calls[0]?.[0]).not.toHaveProperty('takeoverEnabled')
  })

  it('恢复快照接管后，resume 失败重建 session 才传入 takeoverEnabled: true', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'agent-service-takeover-'))
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
        capabilitySnapshot: restoreSnapshot({ resume: false, load: false })
      })
      const taskPath = join(
        registry.getProjectDirectory(project.projectId),
        'tasks/task-1/task.json'
      )
      const disk = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>
      disk.takeoverEnabled = true
      disk.takeoverUpdatedAt = '2026-08-31T00:00:00.000Z'
      await writeFile(taskPath, JSON.stringify(disk))

      const restoredStore = new TaskStore({ projectRegistry: registry })
      await restoredStore.initialize()
      const adapter = new FakeRuntimeAdapter({ resume: false, load: false })
      adapter.primeWorkspace(project.canonicalRoot)
      const service = new AgentService(adapter, new TaskExecutionController(), {
        projectRegistry: registry,
        taskStore: restoredStore,
        operationGate: new OperationGate(),
        createId: () => 'turn-1'
      })

      expect(service.getTaskRuntimeState('task-1')).toMatchObject({
        takeoverEnabled: true,
        takeoverUpdatedAt: '2026-08-31T00:00:00.000Z'
      })

      await service.startTurn('task-1', '重建')
      expect(adapter.createSession).toHaveBeenCalledWith({
        workspace: project.canonicalRoot,
        taskId: 'task-1',
        mcpServers: [],
        takeoverEnabled: true
      })
    } finally {
      await rm(userDataPath, { recursive: true, force: true })
    }
  })

  it('未确认的 takeover 抛 invalid-input', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    await expect(
      service.setPermissionMode({ taskId: task.taskId, mode: 'takeover' })
    ).rejects.toEqual(new AgentServiceError('invalid-input', '打开完全接管前必须确认。'))
    expect(service.getTaskRuntimeState(task.taskId).takeoverEnabled).toBe(false)
    expect(adapter.startTurn).not.toHaveBeenCalled()
  })

  it('活动 Turn 期间不能切换批准模式', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const turn = deferred<AgentRuntimeTurnResult>()
    const dispatched = deferred<void>()
    adapter.startTurn.mockImplementationOnce(async () => {
      dispatched.resolve()
      return turn.promise
    })
    const controller = new TaskExecutionController()
    const service = createService(adapter, ['task-a', 'turn-1'], controller)
    const task = await service.createTask(WORKSPACE)
    const running = service.startTurn(task.taskId, '执行中')
    await dispatched.promise
    await expect(service.setPermissionMode({ taskId: task.taskId, mode: 'ask' })).rejects.toEqual(
      new AgentServiceError('invalid-state', '任务执行中不能切换批准模式。')
    )
    turn.resolve({ outcome: 'completed' })
    await running
  })

  it('普通 set assist 成功且不发接管命令', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    const result = await service.setPermissionMode({ taskId: task.taskId, mode: 'assist' })
    expect(result.task.permissionPromptStyle).toBe('assist')
    expect(result.task.takeoverEnabled).toBe(false)
    expect(result.decision).toEqual({ kind: 'noop' })
    expect(result.controlPrompt).toBeUndefined()
    expect(adapter.startTurn).not.toHaveBeenCalled()
  })

  it('有 session + 广告 + idle 时 enable 返回 controlPrompt /always-approve', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    service.handleAvailableCommands({
      taskId: task.taskId,
      revision: 1,
      commands: [{ name: 'always-approve', description: '完全接管' }]
    })
    const result = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    expect(result.decision).toEqual({ kind: 'send-command', commandName: 'always-approve' })
    expect(result.controlPrompt).toBe('/always-approve')
    expect(result.task.takeoverEnabled).toBe(true)
    expect(result.task.takeoverApplied).toBe(false)
    expect(adapter.startTurn).not.toHaveBeenCalled()
    // send-command 已占 in-flight，禁止广告补发再 begin 一次。
    expect(service.beginTakeoverControlPrompt(task.taskId)).toBeNull()
    const startTurn = vi.fn(async () => undefined)
    await service.runTakeoverControlPrompt(task.taskId, result.controlPrompt!, startTurn)
    expect(startTurn).toHaveBeenCalledWith(task.taskId, '/always-approve')
    expect(service.getTaskRuntimeState(task.taskId).takeoverApplied).toBe(true)
    expect(service.beginTakeoverControlPrompt(task.taskId)).toBeNull()
    expect(adapter.startTurn).not.toHaveBeenCalled()
  })

  it('关接管入队失败后可重发关闭命令，再开接管不得再 toggle', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    service.handleAvailableCommands({
      taskId: task.taskId,
      revision: 1,
      commands: [{ name: 'always-approve', description: '完全接管' }]
    })
    const enabled = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    await service.runTakeoverControlPrompt(
      task.taskId,
      enabled.controlPrompt!,
      async () => undefined
    )

    const disabled = await service.setPermissionMode({ taskId: task.taskId, mode: 'assist' })
    await expect(
      service.runTakeoverControlPrompt(task.taskId, disabled.controlPrompt!, async () => {
        throw new Error('enqueue failed')
      })
    ).rejects.toThrow('enqueue failed')
    expect(service.getTaskRuntimeState(task.taskId).takeoverMayStillBeActive).toBe(true)

    const retried = await service.setPermissionMode({ taskId: task.taskId, mode: 'assist' })
    expect(retried.decision).toEqual({ kind: 'send-command', commandName: 'always-approve' })
    expect(retried.controlPrompt).toBe('/always-approve')
    service.abortTakeoverControlPrompt(task.taskId)

    const reopened = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    expect(reopened.decision).toEqual({ kind: 'noop' })
    expect(reopened.controlPrompt).toBeUndefined()
    expect(reopened.task.takeoverEnabled).toBe(true)
    expect(reopened.task.takeoverApplied).toBe(true)
    expect(reopened.task.takeoverMayStillBeActive).toBeUndefined()
    expect(adapter.startTurn).not.toHaveBeenCalled()
  })

  it('关接管入队成功后再选当前 assist 不得再 toggle', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    service.handleAvailableCommands({
      taskId: task.taskId,
      revision: 1,
      commands: [{ name: 'always-approve', description: '完全接管' }]
    })
    const enabled = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    await service.runTakeoverControlPrompt(
      task.taskId,
      enabled.controlPrompt!,
      async () => undefined
    )
    const disabled = await service.setPermissionMode({ taskId: task.taskId, mode: 'assist' })
    await service.runTakeoverControlPrompt(
      task.taskId,
      disabled.controlPrompt!,
      async () => undefined
    )
    expect(service.getTaskRuntimeState(task.taskId).takeoverMayStillBeActive).toBe(true)

    const retried = await service.setPermissionMode({ taskId: task.taskId, mode: 'assist' })
    expect(retried.decision).toEqual({ kind: 'noop' })
    expect(retried.controlPrompt).toBeUndefined()
    expect(retried.task.takeoverMayStillBeActive).toBe(true)

    const reopened = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    expect(reopened.decision).toEqual({ kind: 'send-command', commandName: 'always-approve' })
    expect(reopened.controlPrompt).toBe('/always-approve')
    expect(reopened.task.takeoverApplied).toBe(false)
  })

  it('内部控制 prompt 仍可入队 /always-approve，不走公开 startTurn 闸门', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    service.handleAvailableCommands({
      taskId: task.taskId,
      revision: 1,
      commands: [{ name: 'always-approve', description: '完全接管' }]
    })
    const enabled = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    const startTurn = vi.fn(async () => undefined)
    await service.runTakeoverControlPrompt(task.taskId, enabled.controlPrompt!, startTurn)
    expect(startTurn).toHaveBeenCalledWith(task.taskId, '/always-approve')
    expect(service.getTaskRuntimeState(task.taskId).takeoverApplied).toBe(true)
    expect(adapter.startTurn).not.toHaveBeenCalled()
  })

  it('从已 applied 的接管切到 assist 仍入队 /always-approve', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    service.handleAvailableCommands({
      taskId: task.taskId,
      revision: 1,
      commands: [{ name: 'always-approve', description: '完全接管' }]
    })
    const enabled = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    await service.runTakeoverControlPrompt(
      task.taskId,
      enabled.controlPrompt!,
      async () => undefined
    )
    expect(service.getTaskRuntimeState(task.taskId).takeoverApplied).toBe(true)

    const disabled = await service.setPermissionMode({ taskId: task.taskId, mode: 'assist' })
    expect(disabled.decision).toEqual({ kind: 'send-command', commandName: 'always-approve' })
    expect(disabled.controlPrompt).toBe('/always-approve')
    expect(disabled.task.takeoverEnabled).toBe(false)
    expect(disabled.task.takeoverMayStillBeActive).toBe(true)
    expect(service.beginTakeoverControlPrompt(task.taskId)).toBeNull()

    const startTurn = vi.fn(async () => undefined)
    await service.runTakeoverControlPrompt(task.taskId, disabled.controlPrompt!, startTurn)
    expect(startTurn).toHaveBeenCalledWith(task.taskId, '/always-approve')
    expect(service.getTaskRuntimeState(task.taskId).takeoverEnabled).toBe(false)
    expect(service.getTaskRuntimeState(task.taskId).takeoverMayStillBeActive).toBe(true)
  })

  it('control turn 入队期间不能再切批准模式', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    service.handleAvailableCommands({
      taskId: task.taskId,
      revision: 1,
      commands: [{ name: 'always-approve', description: '完全接管' }]
    })
    await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    await expect(
      service.setPermissionMode({ taskId: task.taskId, mode: 'assist' })
    ).rejects.toEqual(new AgentServiceError('invalid-state', '任务执行中不能切换批准模式。'))
    service.abortTakeoverControlPrompt(task.taskId)
  })

  it('广告晚到才交出 controlPrompt，且 start 失败保持未 applied 可重试', async () => {
    const adapter = new FakeRuntimeAdapter({ resume: true, load: true })
    const service = createService(adapter, ['task-a'])
    const task = await service.createTask(WORKSPACE)
    const enabled = await service.setPermissionMode({
      taskId: task.taskId,
      mode: 'takeover',
      confirmed: true
    })
    expect(enabled.decision).toEqual({ kind: 'defer-next-session', reason: 'command-unavailable' })
    expect(enabled.task.takeoverApplied).toBe(false)
    expect(service.beginTakeoverControlPrompt(task.taskId)).toBeNull()

    service.handleAvailableCommands({
      taskId: task.taskId,
      revision: 1,
      commands: [{ name: 'always-approve', description: '完全接管' }]
    })
    expect(service.beginTakeoverControlPrompt(task.taskId)).toBe('/always-approve')
    expect(service.getTaskRuntimeState(task.taskId).takeoverApplied).toBe(false)
    service.abortTakeoverControlPrompt(task.taskId)
    expect(service.getTaskRuntimeState(task.taskId).takeoverApplied).toBe(false)
    expect(service.beginTakeoverControlPrompt(task.taskId)).toBe('/always-approve')
    service.abortTakeoverControlPrompt(task.taskId)
  })

  it('仍收到 request_permission 时推送未完全生效 HUD', async () => {
    const runtimeSnapshots: AgentTaskRuntimeState[] = []
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'], {
      onTaskRuntimeState: (task) => runtimeSnapshots.push(task)
    })
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementation(() => turnResult.promise)
    try {
      fixture.service.handleAvailableCommands({
        taskId: fixture.taskId,
        revision: 1,
        commands: [{ name: 'always-approve', description: '完全接管' }]
      })
      await fixture.service.setPermissionMode({
        taskId: fixture.taskId,
        mode: 'takeover',
        confirmed: true
      })
      fixture.service.markTakeoverCommandDispatched(fixture.taskId)
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).takeoverApplied).toBe(true)

      const running = fixture.service.startTurn(fixture.taskId, '仍要权限')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalled())
      fixture.service.handlePermissionRequest(
        permissionRequest(fixture.taskId, 'turn-a1', 'runtime-session-1', 'runtime-request-hud')
      )
      await waitForApproval(fixture.approvals, 0)
      const afterPermission = fixture.service.getTaskRuntimeState(fixture.taskId)
      expect(afterPermission.takeoverEnabled).toBe(true)
      expect(afterPermission.takeoverApplied).toBe(false)
      expect(
        resolveTakeoverHudCopy({
          takeoverEnabled: afterPermission.takeoverEnabled,
          takeoverApplied: afterPermission.takeoverApplied,
          executing: true
        })
      ).toBe('接管未完全生效')
      expect(runtimeSnapshots.some((item) => item.takeoverApplied === false)).toBe(true)

      turnResult.resolve({ outcome: 'completed' })
      await running
    } finally {
      await fixture.dispose()
    }
  })

  it('关接管后见到 request_permission 会清掉「接管可能仍在」', async () => {
    const runtimeSnapshots: AgentTaskRuntimeState[] = []
    const fixture = await createPermissionServiceFixture(['task-a', 'turn-a1'], {
      onTaskRuntimeState: (task) => runtimeSnapshots.push(task)
    })
    const turnResult = deferred<AgentRuntimeTurnResult>()
    fixture.adapter.startTurn.mockImplementation(() => turnResult.promise)
    try {
      fixture.service.handleAvailableCommands({
        taskId: fixture.taskId,
        revision: 1,
        commands: [{ name: 'always-approve', description: '完全接管' }]
      })
      await fixture.service.setPermissionMode({
        taskId: fixture.taskId,
        mode: 'takeover',
        confirmed: true
      })
      fixture.service.markTakeoverCommandDispatched(fixture.taskId)
      await fixture.service.setPermissionMode({ taskId: fixture.taskId, mode: 'assist' })
      expect(fixture.service.getTaskRuntimeState(fixture.taskId).takeoverMayStillBeActive).toBe(
        true
      )

      const running = fixture.service.startTurn(fixture.taskId, '关接管后权限')
      await vi.waitFor(() => expect(fixture.adapter.startTurn).toHaveBeenCalled())
      fixture.service.handlePermissionRequest(
        permissionRequest(fixture.taskId, 'turn-a1', 'runtime-session-1', 'runtime-request-off')
      )
      await waitForApproval(fixture.approvals, 0)
      const afterOff = fixture.service.getTaskRuntimeState(fixture.taskId)
      expect(afterOff.takeoverEnabled).toBe(false)
      expect(afterOff.takeoverMayStillBeActive).toBeUndefined()
      expect(
        resolveTakeoverHudCopy({
          takeoverEnabled: afterOff.takeoverEnabled,
          takeoverApplied: afterOff.takeoverApplied,
          takeoverMayStillBeActive: afterOff.takeoverMayStillBeActive,
          executing: true
        })
      ).toBeNull()
      expect(runtimeSnapshots.some((item) => item.takeoverMayStillBeActive !== true)).toBe(true)
      turnResult.resolve({ outcome: 'completed' })
      await running
    } finally {
      await fixture.dispose()
    }
  })

  it('无 session 返回 new-session-meta 且不 startTurn', async () => {
    const fixture = await createHistoryServiceFixture(['task-a'])
    try {
      const created = await fixture.service.createTask(fixture.project.projectId)
      await fixture.service.disconnect()
      const result = await fixture.service.setPermissionMode({
        taskId: created.taskId,
        mode: 'takeover',
        confirmed: true
      })
      expect(result.decision).toEqual({ kind: 'new-session-meta' })
      expect(result.controlPrompt).toBeUndefined()
      expect(result.task.takeoverEnabled).toBe(true)
      expect(result.task.takeoverApplied).toBe(false)
      expect(fixture.adapter.startTurn).not.toHaveBeenCalled()
    } finally {
      await fixture.dispose()
    }
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
    this.assignSession(session)
  })

  /** 把 Adapter 预置到目标工作区，避免 fixture 把 connect 次数算进断言。 */
  primeWorkspace(workspace: string): void {
    this.status = {
      ...this.status,
      state: 'ready',
      workspace,
      message: '已连接'
    }
  }

  /** 测试里模拟 Adapter 已选中某个 session，不绕过 connect/resume 的状态字段。 */
  assignSession(session: AgentRuntimeSessionRef): void {
    this.status = {
      ...this.status,
      state: 'ready',
      workspace: session.workspace,
      runtimeSessionId: session.runtimeSessionId
    }
  }

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

async function createHistoryServiceFixture(
  ids: string[],
  capabilities: { resume: boolean; load: boolean } = { resume: true, load: true },
  extra: Pick<AgentServiceOptions, 'ensureChangeBaseline'> = {}
): Promise<{
  adapter: FakeRuntimeAdapter
  service: AgentService
  store: TaskStore
  project: { projectId: string; canonicalRoot: string }
  dispose: () => Promise<void>
}> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'agent-service-enter-'))
  const projectPath = join(userDataPath, 'project')
  await mkdir(projectPath)
  const registry = new ProjectRegistry({ userDataPath, createId: () => 'project-1' })
  await registry.initialize()
  const project = await registry.register(projectPath)
  const store = new TaskStore({ projectRegistry: registry })
  await store.initialize()
  const adapter = new FakeRuntimeAdapter(capabilities)
  adapter.primeWorkspace(project.canonicalRoot)
  let idIndex = 0
  const service = new AgentService(adapter, new TaskExecutionController(), {
    projectRegistry: registry,
    taskStore: store,
    operationGate: new OperationGate(),
    createId: () => ids[idIndex++] ?? `unexpected-id-${idIndex}`,
    ...extra
  })
  return {
    adapter,
    service,
    store,
    project,
    dispose: () => rm(userDataPath, { recursive: true, force: true })
  }
}

function createService(
  adapter: FakeRuntimeAdapter,
  ids: string[],
  controller = new TaskExecutionController(),
  operationGate?: OperationGate
): AgentService {
  let idIndex = 0
  let clock = 0
  return new AgentService(adapter, controller, {
    createId: () => ids[idIndex++] ?? `unexpected-id-${idIndex}`,
    now: () => new Date(Date.UTC(2026, 7, 11, 0, 0, clock++)).toISOString(),
    ...(operationGate ? { operationGate } : {})
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
async function createPermissionServiceFixture(
  ids: string[],
  extra?: {
    getTrustedExternalRoots?: () => Promise<string[]> | string[]
    onTaskRuntimeState?: (task: AgentTaskRuntimeState) => void
  }
): Promise<PermissionServiceFixture> {
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
    permissionBroker: broker,
    ...(extra?.getTrustedExternalRoots
      ? { getTrustedExternalRoots: extra.getTrustedExternalRoots }
      : {}),
    ...(extra?.onTaskRuntimeState ? { onTaskRuntimeState: extra.onTaskRuntimeState } : {})
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

function uniqueApprovals(approvals: AgentPermissionRequest[]): AgentPermissionRequest[] {
  const seen = new Set<string>()
  const unique: AgentPermissionRequest[] = []
  for (const approval of approvals) {
    if (seen.has(approval.approvalId)) continue
    seen.add(approval.approvalId)
    unique.push(approval)
  }
  return unique
}

async function waitForUniqueApproval(
  approvals: AgentPermissionRequest[],
  index: number
): Promise<AgentPermissionRequest> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const approval = uniqueApprovals(approvals)[index]
    if (approval) return approval
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('唯一审批卡未在预期时间内出现。')
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

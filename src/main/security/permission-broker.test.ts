import { describe, expect, it, vi } from 'vitest'
import type { AgentPermissionRequest, OperationIntent } from '../../shared/agent'
import type { PermissionAuditRecord } from '../../shared/task-history'
import type { PermissionAuditStore } from './permission-audit-store'
import {
  PermissionBroker,
  PERMISSION_APPROVAL_TTL_MS,
  type PermissionAuthorizationResult
} from './permission-broker'
import { createLocalEnvironmentId } from './permission-policy'

describe('PermissionBroker', () => {
  it('L0 自动允许并在审计成功后只执行一次', async () => {
    const fixture = createFixture()
    const execute = vi.fn(() => 'done')

    await expect(
      fixture.broker.authorizeOperation(createIntent('read-project'), execute)
    ).resolves.toEqual({ ok: true, value: 'done', reason: 'auto-allowed', scope: 'once' })
    expect(execute).toHaveBeenCalledOnce()
    expect(fixture.approvals).toHaveLength(0)
    expect(fixture.audits[0]).toMatchObject({ reason: 'auto-allowed', risk: 'L0' })
  })

  it('允许当前 Task 后跨 Turn 复用同类写，目标/参数变化仍命中，身份变化不命中', async () => {
    const fixture = createFixture()
    const firstPromise = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const first = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: first.approvalId,
      taskId: first.taskId,
      turnId: first.turnId,
      decision: 'allow-task'
    })
    await expect(firstPromise).resolves.toMatchObject({
      ok: true,
      reason: 'user-allowed',
      scope: 'task'
    })

    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-2' },
        vi.fn(() => 'reused')
      )
    ).resolves.toMatchObject({ ok: true, value: 'reused', reason: 'grant-reused' })

    await expect(
      fixture.broker.authorizeOperation(
        {
          ...createIntent('write-file'),
          turnId: 'turn-2',
          targets: [{ kind: 'path', value: 'src/other.ts' }]
        },
        vi.fn(() => 'other-path')
      )
    ).resolves.toMatchObject({ ok: true, value: 'other-path', reason: 'grant-reused' })
    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-2', parameterFingerprint: 'edit:v2' },
        vi.fn(() => 'other-fingerprint')
      )
    ).resolves.toMatchObject({
      ok: true,
      value: 'other-fingerprint',
      reason: 'grant-reused'
    })

    const deletePromise = fixture.broker.authorizeOperation(
      { ...createIntent('delete-path'), turnId: 'turn-2' },
      vi.fn()
    )
    await waitForApproval(fixture.approvals, 1)
    expect(fixture.approvals[1]).toMatchObject({ operationType: 'delete-path' })

    for (const invalidIdentity of [
      { ...createIntent('write-file'), taskId: 'task-2', turnId: 'turn-2' },
      { ...createIntent('write-file'), projectId: 'project-2', turnId: 'turn-2' },
      { ...createIntent('write-file'), environmentId: 'local:other', turnId: 'turn-2' }
    ]) {
      await expect(
        fixture.broker.authorizeOperation(invalidIdentity, vi.fn())
      ).resolves.toMatchObject({ ok: false })
    }
    await fixture.broker.shutdown()
    await expect(deletePromise).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('ask 不走 grant-reused，assist 仍 reuse', async () => {
    const fixture = createFixture()
    const firstPromise = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const first = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: first.approvalId,
      taskId: first.taskId,
      turnId: first.turnId,
      decision: 'allow-task'
    })
    await expect(firstPromise).resolves.toMatchObject({ ok: true, reason: 'user-allowed' })

    const askPromise = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      vi.fn(() => 'ask-again'),
      { permissionPromptStyle: 'ask' }
    )
    const askApproval = await waitForApproval(fixture.approvals, 1)
    expect(askApproval.turnId).toBe('turn-2')
    await fixture.broker.respond({
      approvalId: askApproval.approvalId,
      taskId: askApproval.taskId,
      turnId: askApproval.turnId,
      decision: 'allow-once'
    })
    await expect(askPromise).resolves.toMatchObject({ ok: true, reason: 'user-allowed' })

    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-3' },
        vi.fn(() => 'assist-again'),
        { permissionPromptStyle: 'assist' }
      )
    ).resolves.toMatchObject({ ok: true, value: 'assist-again', reason: 'grant-reused' })
    await fixture.broker.shutdown()
  })

  it('写文件宽 grant 不能捎带删除、未知出网或 Computer Use', async () => {
    const fixture = createFixture()
    const first = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const firstApproval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: firstApproval.approvalId,
      taskId: firstApproval.taskId,
      turnId: firstApproval.turnId,
      decision: 'allow-task'
    })
    await expect(first).resolves.toMatchObject({ ok: true, reason: 'user-allowed', scope: 'task' })

    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-2' },
        vi.fn(() => 'write-again')
      )
    ).resolves.toMatchObject({ ok: true, value: 'write-again', reason: 'grant-reused' })

    const network = fixture.broker.authorizeOperation(
      {
        ...createIntent('network-egress'),
        turnId: 'turn-2',
        targets: [{ kind: 'unknown', value: '目标未确认' }],
        minimumRisk: 'L3'
      },
      vi.fn()
    )
    const deletePath = fixture.broker.authorizeOperation(
      { ...createIntent('delete-path'), turnId: 'turn-2' },
      vi.fn()
    )
    const computerUse = fixture.broker.authorizeOperation(
      {
        ...createIntent('unknown'),
        turnId: 'turn-2',
        targets: [{ kind: 'unknown', value: 'computer-use' }]
      },
      vi.fn()
    )

    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-2') === 3)
    const networkCard = await waitForUniqueApproval(fixture.approvals, 1)
    expect(networkCard).toMatchObject({
      operationType: 'network-egress',
      risk: 'L3',
      allowedScopes: ['once']
    })
    await fixture.broker.respond({
      approvalId: networkCard.approvalId,
      taskId: networkCard.taskId,
      turnId: networkCard.turnId,
      decision: 'deny'
    })
    await expect(network).resolves.toEqual({ ok: false, reason: 'user-denied' })

    const deleteCard = await waitForUniqueApproval(fixture.approvals, 2)
    expect(deleteCard).toMatchObject({ operationType: 'delete-path' })
    await fixture.broker.respond({
      approvalId: deleteCard.approvalId,
      taskId: deleteCard.taskId,
      turnId: deleteCard.turnId,
      decision: 'deny'
    })
    await expect(deletePath).resolves.toEqual({ ok: false, reason: 'user-denied' })

    const computerCard = await waitForUniqueApproval(fixture.approvals, 3)
    expect(computerCard).toMatchObject({
      operationType: 'unknown',
      risk: 'L3',
      allowedScopes: ['once']
    })
    expect(JSON.stringify(uniqueApprovals(fixture.approvals))).not.toContain('allow_always')
    expect(JSON.stringify(uniqueApprovals(fixture.approvals))).not.toContain('rawInput')

    await fixture.broker.shutdown()
    await expect(computerUse).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('受控执行只接收 canonical intent，执行失败不会留下 Task grant', async () => {
    const fixture = createFixture()
    const execute = vi.fn(() => {
      throw new Error('side effect failed')
    })
    const firstPromise = fixture.broker.authorizeOperation(
      {
        ...createIntent('write-file'),
        targets: [{ kind: 'path', value: './src/shared/agent.ts' }]
      },
      execute
    )
    const first = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: first.approvalId,
      taskId: first.taskId,
      turnId: first.turnId,
      decision: 'allow-task'
    })
    await expect(firstPromise).resolves.toEqual({ ok: false, reason: 'internal-error' })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ kind: 'path', value: expect.stringMatching(/src\/shared\/agent\.ts$/u) }]
      })
    )
    expect(fixture.audits.at(-1)).toMatchObject({ reason: 'internal-error', scope: 'task' })

    const secondPromise = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      vi.fn()
    )
    await waitForApproval(fixture.approvals, 1)
    await fixture.broker.shutdown()
    await expect(secondPromise).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('并发审批、活动状态翻转、Task/Project 失效与 shutdown 均安全收束', async () => {
    const fixture = createFixture()
    const pendingCounts: number[] = []
    const first = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn(), {
      onPendingChange: (count) => pendingCounts.push(count)
    })
    const second = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), targets: [{ kind: 'path', value: 'src/main/index.ts' }] },
      vi.fn(),
      { onPendingChange: (count) => pendingCounts.push(count) }
    )
    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 2)
    expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(2)
    await fixture.broker.invalidateTask('task-1')
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: false, reason: 'cancelled' },
      { ok: false, reason: 'cancelled' }
    ])
    expect(pendingCounts).toContain(0)

    let active = true
    const stale = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn(), {
      isActive: () => active
    })
    const approval = await waitForUniqueApproval(fixture.approvals, 1)
    active = false
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-once'
    })
    await expect(stale).resolves.toEqual({ ok: false, reason: 'cancelled' })

    const projectPending = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    await waitForUniqueApproval(fixture.approvals, 2)
    await fixture.broker.invalidateProject('project-1')
    await expect(projectPending).resolves.toEqual({ ok: false, reason: 'cancelled' })

    const shutdownPending = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    await waitForUniqueApproval(fixture.approvals, 3)
    await fixture.broker.shutdown()
    await expect(shutdownPending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('cancellationId 精确取消单个审批，晚到允许不会执行或留下 Task grant', async () => {
    const fixture = createFixture()
    const execute = vi.fn()
    const cancelled = fixture.broker.authorizeOperation(createIntent('write-file'), execute, {
      cancellationId: 'runtime-request-1'
    })
    const sibling = fixture.broker.authorizeOperation(
      {
        ...createIntent('write-file'),
        targets: [{ kind: 'path', value: 'src/main/index.ts' }]
      },
      vi.fn(),
      { cancellationId: 'runtime-request-2' }
    )
    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 2)
    const cancelledApproval = uniqueApprovals(fixture.approvals)[0]!
    expect(cancelledApproval.targets).toEqual([
      'path: src/shared/agent.ts',
      'path: src/main/index.ts'
    ])

    await fixture.broker.cancelAuthorization('runtime-request-1', 'task-1', 'turn-1')
    await expect(cancelled).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(1)
    const siblingApproval = await waitForUniqueApproval(fixture.approvals, 1)
    expect(siblingApproval.targets[0]).toBe('path: src/main/index.ts')
    await fixture.broker.respond({
      approvalId: cancelledApproval.approvalId,
      taskId: cancelledApproval.taskId,
      turnId: cancelledApproval.turnId,
      decision: 'allow-task'
    })
    expect(execute).not.toHaveBeenCalled()

    const sameIntent = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      vi.fn()
    )
    await waitForUniqueApproval(fixture.approvals, 2)
    await fixture.broker.respond({
      approvalId: siblingApproval.approvalId,
      taskId: siblingApproval.taskId,
      turnId: siblingApproval.turnId,
      decision: 'deny'
    })
    await fixture.broker.shutdown()
    await expect(sibling).resolves.toEqual({ ok: false, reason: 'user-denied' })
    await expect(sameIntent).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('Broker 强制同 Task/Turn FIFO，后续审批不能越过队首', async () => {
    const fixture = createFixture()
    const firstExecute = vi.fn(() => 'first')
    const secondExecute = vi.fn(() => 'second')
    const first = fixture.broker.authorizeOperation(createIntent('write-file'), firstExecute)
    const second = fixture.broker.authorizeOperation(
      {
        ...createIntent('delete-path'),
        targets: [{ kind: 'path', value: 'src/main/index.ts' }]
      },
      secondExecute
    )
    const firstApproval = await waitForApproval(fixture.approvals, 0)
    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 2)
    expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)
    expect(firstApproval.operationType).toBe('write-file')

    await fixture.broker.respond({
      // 夹具 createId 为 id-N；删除虽已挂起但未交付，不能靠这条 id 越过队首。
      approvalId: 'id-2',
      taskId: firstApproval.taskId,
      turnId: firstApproval.turnId,
      decision: 'allow-once'
    })
    expect(secondExecute).not.toHaveBeenCalled()
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(2)

    await fixture.broker.respond({
      approvalId: firstApproval.approvalId,
      taskId: firstApproval.taskId,
      turnId: firstApproval.turnId,
      decision: 'deny'
    })
    await expect(first).resolves.toEqual({ ok: false, reason: 'user-denied' })
    const secondApproval = await waitForUniqueApproval(fixture.approvals, 1)
    expect(secondApproval.operationType).toBe('delete-path')
    await fixture.broker.respond({
      approvalId: secondApproval.approvalId,
      taskId: secondApproval.taskId,
      turnId: secondApproval.turnId,
      decision: 'allow-once'
    })
    await expect(second).resolves.toEqual({
      ok: true,
      value: 'second',
      reason: 'user-allowed',
      scope: 'once'
    })
    expect(firstExecute).not.toHaveBeenCalled()
    expect(secondExecute).toHaveBeenCalledOnce()
  })

  it('invalid-target 慢审计不阻塞同 Task/Turn 后续审批，且不同 Turn 独立准入', async () => {
    const auditStarted = deferred<void>()
    const releaseAudit = deferred<void>()
    const fixture = createFixture()
    const invalidExecute = vi.fn()
    let invalidSettled = false
    fixture.setAuditHook(async () => {
      auditStarted.resolve()
      await releaseAudit.promise
    })

    const invalid = fixture.broker
      .authorizeOperation(
        { ...createIntent('write-file'), environmentId: 'local:other' },
        invalidExecute
      )
      .finally(() => {
        invalidSettled = true
      })
    await auditStarted.promise

    const independent = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-independent' },
      vi.fn()
    )
    await expect(waitForApproval(fixture.approvals, 0)).resolves.toMatchObject({
      turnId: 'turn-independent'
    })

    const sameTurn = fixture.broker.authorizeOperation(
      {
        ...createIntent('write-file'),
        targets: [{ kind: 'path', value: 'src/main/index.ts' }]
      },
      vi.fn()
    )
    await expect(waitForApproval(fixture.approvals, 1)).resolves.toMatchObject({
      taskId: 'task-1',
      turnId: 'turn-1'
    })
    expect(invalidSettled).toBe(false)
    expect(fixture.audits).toHaveLength(0)
    expect(invalidExecute).not.toHaveBeenCalled()
    expect(fixture.broker.getPendingCount('task-1', 'turn-independent')).toBe(1)
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(1)

    releaseAudit.resolve()
    await expect(invalid).resolves.toEqual({ ok: false, reason: 'invalid-target' })
    fixture.setAuditHook()
    await fixture.broker.shutdown()
    await expect(independent).resolves.toEqual({ ok: false, reason: 'cancelled' })
    await expect(sameTurn).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('L0 慢执行不阻塞同 Task/Turn 后续审批准入', async () => {
    const executeStarted = deferred<void>()
    const releaseExecute = deferred<void>()
    const fixture = createFixture()
    let firstSettled = false
    const execute = vi.fn(async () => {
      executeStarted.resolve()
      await releaseExecute.promise
      return 'read-done'
    })
    const first = fixture.broker
      .authorizeOperation(createIntent('read-project'), execute)
      .finally(() => {
        firstSettled = true
      })
    await executeStarted.promise

    const second = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    await expect(waitForApproval(fixture.approvals, 0)).resolves.toMatchObject({
      taskId: 'task-1',
      turnId: 'turn-1'
    })
    expect(firstSettled).toBe(false)
    expect(execute).toHaveBeenCalledOnce()
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(1)

    releaseExecute.resolve()
    await expect(first).resolves.toEqual({
      ok: true,
      value: 'read-done',
      reason: 'auto-allowed',
      scope: 'once'
    })
    await fixture.broker.shutdown()
    await expect(second).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('Task grant 慢复用不阻塞同 Task/Turn 后续审批准入', async () => {
    const fixture = createFixture()
    const seed = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-seed' },
      vi.fn(() => 'seed-done')
    )
    const seedApproval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: seedApproval.approvalId,
      taskId: seedApproval.taskId,
      turnId: seedApproval.turnId,
      decision: 'allow-task'
    })
    await expect(seed).resolves.toMatchObject({ ok: true, reason: 'user-allowed', scope: 'task' })

    const executeStarted = deferred<void>()
    const releaseExecute = deferred<void>()
    let reusedSettled = false
    const reusedExecute = vi.fn(async () => {
      executeStarted.resolve()
      await releaseExecute.promise
      return 'reused-done'
    })
    const reused = fixture.broker
      .authorizeOperation({ ...createIntent('write-file'), turnId: 'turn-race' }, reusedExecute)
      .finally(() => {
        reusedSettled = true
      })
    await executeStarted.promise

    const next = fixture.broker.authorizeOperation(
      {
        ...createIntent('delete-path'),
        turnId: 'turn-race',
        targets: [{ kind: 'path', value: 'src/main/index.ts' }]
      },
      vi.fn()
    )
    await expect(waitForApproval(fixture.approvals, 1)).resolves.toMatchObject({
      taskId: 'task-1',
      turnId: 'turn-race'
    })
    expect(reusedSettled).toBe(false)
    expect(reusedExecute).toHaveBeenCalledOnce()
    expect(fixture.broker.getPendingCount('task-1', 'turn-race')).toBe(1)

    releaseExecute.resolve()
    await expect(reused).resolves.toEqual({
      ok: true,
      value: 'reused-done',
      reason: 'grant-reused',
      scope: 'task'
    })
    await fixture.broker.shutdown()
    await expect(next).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('允许审计等待期精确取消会立即通知 Renderer，且不执行或登记 grant', async () => {
    const auditStarted = deferred<void>()
    const releaseAudit = deferred<void>()
    const fixture = createFixture()
    const execute = vi.fn(() => 'done')
    fixture.setAuditHook(async () => {
      auditStarted.resolve()
      await releaseAudit.promise
    })
    const result = fixture.broker.authorizeOperation(createIntent('write-file'), execute, {
      cancellationId: 'runtime-request-audit-race'
    })
    const approval = await waitForApproval(fixture.approvals, 0)
    const response = fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    await auditStarted.promise

    const cancellation = fixture.broker.cancelAuthorization(
      'runtime-request-audit-race',
      approval.taskId,
      approval.turnId
    )
    expect(fixture.cancellations).toEqual([
      {
        approvalId: approval.approvalId,
        taskId: approval.taskId,
        turnId: approval.turnId,
        reason: 'cancelled'
      }
    ])
    expect(fixture.broker.getPendingCount(approval.taskId, approval.turnId)).toBe(1)

    releaseAudit.resolve()
    await Promise.all([response, cancellation])
    await expect(result).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(execute).not.toHaveBeenCalled()
    expect(fixture.broker.getPendingCount(approval.taskId, approval.turnId)).toBe(0)
    expect(fixture.audits.map((audit) => audit.reason)).toEqual(['user-allowed', 'cancelled'])

    fixture.setAuditHook()
    const next = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      vi.fn()
    )
    await expect(waitForApproval(fixture.approvals, 1)).resolves.toMatchObject({ turnId: 'turn-2' })
    await fixture.broker.shutdown()
    await expect(next).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('拒绝、重复响应、错误身份和 L3 allow-task 均不执行副作用', async () => {
    const fixture = createFixture()
    const execute = vi.fn()
    const promise = fixture.broker.authorizeOperation(createIntent('unknown'), execute)
    const approval = await waitForApproval(fixture.approvals, 0)
    expect(approval.allowedScopes).toEqual(['once'])

    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: 'wrong-task',
      turnId: approval.turnId,
      decision: 'allow-once'
    })
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    expect(execute).not.toHaveBeenCalled()
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'deny'
    })
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-once'
    })
    await expect(promise).resolves.toEqual({ ok: false, reason: 'user-denied' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('超时、Turn 取消、Renderer 不可达和无 allow_once 均失败关闭', async () => {
    const fixture = createFixture()
    const execute = vi.fn()
    const timeoutPromise = fixture.broker.authorizeOperation(createIntent('write-file'), execute)
    await waitForApproval(fixture.approvals, 0)
    fixture.advanceTime(PERMISSION_APPROVAL_TTL_MS)
    await fixture.runTimers()
    await expect(timeoutPromise).resolves.toEqual({ ok: false, reason: 'expired' })

    const cancelPromise = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-cancel' },
      execute
    )
    await waitForApproval(fixture.approvals, 1)
    await fixture.broker.cancelTurn('task-1', 'turn-cancel')
    await expect(cancelPromise).resolves.toEqual({ ok: false, reason: 'cancelled' })

    const unavailable = createFixture({ deliverApproval: false })
    await expect(
      unavailable.broker.authorizeOperation(createIntent('write-file'), execute)
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })

    await expect(
      fixture.broker.authorizeOperation(createIntent('write-file'), execute, {
        executionSupported: false
      })
    ).resolves.toEqual({ ok: false, reason: 'unsupported' })
    await expect(
      fixture.broker.authorizeOperation(createIntent('read-project'), execute, {
        executionSupported: false
      })
    ).resolves.toEqual({ ok: false, reason: 'unsupported' })
    expect(execute).not.toHaveBeenCalled()
    expect(fixture.audits.at(-1)).toMatchObject({
      reason: 'unsupported',
      detail: 'Runtime 没提供一次性允许。'
    })
    expect(
      fixture.approvals.some((approval) => JSON.stringify(approval).includes('allow_always'))
    ).toBe(false)
  })

  it('executionSupported=false 即使存在精确 Task grant 也只记 unsupported，不复用副作用', async () => {
    const fixture = createFixture()
    const first = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const approval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    await first

    const execute = vi.fn()
    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-2' },
        execute,
        { executionSupported: false }
      )
    ).resolves.toEqual({ ok: false, reason: 'unsupported' })
    expect(execute).not.toHaveBeenCalled()
    expect(fixture.approvals).toHaveLength(1)
    expect(fixture.audits.at(-1)).toMatchObject({ reason: 'unsupported' })
  })

  it('允许审计失败时不执行，拒绝审计失败仍保持拒绝', async () => {
    const fixture = createFixture({ auditFails: true })
    const execute = vi.fn()
    await expect(
      fixture.broker.authorizeOperation(createIntent('read-project'), execute)
    ).resolves.toEqual({ ok: false, reason: 'internal-error' })
    expect(execute).not.toHaveBeenCalled()

    const denied = fixture.broker.authorizeOperation(createIntent('write-file'), execute)
    const approval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'deny'
    })
    await expect(denied).resolves.toEqual({ ok: false, reason: 'user-denied' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('审批与审计只包含脱敏限长摘要，不保留 Secret 或原始命令环境', async () => {
    const fixture = createFixture({
      redactText: (text) => text.replaceAll('fake-secret', '[REDACTED]')
    })
    const pending = fixture.broker.authorizeOperation(
      {
        ...createIntent('execute-command'),
        title: '执行 fake-secret',
        impact: 'Bearer fake-secret',
        targets: [{ kind: 'command', value: 'env API_KEY=fake-secret' }]
      },
      vi.fn()
    )
    const approval = await waitForApproval(fixture.approvals, 0)
    expect(JSON.stringify(approval)).not.toContain('fake-secret')
    expect(JSON.stringify(approval)).not.toContain('rawInput')
    await fixture.broker.cancelTurn(approval.taskId, approval.turnId)
    await pending
    expect(JSON.stringify(fixture.audits)).not.toContain('fake-secret')
    expect(JSON.stringify(fixture.audits)).not.toContain('env API_KEY')
    expect(fixture.audits.at(-1)?.targetSummaries[0]).toMatch(/^command: sha256:[0-9a-f]{64}$/u)
  })

  it('超长审批目标显式标记截断，审计组合字段收束到 16 KiB 内', async () => {
    const fixture = createFixture()
    const targets: OperationIntent['targets'] = [
      ...Array.from({ length: 31 }, (_, index) => ({
        kind: 'worktree' as const,
        value: `${String(index).padStart(2, '0')}${'x'.repeat(4 * 1024 - 2)}`
      })),
      { kind: 'path', value: '.' }
    ]
    const pending = fixture.broker.authorizeOperation(
      {
        ...createIntent('worktree-create'),
        targets
      },
      vi.fn()
    )
    const approval = await waitForApproval(fixture.approvals, 0)
    expect(approval.truncated).toBe(true)
    await fixture.broker.cancelTurn(approval.taskId, approval.turnId)
    await pending
    const audit = fixture.audits.at(-1)!
    expect(Buffer.byteLength(JSON.stringify(audit), 'utf8')).toBeLessThanOrEqual(16 * 1024)
    expect(audit.targetSummaries.length).toBeLessThan(32)
    expect(audit.truncated).toBe(true)
  })

  it('权威 Task 上下文不匹配、未知环境和终态都在审批前失败关闭', async () => {
    const base = createIntent('write-file')
    const cases = [
      {
        context: { projectId: 'project-other' },
        reason: 'invalid-target'
      },
      {
        context: { executionRoot: `${base.executionRoot}-other` },
        reason: 'invalid-target'
      },
      {
        context: { environmentId: 'local:other' },
        reason: 'invalid-target'
      },
      {
        context: { runtimeId: 'codex' as const },
        reason: 'invalid-target'
      },
      {
        context: { environmentKind: 'unknown' as const },
        reason: 'unsupported'
      },
      {
        context: { active: false },
        reason: 'cancelled'
      }
    ]

    for (const testCase of cases) {
      const fixture = createFixture({ context: testCase.context })
      await expect(fixture.broker.authorizeOperation(base, vi.fn())).resolves.toMatchObject({
        ok: false,
        reason: testCase.reason
      })
      expect(fixture.approvals).toHaveLength(0)
    }
  })

  it('App 自有服务使用同一受控回调，并在审批和审计中保留有限服务身份', async () => {
    const fixture = createFixture()
    const execute = vi.fn(() => 'git-ok')
    const intent: OperationIntent = {
      ...createIntent('git-mutate'),
      initiator: { kind: 'app', service: 'git' },
      targets: [{ kind: 'git', value: 'force-reset' }],
      minimumRisk: 'L3'
    }

    const resultPromise = fixture.broker.authorizeOperation(intent, execute)
    const approval = await waitForApproval(fixture.approvals, 0)
    expect(approval).toMatchObject({ initiator: 'app', appService: 'git', risk: 'L3' })
    expect(approval.allowedScopes).toEqual(['once'])
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-once'
    })

    await expect(resultPromise).resolves.toMatchObject({ ok: true, value: 'git-ok' })
    expect(execute).toHaveBeenCalledOnce()
    expect(fixture.audits.at(-1)).toMatchObject({ initiator: 'app', appService: 'git' })
  })

  it('删除冻结会等待在途授权、拒绝新授权，并在失败回滚后恢复既有 Task grant', async () => {
    const fixture = createFixture()
    const first = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const approval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    await first

    const auditStarted = deferred<void>()
    const releaseAudit = deferred<void>()
    fixture.setAuditHook(async () => {
      auditStarted.resolve()
      await releaseAudit.promise
    })
    const inFlightExecute = vi.fn(() => 'reused')
    const inFlight = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      inFlightExecute
    )
    await auditStarted.promise

    const deletion = fixture.broker.beginTaskDeletion('task-1')
    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-3' },
        vi.fn()
      )
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
    let deletionReady = false
    void deletion.then(() => {
      deletionReady = true
    })
    await Promise.resolve()
    expect(deletionReady).toBe(false)

    releaseAudit.resolve()
    await expect(inFlight).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(inFlightExecute).not.toHaveBeenCalled()
    const lease = await deletion
    lease.rollback()
    fixture.setAuditHook()

    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-4' },
        vi.fn(() => 'restored')
      )
    ).resolves.toMatchObject({ ok: true, value: 'restored', reason: 'grant-reused' })
  })

  it('Project 删除冻结会等待在途授权、拒绝新授权，rollback 后恢复既有 grant', async () => {
    const fixture = createFixture()
    const first = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const approval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    await first

    const auditStarted = deferred<void>()
    const releaseAudit = deferred<void>()
    fixture.setAuditHook(async () => {
      auditStarted.resolve()
      await releaseAudit.promise
    })
    const inFlight = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      vi.fn()
    )
    await auditStarted.promise

    const deletion = fixture.broker.beginProjectDeletion('project-1')
    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-3' },
        vi.fn()
      )
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
    releaseAudit.resolve()
    await expect(inFlight).resolves.toEqual({ ok: false, reason: 'cancelled' })
    const lease = await deletion
    lease.rollback()
    fixture.setAuditHook()

    await expect(
      fixture.broker.authorizeOperation(
        { ...createIntent('write-file'), turnId: 'turn-4' },
        vi.fn(() => 'restored')
      )
    ).resolves.toMatchObject({ ok: true, value: 'restored', reason: 'grant-reused' })
  })

  it('删除 commit 清除 Task grant 后才解冻，重复提交和晚到 rollback 均幂等', async () => {
    const fixture = createFixture()
    const first = fixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const approval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    await first

    const lease = await fixture.broker.beginTaskDeletion('task-1')
    lease.commit()
    lease.commit()
    lease.rollback()

    const next = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      vi.fn()
    )
    await expect(waitForApproval(fixture.approvals, 1)).resolves.toMatchObject({
      taskId: 'task-1',
      turnId: 'turn-2'
    })
    await fixture.broker.shutdown()
    await expect(next).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('Task grant 只存在当前 Broker 实例，重建实例后相同操作仍需审批', async () => {
    const firstFixture = createFixture()
    const first = firstFixture.broker.authorizeOperation(createIntent('write-file'), vi.fn())
    const approval = await waitForApproval(firstFixture.approvals, 0)
    await firstFixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    await first

    const restarted = createFixture()
    const pending = restarted.broker.authorizeOperation(
      { ...createIntent('write-file'), turnId: 'turn-2' },
      vi.fn()
    )
    await expect(waitForApproval(restarted.approvals, 0)).resolves.toMatchObject({
      taskId: 'task-1',
      turnId: 'turn-2'
    })
    await firstFixture.broker.shutdown()
    await restarted.broker.shutdown()
    await expect(pending).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('shutdown 拒绝新授权并等待在途授权收束后完成', async () => {
    const fixture = createFixture()
    const auditStarted = deferred<void>()
    const releaseAudit = deferred<void>()
    fixture.setAuditHook(async () => {
      auditStarted.resolve()
      await releaseAudit.promise
    })
    const inFlight = fixture.broker.authorizeOperation(createIntent('read-project'), vi.fn())
    await auditStarted.promise

    const shutdown = fixture.broker.shutdown()
    await expect(
      fixture.broker.authorizeOperation(createIntent('read-project'), vi.fn())
    ).resolves.toEqual({ ok: false, reason: 'cancelled' })
    let shutdownFinished = false
    void shutdown.then(() => {
      shutdownFinished = true
    })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)

    releaseAudit.resolve()
    await inFlight
    await expect(shutdown).resolves.toBeUndefined()
  })

  it('清空 Task grant 不会丢失在途授权跟踪，删除仍等待其安全收束', async () => {
    const fixture = createFixture()
    const auditStarted = deferred<void>()
    const releaseAudit = deferred<void>()
    fixture.setAuditHook(async () => {
      auditStarted.resolve()
      await releaseAudit.promise
    })
    const inFlight = fixture.broker.authorizeOperation(createIntent('read-project'), vi.fn())
    await auditStarted.promise

    fixture.broker.clearTaskGrants()
    const deletion = fixture.broker.beginTaskDeletion('task-1')
    let deletionReady = false
    void deletion.then(() => {
      deletionReady = true
    })
    await Promise.resolve()
    expect(deletionReady).toBe(false)

    releaseAudit.resolve()
    await inFlight
    const lease = await deletion
    lease.rollback()
  })

  it('同一 Task 连续 15 次项目内读取零审批卡，且每条都记 auto-allowed', async () => {
    const fixture = createFixture()
    const results: PermissionAuthorizationResult<string>[] = []
    for (let index = 0; index < 15; index += 1) {
      results.push(
        await fixture.broker.authorizeOperation(
          {
            ...createIntent('read-project'),
            targets: [{ kind: 'path', value: `src/read-${index}.ts` }]
          },
          vi.fn(() => `read-${index}`)
        )
      )
    }

    expect(fixture.approvals).toHaveLength(0)
    expect(results).toEqual(
      Array.from({ length: 15 }, (_, index) => ({
        ok: true,
        value: `read-${index}`,
        reason: 'auto-allowed',
        scope: 'once'
      }))
    )
    expect(fixture.audits).toHaveLength(15)
    expect(fixture.audits.every((audit) => audit.reason === 'auto-allowed')).toBe(true)
    expect(JSON.stringify(fixture.audits)).not.toContain('rawInput')
    expect(JSON.stringify(fixture.audits)).not.toContain('allow_always')
  })

  it('普通删除本任务授权后同类可复用，但不能捎带 .git、越界或 Computer Use', async () => {
    const fixture = createFixture()
    const first = fixture.broker.authorizeOperation(createIntent('delete-path'), vi.fn())
    const firstApproval = await waitForApproval(fixture.approvals, 0)
    expect(firstApproval.allowedScopes).toEqual(['once', 'task'])
    expect(firstApproval.risk).toBe('L1')
    await fixture.broker.respond({
      approvalId: firstApproval.approvalId,
      taskId: firstApproval.taskId,
      turnId: firstApproval.turnId,
      decision: 'allow-task'
    })
    await expect(first).resolves.toMatchObject({ ok: true, reason: 'user-allowed', scope: 'task' })

    await expect(
      fixture.broker.authorizeOperation(
        {
          ...createIntent('delete-path'),
          turnId: 'turn-2',
          targets: [{ kind: 'path', value: 'src/other.ts' }]
        },
        vi.fn(() => 'deleted-other')
      )
    ).resolves.toMatchObject({ ok: true, value: 'deleted-other', reason: 'grant-reused' })

    const gitDelete = fixture.broker.authorizeOperation(
      {
        ...createIntent('delete-path'),
        turnId: 'turn-2',
        targets: [{ kind: 'path', value: '.git' }]
      },
      vi.fn()
    )
    const gitApproval = await waitForApproval(fixture.approvals, 1)
    expect(gitApproval).toMatchObject({
      operationType: 'delete-path',
      risk: 'L3',
      allowedScopes: ['once']
    })

    await expect(
      fixture.broker.authorizeOperation(
        {
          ...createIntent('delete-path'),
          turnId: 'turn-2',
          targets: [{ kind: 'path', value: '/tmp/outside-agent-studio/secret.ts' }]
        },
        vi.fn()
      )
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-target' })

    const computerUse = fixture.broker.authorizeOperation(
      {
        ...createIntent('unknown'),
        turnId: 'turn-2',
        targets: [{ kind: 'unknown', value: 'computer-use' }]
      },
      vi.fn()
    )
    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-2') === 2)
    expect(uniqueApprovals(fixture.approvals).map((card) => card.operationType)).toEqual([
      'delete-path',
      'delete-path'
    ])

    await fixture.broker.respond({
      approvalId: gitApproval.approvalId,
      taskId: gitApproval.taskId,
      turnId: gitApproval.turnId,
      decision: 'deny'
    })
    await expect(gitDelete).resolves.toEqual({ ok: false, reason: 'user-denied' })
    const computerApproval = await waitForUniqueApproval(fixture.approvals, 2)
    expect(computerApproval).toMatchObject({
      operationType: 'unknown',
      risk: 'L3',
      allowedScopes: ['once']
    })

    await fixture.broker.shutdown()
    await expect(computerUse).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('8 个不同 path 的 write-file 未响应前只产生 1 张卡，allow-task 后全部执行且第 9 次复用', async () => {
    const fixture = createFixture()
    const executes = Array.from({ length: 8 }, (_, index) => vi.fn(() => `write-${index}`))
    const promises = executes.map((execute, index) =>
      fixture.broker.authorizeOperation(
        {
          ...createIntent('write-file'),
          targets: [{ kind: 'path', value: `src/write-${index}.ts` }]
        },
        execute
      )
    )

    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 8)
    const cards = uniqueApprovals(fixture.approvals)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.operationType).toBe('write-file')
    expect(cards[0]?.targets).toEqual(
      Array.from({ length: 8 }, (_, index) => `path: src/write-${index}.ts`)
    )
    expect(executes.every((execute) => execute.mock.calls.length === 0)).toBe(true)

    await fixture.broker.respond({
      approvalId: cards[0]!.approvalId,
      taskId: cards[0]!.taskId,
      turnId: cards[0]!.turnId,
      decision: 'allow-task'
    })
    await expect(Promise.all(promises)).resolves.toEqual(
      executes.map((_, index) => ({
        ok: true,
        value: `write-${index}`,
        reason: 'user-allowed',
        scope: 'task'
      }))
    )
    executes.forEach((execute) => expect(execute).toHaveBeenCalledOnce())

    await expect(
      fixture.broker.authorizeOperation(
        {
          ...createIntent('write-file'),
          turnId: 'turn-2',
          targets: [{ kind: 'path', value: 'src/write-8.ts' }]
        },
        vi.fn(() => 'write-8')
      )
    ).resolves.toMatchObject({ ok: true, value: 'write-8', reason: 'grant-reused' })
  })

  it('allow-task 结算窗口内到达的同类 write 走 grant-reused，不再弹卡', async () => {
    const fixture = createFixture()
    const releaseExecute = deferred<void>()
    const executing = deferred<void>()
    const executes = Array.from({ length: 8 }, (_, index) =>
      vi.fn(async () => {
        executing.resolve()
        await releaseExecute.promise
        return `write-${index}`
      })
    )
    const promises = executes.map((execute, index) =>
      fixture.broker.authorizeOperation(
        {
          ...createIntent('write-file'),
          targets: [{ kind: 'path', value: `src/write-${index}.ts` }]
        },
        execute
      )
    )
    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 8)
    const cards = uniqueApprovals(fixture.approvals)
    expect(cards).toHaveLength(1)

    const respondPromise = fixture.broker.respond({
      approvalId: cards[0]!.approvalId,
      taskId: cards[0]!.taskId,
      turnId: cards[0]!.turnId,
      decision: 'allow-task'
    })
    await executing.promise

    const ninthExecute = vi.fn(() => 'write-8')
    const ninth = fixture.broker.authorizeOperation(
      {
        ...createIntent('write-file'),
        targets: [{ kind: 'path', value: 'src/write-8.ts' }]
      },
      ninthExecute
    )
    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 9)
    expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)

    releaseExecute.resolve()
    await respondPromise
    await expect(Promise.all(promises)).resolves.toEqual(
      executes.map((_, index) => ({
        ok: true,
        value: `write-${index}`,
        reason: 'user-allowed',
        scope: 'task'
      }))
    )
    await expect(ninth).resolves.toMatchObject({
      ok: true,
      value: 'write-8',
      reason: 'grant-reused'
    })
    expect(ninthExecute).toHaveBeenCalledOnce()
    expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(0)
  })

  it('拒绝合并写文件卡会拒绝列出的全部同类 path，不影响其他 grantKey', async () => {
    const fixture = createFixture()
    const writeExecutes = Array.from({ length: 8 }, (_, index) => vi.fn(() => `write-${index}`))
    const writePromises = writeExecutes.map((execute, index) =>
      fixture.broker.authorizeOperation(
        {
          ...createIntent('write-file'),
          targets: [{ kind: 'path', value: `src/write-${index}.ts` }]
        },
        execute
      )
    )
    const deleteExecute = vi.fn(() => 'deleted')
    const deletePromise = fixture.broker.authorizeOperation(
      {
        ...createIntent('delete-path'),
        targets: [{ kind: 'path', value: 'src/temp.ts' }]
      },
      deleteExecute
    )

    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 9)
    const writeCard = uniqueApprovals(fixture.approvals)[0]!
    expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)
    expect(writeCard.operationType).toBe('write-file')

    await fixture.broker.respond({
      approvalId: writeCard.approvalId,
      taskId: writeCard.taskId,
      turnId: writeCard.turnId,
      decision: 'deny'
    })
    await expect(Promise.all(writePromises)).resolves.toEqual(
      Array.from({ length: 8 }, () => ({ ok: false, reason: 'user-denied' }))
    )
    writeExecutes.forEach((execute) => expect(execute).not.toHaveBeenCalled())
    expect(deleteExecute).not.toHaveBeenCalled()
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(1)

    const deleteCard = await waitForUniqueApproval(fixture.approvals, 1)
    expect(deleteCard.operationType).toBe('delete-path')
    expect(deleteCard.targets[0]).toBe('path: src/temp.ts')

    await fixture.broker.shutdown()
    await expect(deletePromise).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('合并写文件卡点 allow-once 只执行队首，其余继续排队且不得一起跑', async () => {
    const fixture = createFixture()
    const executes = Array.from({ length: 8 }, (_, index) => vi.fn(() => `write-${index}`))
    const promises = executes.map((execute, index) =>
      fixture.broker.authorizeOperation(
        {
          ...createIntent('write-file'),
          targets: [{ kind: 'path', value: `src/write-${index}.ts` }]
        },
        execute
      )
    )

    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 8)
    const cards = uniqueApprovals(fixture.approvals)
    expect(cards).toHaveLength(1)
    const firstCard = cards[0]!
    await fixture.broker.respond({
      approvalId: firstCard.approvalId,
      taskId: firstCard.taskId,
      turnId: firstCard.turnId,
      decision: 'allow-once'
    })

    await expect(promises[0]).resolves.toMatchObject({
      ok: true,
      value: 'write-0',
      reason: 'user-allowed',
      scope: 'once'
    })
    expect(executes[0]).toHaveBeenCalledOnce()
    executes.slice(1).forEach((execute) => expect(execute).not.toHaveBeenCalled())
    expect(fixture.broker.getPendingCount('task-1', 'turn-1')).toBe(7)

    const nextCard = await waitForUniqueApproval(fixture.approvals, 1)
    expect(nextCard.approvalId).not.toBe(firstCard.approvalId)
    expect(nextCard.operationType).toBe('write-file')
    expect(nextCard.targets[0]).toBe('path: src/write-1.ts')
    expect(nextCard.targets).not.toEqual(firstCard.targets)

    await fixture.broker.shutdown()
    await expect(Promise.all(promises.slice(1))).resolves.toEqual(
      Array.from({ length: 7 }, () => ({ ok: false, reason: 'cancelled' }))
    )
  })

  it('write 挂起时到来的 delete-path / unknown execute 不得并进写文件卡', async () => {
    const fixture = createFixture()
    const writeExecute = vi.fn(() => 'written')
    const deleteExecute = vi.fn(() => 'deleted')
    const unknownExecute = vi.fn(() => 'ran')
    const writePromise = fixture.broker.authorizeOperation(
      { ...createIntent('write-file'), targets: [{ kind: 'path', value: 'src/write.ts' }] },
      writeExecute
    )
    const firstCard = await waitForApproval(fixture.approvals, 0)

    const deletePromise = fixture.broker.authorizeOperation(
      { ...createIntent('delete-path'), targets: [{ kind: 'path', value: 'src/temp.ts' }] },
      deleteExecute
    )
    const unknownPromise = fixture.broker.authorizeOperation(
      {
        ...createIntent('execute-command'),
        minimumRisk: 'L3',
        targets: [{ kind: 'command', value: 'Runtime 未提供可信的结构化命令。' }],
        parameterFingerprint: 'grok-acp:execute:unknown-command:v1'
      },
      unknownExecute
    )

    await waitUntil(() => fixture.broker.getPendingCount('task-1', 'turn-1') === 3)
    expect(uniqueApprovals(fixture.approvals)).toHaveLength(1)
    expect(firstCard).toMatchObject({ operationType: 'write-file' })
    expect(firstCard.targets.join('\n')).toContain('path: src/write.ts')
    expect(firstCard.targets.join('\n')).not.toContain('src/temp.ts')
    expect(JSON.stringify(firstCard)).not.toContain('unknown-command')
    expect(deleteExecute).not.toHaveBeenCalled()
    expect(unknownExecute).not.toHaveBeenCalled()

    await fixture.broker.respond({
      approvalId: firstCard.approvalId,
      taskId: firstCard.taskId,
      turnId: firstCard.turnId,
      decision: 'allow-task'
    })
    await expect(writePromise).resolves.toMatchObject({ ok: true, value: 'written', scope: 'task' })

    const secondCard = await waitForUniqueApproval(fixture.approvals, 1)
    expect(secondCard.operationType).toBe('delete-path')
    expect(secondCard.operationType).not.toBe('execute-command')
    expect(uniqueApprovals(fixture.approvals).map((card) => card.operationType)).not.toContain(
      'execute-command'
    )

    await fixture.broker.shutdown()
    await expect(deletePromise).resolves.toEqual({ ok: false, reason: 'cancelled' })
    await expect(unknownPromise).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('未知 execute 为 L3 仅本次，误发 allow-task 不能登记宽 grant', async () => {
    const fixture = createFixture()
    const execute = vi.fn(() => 'ran')
    const unknownExecute = {
      ...createIntent('execute-command'),
      minimumRisk: 'L3' as const,
      targets: [{ kind: 'command' as const, value: 'Runtime 未提供可信的结构化命令。' }],
      parameterFingerprint: 'grok-acp:execute:unknown-command:v1'
    }
    const first = fixture.broker.authorizeOperation(unknownExecute, execute)
    const approval = await waitForApproval(fixture.approvals, 0)
    expect(approval).toMatchObject({ risk: 'L3', allowedScopes: ['once'] })

    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    expect(execute).not.toHaveBeenCalled()

    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-once'
    })
    await expect(first).resolves.toMatchObject({
      ok: true,
      reason: 'user-allowed',
      scope: 'once'
    })

    const second = fixture.broker.authorizeOperation(
      { ...unknownExecute, turnId: 'turn-2' },
      vi.fn()
    )
    await waitForApproval(fixture.approvals, 1)
    await fixture.broker.shutdown()
    await expect(second).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })

  it('未知 execute 漏标 minimumRisk 时 fail-closed，不能变成 Task 未知命令通行证', async () => {
    const fixture = createFixture()
    const leaked = {
      ...createIntent('execute-command'),
      targets: [{ kind: 'command' as const, value: 'Runtime 未提供可信的结构化命令。' }],
      parameterFingerprint: 'grok-acp:execute:unknown-command:v1'
    }
    const firstExecute = vi.fn(() => 'ran')
    await expect(fixture.broker.authorizeOperation(leaked, firstExecute)).resolves.toMatchObject({
      ok: false
    })
    expect(firstExecute).not.toHaveBeenCalled()
    expect(fixture.approvals).toHaveLength(0)

    const marked = { ...leaked, minimumRisk: 'L3' as const, turnId: 'turn-2' }
    const secondExecute = vi.fn(() => 'ran-2')
    const second = fixture.broker.authorizeOperation(marked, secondExecute)
    const approval = await waitForApproval(fixture.approvals, 0)
    expect(approval).toMatchObject({ risk: 'L3', allowedScopes: ['once'] })
    expect(approval.allowedScopes).not.toContain('task')

    await fixture.broker.shutdown()
    await expect(second).resolves.toEqual({ ok: false, reason: 'cancelled' })
    expect(secondExecute).not.toHaveBeenCalled()
  })

  it('可信命令的 Task grant 不能覆盖另一条不同指纹的命令', async () => {
    const fixture = createFixture()
    const first = fixture.broker.authorizeOperation(
      { ...createIntent('execute-command'), parameterFingerprint: 'cmd-a' },
      vi.fn(() => 'a')
    )
    const approval = await waitForApproval(fixture.approvals, 0)
    await fixture.broker.respond({
      approvalId: approval.approvalId,
      taskId: approval.taskId,
      turnId: approval.turnId,
      decision: 'allow-task'
    })
    await expect(first).resolves.toMatchObject({ ok: true, value: 'a', scope: 'task' })

    await expect(
      fixture.broker.authorizeOperation(
        {
          ...createIntent('execute-command'),
          turnId: 'turn-2',
          parameterFingerprint: 'cmd-a'
        },
        vi.fn(() => 'a-again')
      )
    ).resolves.toMatchObject({ ok: true, value: 'a-again', reason: 'grant-reused' })

    const otherCommand = fixture.broker.authorizeOperation(
      {
        ...createIntent('execute-command'),
        turnId: 'turn-2',
        parameterFingerprint: 'cmd-b'
      },
      vi.fn()
    )
    await waitForApproval(fixture.approvals, 1)
    await fixture.broker.shutdown()
    await expect(otherCommand).resolves.toEqual({ ok: false, reason: 'cancelled' })
  })
})

function createFixture(
  options: {
    deliverApproval?: boolean
    auditFails?: boolean
    redactText?: (text: string) => string
    context?: Partial<import('./permission-broker').PermissionIntentContext>
  } = {}
): {
  broker: PermissionBroker
  approvals: AgentPermissionRequest[]
  audits: PermissionAuditRecord[]
  advanceTime: (milliseconds: number) => void
  runTimers: () => Promise<void>
  setAuditHook: (hook?: () => Promise<void>) => void
  cancellations: import('../../shared/agent-ipc').AgentPermissionCancellation[]
} {
  const approvals: AgentPermissionRequest[] = []
  const audits: PermissionAuditRecord[] = []
  const cancellations: import('../../shared/agent-ipc').AgentPermissionCancellation[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  let now = Date.parse('2026-08-12T00:00:00.000Z')
  let nextId = 1
  let auditHook: (() => Promise<void>) | undefined
  const auditStore = {
    append: vi.fn(async (record: PermissionAuditRecord) => {
      if (options.auditFails) throw new Error('disk failed')
      await auditHook?.()
      audits.push(record)
    })
  } as unknown as PermissionAuditStore
  const broker = new PermissionBroker({
    auditStore,
    onApproval: (approval) => {
      approvals.push(approval)
      return options.deliverApproval !== false
    },
    onApprovalCancelled: (request) => cancellations.push(request),
    resolveIntentContext: (_taskId, turnId) => {
      const intent = createIntent('write-file')
      return {
        taskId: intent.taskId,
        turnId,
        projectId: intent.projectId,
        executionRoot: intent.executionRoot,
        environmentId: intent.environmentId,
        runtimeId: 'grok',
        environmentKind: 'local',
        active: true,
        ...options.context
      }
    },
    createId: () => `id-${nextId++}`,
    now: () => now,
    redactText: options.redactText,
    setTimer: (callback) => {
      const id = nextTimer++
      timers.set(id, callback)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => timers.delete(timer as unknown as number)
  })
  return {
    broker,
    approvals,
    audits,
    cancellations,
    advanceTime: (milliseconds) => {
      now += milliseconds
    },
    runTimers: async () => {
      const callbacks = [...timers.values()]
      timers.clear()
      callbacks.forEach((callback) => callback())
      await Promise.resolve()
      await Promise.resolve()
    },
    setAuditHook: (hook) => {
      auditHook = hook
    }
  }
}

function createIntent(operationType: OperationIntent['operationType']): OperationIntent {
  const executionRoot = process.cwd()
  const targets: OperationIntent['targets'] =
    operationType === 'read-project'
      ? [{ kind: 'project', value: 'project-1' }]
      : operationType === 'execute-command'
        ? [{ kind: 'command', value: '未提供结构化命令' }]
        : [{ kind: 'path', value: 'src/shared/agent.ts' }]
  return {
    initiator: { kind: 'runtime', runtimeId: 'grok' },
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    environmentId: createLocalEnvironmentId('project-1', executionRoot),
    executionRoot,
    operationType,
    targets,
    parameterFingerprint: 'edit:v1',
    title: '执行受控操作',
    impact: '可能修改当前 Project。'
  }
}

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

async function waitUntil(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('条件未在预期时间内成立。')
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void
  })
  return { promise, resolve }
}

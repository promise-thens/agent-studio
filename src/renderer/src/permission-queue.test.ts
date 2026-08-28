import { describe, expect, it } from 'vitest'
import type { AgentPermissionRequest } from '../../shared/agent'
import {
  clearRespondingPermission,
  clearPermissionQueueState,
  enqueuePermissionRequest,
  getNextPermissionExpiry,
  isPermissionResponsePending,
  matchesPermissionIdentity,
  reconcilePermissionRequests,
  removeExpiredPermissionRequests,
  removePermissionRequest
} from './permission-queue'

describe('Renderer 权限审批队列', () => {
  it('按 FIFO 入队并按 approvalId 去重，响应后显示下一项', () => {
    const now = Date.parse('2026-08-12T00:00:00.000Z')
    const first = createRequest('approval-1', '2026-08-12T00:01:00.000Z')
    const second = createRequest('approval-2', '2026-08-12T00:02:00.000Z')
    let queue = enqueuePermissionRequest([], first, now)
    queue = enqueuePermissionRequest(queue, first, now)
    queue = enqueuePermissionRequest(queue, second, now)
    expect(queue.map((item) => item.approvalId)).toEqual(['approval-1', 'approval-2'])
    expect(removePermissionRequest(queue, first)[0]?.approvalId).toBe('approval-2')
  })

  it('同一张卡补路径时原地更新 targets，不新增队列项', () => {
    const now = Date.parse('2026-08-12T00:00:00.000Z')
    const first = createRequest('approval-1', '2026-08-12T00:01:00.000Z')
    const updated = {
      ...first,
      targets: ['path: src/index.ts', 'path: src/auth.ts']
    }
    let queue = enqueuePermissionRequest([], first, now)
    queue = enqueuePermissionRequest(queue, updated, now)
    expect(queue).toHaveLength(1)
    expect(queue[0]?.targets).toEqual(['path: src/index.ts', 'path: src/auth.ts'])
  })

  it('主进程取消队首或队中时只移除目标项，剩余审批顺序不变', () => {
    const queue = [
      createRequest('approval-1', '2026-08-12T00:01:00.000Z'),
      createRequest('approval-2', '2026-08-12T00:02:00.000Z'),
      createRequest('approval-3', '2026-08-12T00:03:00.000Z')
    ]

    expect(removePermissionRequest(queue, queue[1]!).map((item) => item.approvalId)).toEqual([
      'approval-1',
      'approval-3'
    ])
    expect(removePermissionRequest(queue, queue[0]!).map((item) => item.approvalId)).toEqual([
      'approval-2',
      'approval-3'
    ])
  })

  it('相同 approvalId 的旧取消事件不会误删其他 Task/Turn 请求', () => {
    const current = createRequest('shared-approval', '2026-08-12T00:02:00.000Z')
    const otherTask = { ...current, taskId: 'task-2' }
    const otherTurn = { ...current, turnId: 'turn-2' }
    const queue = [current, otherTask, otherTurn]

    expect(removePermissionRequest(queue, current)).toEqual([otherTask, otherTurn])
    expect(matchesPermissionIdentity(current, current)).toBe(true)
    expect(matchesPermissionIdentity(current, otherTask)).toBe(false)
    expect(matchesPermissionIdentity(current, otherTurn)).toBe(false)
  })

  it('旧请求在途不阻塞新队首，且旧 finally 不会清除新响应身份', () => {
    const oldRequest = createRequest('approval-old', '2026-08-12T00:02:00.000Z')
    const nextRequest = createRequest('approval-next', '2026-08-12T00:03:00.000Z')

    expect(isPermissionResponsePending(oldRequest, oldRequest)).toBe(true)
    expect(isPermissionResponsePending(nextRequest, oldRequest)).toBe(false)
    expect(clearRespondingPermission(nextRequest, oldRequest)).toEqual(nextRequest)
    expect(clearRespondingPermission(nextRequest, nextRequest)).toBeNull()
  })

  it('丢弃无效或已过期请求，并按最早 expiresAt 清理全部到期项', () => {
    const now = Date.parse('2026-08-12T00:01:30.000Z')
    const expired = createRequest('expired', '2026-08-12T00:01:00.000Z')
    const next = createRequest('next', '2026-08-12T00:02:00.000Z')
    const later = createRequest('later', '2026-08-12T00:03:00.000Z')
    expect(enqueuePermissionRequest([], expired, now)).toEqual([])
    expect(enqueuePermissionRequest([], { ...expired, expiresAt: 'invalid' }, now)).toEqual([])
    expect(getNextPermissionExpiry([later, next])).toBe(Date.parse(next.expiresAt))
    expect(removeExpiredPermissionRequests([expired, next, later], now)).toEqual([next, later])
  })

  it('Task 或 Project 切换会批量分离旧请求，Turn 清理可按身份过滤', () => {
    const queue = [
      createRequest('active', '2026-08-12T00:02:00.000Z'),
      { ...createRequest('other-task', '2026-08-12T00:02:00.000Z'), taskId: 'task-2' },
      { ...createRequest('other-project', '2026-08-12T00:02:00.000Z'), projectId: 'project-2' }
    ]
    const result = reconcilePermissionRequests(queue, 'task-1', 'project-1')
    expect(result.active.map((item) => item.approvalId)).toEqual(['active'])
    expect(result.stale.map((item) => item.approvalId)).toEqual(['other-task', 'other-project'])
    expect(
      result.active.filter((item) => item.taskId !== 'task-1' || item.turnId !== 'turn-1')
    ).toEqual([])
  })

  it('Runtime 断开会同时清空全部审批与响应中状态', () => {
    const state = clearPermissionQueueState()
    expect(state).toEqual({ queue: [], respondingPermission: null })
  })
})

function createRequest(approvalId: string, expiresAt: string): AgentPermissionRequest {
  return {
    approvalId,
    initiator: 'runtime',
    runtimeId: 'grok',
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    environmentId: 'local:test',
    operationType: 'write-file',
    risk: 'L1',
    title: '修改文件',
    impact: '写入 Project 文件。',
    targets: ['path: src/index.ts'],
    allowedScopes: ['once', 'task'],
    expiresAt
  }
}

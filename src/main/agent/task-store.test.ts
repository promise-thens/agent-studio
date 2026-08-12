import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentRuntimeCapabilitySnapshot } from '../../shared/agent'
import { ProjectRegistry } from '../project/project-registry'
import { AtomicJsonWriter } from '../storage/atomic-json-file'
import { TaskStore, projectPersistedAgentEvent } from './task-store'

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-studio-task-store-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function capabilitySnapshot(): AgentRuntimeCapabilitySnapshot {
  const ids = [
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
  ] as const
  return {
    runtimeId: 'grok',
    observedAt: '2026-08-12T00:00:00.000Z',
    capabilities: Object.fromEntries(
      ids.map((capabilityId) => [
        capabilityId,
        {
          capabilityId,
          support:
            capabilityId === 'session.resume' || capabilityId === 'session.load'
              ? 'native'
              : 'unknown',
          ...(capabilityId === 'session.resume' || capabilityId === 'session.load'
            ? { maturity: 'stable' as const }
            : {}),
          verification:
            capabilityId === 'session.resume'
              ? 'verified'
              : capabilityId === 'session.load'
                ? 'declared'
                : 'unverified',
          source:
            capabilityId === 'session.resume'
              ? 'runtime'
              : capabilityId === 'session.load'
                ? 'protocol'
                : 'fallback'
        }
      ])
    ) as AgentRuntimeCapabilitySnapshot['capabilities']
  }
}

async function createStore(): Promise<{
  store: TaskStore
  registry: ProjectRegistry
  userDataPath: string
  project: Awaited<ReturnType<ProjectRegistry['register']>>
}> {
  const userDataPath = await createTemporaryDirectory()
  const projectPath = join(await createTemporaryDirectory(), 'project')
  await mkdir(projectPath)
  const registry = new ProjectRegistry({ userDataPath, createId: () => 'project-1' })
  await registry.initialize()
  const project = await registry.register(projectPath)
  const store = new TaskStore({ projectRegistry: registry, createId: () => 'delete-token' })
  await store.initialize()
  await store.createTask({
    taskId: 'task-1',
    projectId: project.projectId,
    root: project.canonicalRoot,
    runtimeId: 'grok',
    session: {
      runtimeId: 'grok',
      runtimeSessionId: 'private-session',
      workspace: project.canonicalRoot
    },
    capabilitySnapshot: capabilitySnapshot()
  })
  return { store, registry, userDataPath, project }
}

describe('TaskStore', () => {
  it('持久化 Turn 和完整展示事件，但历史 DTO/事件文件不暴露 session ID', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: 'fake-secret',
      model: { modelId: 'model-1' }
    })
    await store.markTurnDispatched('task-1', 'turn-1')
    const event = projectPersistedAgentEvent(
      {
        runtimeId: 'grok',
        capabilityState: 'native',
        runtimeSessionId: 'private-session',
        taskId: 'task-1',
        turnId: 'turn-1',
        sequence: 1,
        observedAt: '2026-08-12T00:00:00.000Z',
        kind: 'agent-thought',
        text: 'Bearer fake-secret'
      },
      (text) => text.replaceAll('fake-secret', '[REDACTED]')
    )
    await store.appendEvent(event)
    await store.finishTurn('task-1', 'turn-1', 'completed')

    expect(await store.listTurns('task-1')).toMatchObject({
      items: [{ state: 'completed', model: { modelId: 'model-1' } }]
    })
    expect(JSON.stringify(await store.listEvents('task-1', 'turn-1'))).not.toContain(
      'private-session'
    )
    const disk = await readFile(
      join(
        registry.getProjectDirectory(project.projectId),
        'tasks/task-1/turns/turn-1/events/000001.json'
      ),
      'utf8'
    )
    expect(disk).not.toContain('fake-secret')
  })

  it('事件块超过 512KiB 时递增块号，不覆盖已经落盘的前一块', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      await store.appendEvent({
        runtimeId: 'grok',
        capabilityState: 'native',
        taskId: 'task-1',
        turnId: 'turn-1',
        sequence,
        observedAt: `2026-08-12T00:00:0${sequence}.000Z`,
        kind: 'agent-message',
        text: 'a'.repeat(250 * 1024)
      })
    }
    expect(
      (await store.listEvents('task-1', 'turn-1', 0, 10)).items.map((event) => event.sequence)
    ).toEqual([1, 2, 3])
  })

  it('重启将未完成 Task/Turn 收束为 interrupted', async () => {
    const { store, registry } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    await store.markTurnDispatched('task-1', 'turn-1')
    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    expect(restarted.getTaskDetail('task-1').state).toBe('interrupted')
    expect((await restarted.listTurns('task-1')).items[0]?.state).toBe('interrupted')
  })

  it('删除 token 一次性绑定 revision，并只删除本地 Task 目录', async () => {
    const { store } = await createStore()
    const preview = await store.previewTaskDeletion('task-1')
    await store.deleteTask('task-1', preview.token)
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
    await expect(store.deleteTask('task-1', preview.token)).rejects.toThrow()
  })

  it('单事件超过 256KiB 时只标记截断，Runtime 历史队列仍可继续', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })

    await expect(
      store.appendEvent({
        runtimeId: 'grok',
        capabilityState: 'native',
        taskId: 'task-1',
        turnId: 'turn-1',
        sequence: 1,
        observedAt: '2026-08-12T00:00:00.000Z',
        kind: 'agent-message',
        text: 'x'.repeat(257 * 1024)
      })
    ).resolves.toBe(false)
    expect((await store.listTurns('task-1')).items[0]).toMatchObject({
      historyTruncated: true,
      truncationReason: 'event-bytes',
      eventCount: 0
    })
  })

  it('未知事件块原位保留且禁止覆盖，损坏 Task 目录只隔离自身', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    const futureChunkPath = join(
      registry.getProjectDirectory(project.projectId),
      'tasks/task-1/turns/turn-1/events/000001.json'
    )
    await mkdir(join(futureChunkPath, '..'), { recursive: true })
    await writeFile(
      futureChunkPath,
      JSON.stringify({
        schemaVersion: 2,
        taskId: 'task-1',
        turnId: 'turn-1',
        chunkIndex: 1,
        events: []
      })
    )

    await expect(
      store.appendEvent({
        runtimeId: 'grok',
        capabilityState: 'native',
        taskId: 'task-1',
        turnId: 'turn-1',
        sequence: 1,
        observedAt: '2026-08-12T00:00:00.000Z',
        kind: 'agent-message',
        text: '不会覆盖'
      })
    ).rejects.toMatchObject({ code: 'history-version-unsupported' })
    await expect(readFile(futureChunkPath, 'utf8')).resolves.toContain('"schemaVersion":2')

    const corruptTaskPath = join(registry.getProjectDirectory(project.projectId), 'tasks/corrupt')
    await mkdir(corruptTaskPath, { recursive: true })
    await writeFile(join(corruptTaskPath, 'task.json'), '{broken')
    const restarted = new TaskStore({ projectRegistry: registry, createId: () => 'quarantine' })
    await restarted.initialize()
    expect(restarted.getTaskDetail('task-1').taskId).toBe('task-1')
    await expect(readFile(join(corruptTaskPath, 'task.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rename 后清理失败仍从活动索引删除，并由下一次启动重试 deleting', async () => {
    const { store, registry } = await createStore()
    const originalWriter = (store as unknown as { writer: AtomicJsonWriter }).writer
    const removeDurably = originalWriter.removeDurably.bind(originalWriter)
    let failedDeletingPath = ''
    originalWriter.removeDurably = async (path: string) => {
      if (path.includes('/deleting/')) {
        failedDeletingPath = path
        throw new Error('模拟清理失败')
      }
      return removeDurably(path)
    }

    const preview = await store.previewTaskDeletion('task-1')
    await store.deleteTask('task-1', preview.token)
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
    expect(failedDeletingPath).toContain('/deleting/')
    expect(await readdir(join(registry.historyRoot, 'deleting'))).toHaveLength(1)

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    expect(await readdir(join(registry.historyRoot, 'deleting'))).toHaveLength(0)
  })
})

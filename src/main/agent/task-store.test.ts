import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentRuntimeCapabilitySnapshot } from '../../shared/agent'
import {
  GROK_TAKEOVER_CONTROL_PROMPT,
  TAKEOVER_CONTROL_TURN_KIND
} from '../../shared/task-takeover'
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

async function createStore(
  options: {
    writer?: AtomicJsonWriter
    createId?: () => string
  } = {}
): Promise<{
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
  const store = new TaskStore({
    projectRegistry: registry,
    writer: options.writer,
    createId: options.createId ?? (() => 'delete-token')
  })
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
  it('新建 Task 默认未接管，且不写 takeoverUpdatedAt', async () => {
    const { store } = await createStore()
    const record = store.getTaskRecord('task-1')
    expect(record.takeoverEnabled).toBe(false)
    expect(record.permissionPromptStyle).toBe('assist')
    expect(record).not.toHaveProperty('takeoverUpdatedAt')
    expect(record).not.toHaveProperty('takeoverApplied')
  })

  it('缺 takeover 字段的旧 task.json 读成 false 且 Task 仍可用', async () => {
    const { registry, project } = await createStore()
    const taskPath = join(registry.getProjectDirectory(project.projectId), 'tasks/task-1/task.json')
    const disk = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>
    delete disk.takeoverEnabled
    delete disk.takeoverUpdatedAt
    await writeFile(taskPath, JSON.stringify(disk))

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    const record = restarted.getTaskRecord('task-1')
    expect(record.takeoverEnabled).toBe(false)
    expect(record.permissionPromptStyle).toBe('assist')
    expect(record).not.toHaveProperty('takeoverUpdatedAt')
    expect(record.taskId).toBe('task-1')
    expect(record.state).toBe('pending')
  })

  it('非法 takeover 类型 fail-closed 为 false，不把 Task 标 corrupt', async () => {
    const { registry, project } = await createStore()
    const taskPath = join(registry.getProjectDirectory(project.projectId), 'tasks/task-1/task.json')
    const disk = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>
    disk.takeoverEnabled = 'true'
    disk.takeoverUpdatedAt = 123
    await writeFile(taskPath, JSON.stringify(disk))

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    const record = restarted.getTaskRecord('task-1')
    expect(record.takeoverEnabled).toBe(false)
    expect(record.permissionPromptStyle).toBe('assist')
    expect(record).not.toHaveProperty('takeoverUpdatedAt')
    expect(record.taskId).toBe('task-1')
  })

  it('updateTaskPermissionMode 写盘，旧 JSON 缺 style 读成 assist', async () => {
    const { store } = await createStore()
    const updated = await store.updateTaskPermissionMode('task-1', {
      takeoverEnabled: true,
      permissionPromptStyle: 'ask',
      takeoverApplied: true
    })
    expect(updated.takeoverEnabled).toBe(true)
    expect(updated.permissionPromptStyle).toBe('ask')
    expect(updated.takeoverApplied).toBe(true)
    expect(updated.takeoverUpdatedAt).toEqual(expect.any(String))
  })

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

  it('持久化接管控制 Turn 但从普通 Turn 列表隐藏', async () => {
    const { store, registry, project } = await createStore()
    const environmentId = store.getTaskRecord('task-1').environment.environmentId
    const admitted = await store.admitExecutionTurn({
      taskId: 'task-1',
      turnId: 'turn-control',
      executionId: 'execution-control',
      environmentId,
      promptDisplayText: GROK_TAKEOVER_CONTROL_PROMPT,
      model: { modelId: 'model-1' },
      turnKind: TAKEOVER_CONTROL_TURN_KIND
    })
    expect(admitted.turnKind).toBe(TAKEOVER_CONTROL_TURN_KIND)
    await store.finishTurn('task-1', 'turn-control', 'completed')
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-user',
      promptDisplayText: '用户任务',
      model: { modelId: 'model-1' }
    })

    const page = await store.listTurns('task-1')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ turnId: 'turn-user', promptDisplayText: '用户任务' })

    const controlDisk = JSON.parse(
      await readFile(
        join(
          registry.getProjectDirectory(project.projectId),
          'tasks/task-1/turns/turn-control/turn.json'
        ),
        'utf8'
      )
    ) as Record<string, unknown>
    expect(controlDisk).toMatchObject({
      promptDisplayText: GROK_TAKEOVER_CONTROL_PROMPT,
      turnKind: TAKEOVER_CONTROL_TURN_KIND
    })
  })

  it('附件事件持久化后仍只保存 inbox 引用', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '生成图片',
      model: { modelId: 'model-1' }
    })
    await store.appendEvent(
      projectPersistedAgentEvent(
        {
          runtimeId: 'grok',
          capabilityState: 'native',
          runtimeSessionId: 'private-session',
          taskId: 'task-1',
          turnId: 'turn-1',
          sequence: 1,
          observedAt: '2026-08-12T00:00:00.000Z',
          kind: 'agent-attachment',
          attachmentId: 'attachment-1',
          attachmentKind: 'image',
          originalName: 'fake-secret.png'
        },
        (text) => text.replaceAll('fake-secret', '[REDACTED]')
      )
    )

    const page = await store.listEvents('task-1', 'turn-1')
    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'agent-attachment',
        attachmentId: 'attachment-1',
        attachmentKind: 'image',
        originalName: '[REDACTED].png'
      })
    ])
    expect(JSON.stringify(page)).not.toContain('private-session')
    expect(JSON.stringify(page)).not.toContain('base64')
  })

  it('工具事件 parentId 可持久化往返，未知键不得落盘', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '派出子任务',
      model: { modelId: 'model-1' }
    })
    await store.appendEvent(
      projectPersistedAgentEvent(
        {
          runtimeId: 'grok',
          capabilityState: 'native',
          runtimeSessionId: 'private-session',
          taskId: 'task-1',
          turnId: 'turn-1',
          sequence: 1,
          observedAt: '2026-08-12T00:00:00.000Z',
          kind: 'tool-call',
          toolCallId: 'child-1',
          title: '读取文件',
          status: 'in_progress',
          parentId: 'parent-fake-secret',
          parentToolCallId: 'should-drop',
          rawInput: { apiKey: 'fake-secret' }
        } as unknown as AgentEvent,
        (text) => text.replaceAll('fake-secret', '[REDACTED]')
      )
    )

    const page = await store.listEvents('task-1', 'turn-1')
    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'tool-call',
        toolCallId: 'child-1',
        title: '读取文件',
        status: 'in_progress',
        parentId: 'parent-[REDACTED]'
      })
    ])
    const serialized = JSON.stringify(page)
    expect(serialized).not.toContain('private-session')
    expect(serialized).not.toContain('parentToolCallId')
    expect(serialized).not.toContain('rawInput')
    expect(serialized).not.toContain('fake-secret')
  })

  it('无 parentId 的工具事件持久化后仍不含该键', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '普通工具',
      model: { modelId: 'model-1' }
    })
    await store.appendEvent(
      projectPersistedAgentEvent(
        {
          runtimeId: 'grok',
          capabilityState: 'native',
          runtimeSessionId: 'private-session',
          taskId: 'task-1',
          turnId: 'turn-1',
          sequence: 1,
          observedAt: '2026-08-12T00:00:00.000Z',
          kind: 'tool-update',
          toolCallId: 'tool-1',
          title: '子 Agent 改登录逻辑',
          status: 'completed'
        },
        (text) => text
      )
    )

    const page = await store.listEvents('task-1', 'turn-1')
    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'tool-update',
        toolCallId: 'tool-1',
        title: '子 Agent 改登录逻辑',
        status: 'completed'
      })
    ])
    expect(page.items[0]).not.toHaveProperty('parentId')
  })

  it('同 Task 重绑 Runtime session 时保留历史身份，且详情 DTO 仍不暴露 session ID', async () => {
    const { store, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '第一轮',
      model: { modelId: 'model-1' }
    })
    await store.finishTurn('task-1', 'turn-1', 'completed')

    const rebound = await store.rebindRuntimeSession(
      'task-1',
      {
        runtimeId: 'grok',
        runtimeSessionId: 'replacement-session',
        workspace: project.canonicalRoot
      },
      capabilitySnapshot()
    )

    expect(rebound.taskId).toBe('task-1')
    expect(rebound.turnCount).toBe(1)
    expect(rebound.environment.projectId).toBe(project.projectId)
    expect(rebound.runtimeSession.runtimeSessionId).toBe('replacement-session')
    expect(store.getTaskRecord('task-1').runtimeSession.runtimeSessionId).toBe(
      'replacement-session'
    )
    expect(JSON.stringify(store.getTaskDetail('task-1'))).not.toContain('replacement-session')
    expect(await store.listTurns('task-1')).toMatchObject({
      items: [{ turnId: 'turn-1', state: 'completed' }]
    })
  })

  it('相同事件重复写入幂等，相同 sequence 不同内容失败关闭', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    const event = {
      runtimeId: 'grok' as const,
      capabilityState: 'native' as const,
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-12T00:00:01.000Z',
      kind: 'agent-message' as const,
      text: '完成'
    }

    await expect(store.appendEvent(event)).resolves.toEqual({ kind: 'committed' })
    await expect(store.appendEvent(event)).resolves.toEqual({ kind: 'duplicate' })
    await expect(store.appendEvent({ ...event, text: '冲突内容' })).rejects.toMatchObject({
      code: 'history-corrupt'
    })
    expect((await store.listEvents('task-1', 'turn-1')).items).toHaveLength(1)
    expect((await store.listTurns('task-1')).items[0]).toMatchObject({ eventCount: 1 })
  })

  it('事件块已提交但 Turn 元数据失败时，同事件重试只修复元数据', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    const writer = (store as unknown as { writer: AtomicJsonWriter }).writer
    const originalWrite = writer.write.bind(writer)
    let failedTurnWrite = false
    writer.write = async (path, value) => {
      if (
        !failedTurnWrite &&
        path.endsWith('/turn-1/turn.json') &&
        (value as { eventCount?: number }).eventCount === 1
      ) {
        failedTurnWrite = true
        throw new Error('fake turn metadata failure')
      }
      await originalWrite(path, value)
    }
    const event = {
      runtimeId: 'grok' as const,
      capabilityState: 'native' as const,
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-12T00:00:01.000Z',
      kind: 'agent-message' as const,
      text: '完成'
    }

    await expect(store.appendEvent(event)).rejects.toThrow('fake turn metadata failure')
    const eventPath = join(
      registry.getProjectDirectory(project.projectId),
      'tasks/task-1/turns/turn-1/events/000001.json'
    )
    expect(
      (JSON.parse(await readFile(eventPath, 'utf8')) as { events: unknown[] }).events
    ).toHaveLength(1)
    await expect(store.appendEvent(event)).resolves.toEqual({ kind: 'repaired' })
    await expect(store.appendEvent(event)).resolves.toEqual({ kind: 'duplicate' })
    expect((await store.listEvents('task-1', 'turn-1')).items).toHaveLength(1)
    expect((await store.listTurns('task-1')).items[0]).toMatchObject({ eventCount: 1 })
  })

  it('事件分页按 sequence 排序去重并返回数值 watermark', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    const eventsDirectory = join(
      registry.getProjectDirectory(project.projectId),
      'tasks/task-1/turns/turn-1/events'
    )
    await mkdir(eventsDirectory, { recursive: true })
    const event = (
      sequence: number,
      text = `事件 ${sequence}`
    ): {
      runtimeId: 'grok'
      capabilityState: 'native'
      taskId: string
      turnId: string
      sequence: number
      observedAt: string
      kind: 'agent-message'
      text: string
    } => ({
      runtimeId: 'grok' as const,
      capabilityState: 'native' as const,
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence,
      observedAt: `2026-08-12T00:00:0${sequence}.000Z`,
      kind: 'agent-message' as const,
      text
    })
    await writeFile(
      join(eventsDirectory, '000001.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskId: 'task-1',
        turnId: 'turn-1',
        chunkIndex: 1,
        events: [event(3), event(1), event(2)]
      })
    )
    await writeFile(
      join(eventsDirectory, '000002.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskId: 'task-1',
        turnId: 'turn-1',
        chunkIndex: 2,
        events: [event(2)]
      })
    )

    await expect(store.listEvents('task-1', 'turn-1', 0, 2)).resolves.toEqual({
      items: [event(1), event(2)],
      nextAfterSequence: 2,
      watermark: 3
    })
    await expect(store.listEvents('task-1', 'turn-1', 2, 2)).resolves.toEqual({
      items: [event(3)],
      watermark: 3
    })
    await writeFile(
      join(eventsDirectory, '000002.json'),
      JSON.stringify({
        schemaVersion: 1,
        taskId: 'task-1',
        turnId: 'turn-1',
        chunkIndex: 2,
        events: [event(2, '冲突')]
      })
    )
    await expect(store.listEvents('task-1', 'turn-1')).rejects.toMatchObject({
      code: 'history-corrupt'
    })
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

  it.each(['pending', 'queued', 'running', 'waiting-permission', 'cancelling'] as const)(
    '重启将 %s Task/Turn 收束为 interrupted 且重复初始化幂等',
    async (state) => {
      const { store, registry, project } = await createStore()
      await store.admitExecutionTurn({
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1',
        environmentId: store.getTaskRecord('task-1').environment.environmentId,
        promptDisplayText: '测试',
        model: { modelId: 'model-1' }
      })
      const taskPath = join(
        registry.getProjectDirectory(project.projectId),
        'tasks/task-1/task.json'
      )
      const turnPath = join(
        registry.getProjectDirectory(project.projectId),
        'tasks/task-1/turns/turn-1/turn.json'
      )
      const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>
      const turn = JSON.parse(await readFile(turnPath, 'utf8')) as Record<string, unknown>
      task.state = state
      turn.state = state
      await writeFile(taskPath, JSON.stringify(task))
      await writeFile(turnPath, JSON.stringify(turn))

      const restarted = new TaskStore({ projectRegistry: registry })
      await restarted.initialize()
      expect(restarted.getTaskDetail('task-1').state).toBe('interrupted')
      expect((await restarted.listTurns('task-1')).items[0]?.state).toBe('interrupted')
      expect(restarted.getTaskRecord('task-1').activeExecutionId).toBeUndefined()
      const firstTaskDisk = await readFile(taskPath, 'utf8')
      const firstTurnDisk = await readFile(turnPath, 'utf8')

      const restartedAgain = new TaskStore({ projectRegistry: registry })
      await restartedAgain.initialize()
      expect(await readFile(taskPath, 'utf8')).toBe(firstTaskDisk)
      expect(await readFile(turnPath, 'utf8')).toBe(firstTurnDisk)
    }
  )

  it('Turn 已完成而 Task 仍运行时保留可信终态并只修复 Task', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    await store.markTurnDispatched('task-1', 'turn-1')
    const taskPath = join(registry.getProjectDirectory(project.projectId), 'tasks/task-1/task.json')
    const turnPath = join(
      registry.getProjectDirectory(project.projectId),
      'tasks/task-1/turns/turn-1/turn.json'
    )
    const turn = JSON.parse(await readFile(turnPath, 'utf8')) as Record<string, unknown>
    turn.state = 'completed'
    turn.endedAt = '2026-08-12T00:01:00.000Z'
    turn.stateChangedAt = turn.endedAt
    turn.revision = Number(turn.revision) + 1
    await writeFile(turnPath, JSON.stringify(turn))

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    expect(restarted.getTaskDetail('task-1').state).toBe('completed')
    expect((await restarted.listTurns('task-1')).items[0]).toMatchObject({
      state: 'completed',
      endedAt: '2026-08-12T00:01:00.000Z'
    })
    expect(JSON.parse(await readFile(taskPath, 'utf8'))).toMatchObject({
      state: 'completed'
    })
  })

  it('缺失活动 Turn 时 Task 失败关闭为 interrupted 并清除执行身份', async () => {
    const { store, registry, project } = await createStore()
    await store.admitExecutionTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      executionId: 'execution-1',
      environmentId: store.getTaskRecord('task-1').environment.environmentId,
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    await rm(join(registry.getProjectDirectory(project.projectId), 'tasks/task-1/turns/turn-1'), {
      recursive: true,
      force: true
    })

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    expect(restarted.getTaskRecord('task-1')).toMatchObject({ state: 'interrupted' })
    expect(restarted.getTaskRecord('task-1').activeTurnId).toBeUndefined()
    expect(restarted.getTaskRecord('task-1').activeExecutionId).toBeUndefined()
  })

  it('V1 Task 初始化时升级环境身份但不为旧 Turn 编造 executionId', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '旧历史',
      model: { modelId: 'model-1' }
    })
    const taskPath = join(registry.getProjectDirectory(project.projectId), 'tasks/task-1/task.json')
    const turnPath = join(
      registry.getProjectDirectory(project.projectId),
      'tasks/task-1/turns/turn-1/turn.json'
    )
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>
    const environment = task.environment as Record<string, unknown>
    task.schemaVersion = 1
    task.environment = {
      kind: 'local',
      projectId: environment.projectId,
      rootSnapshot: environment.rootSnapshot
    }
    const turn = JSON.parse(await readFile(turnPath, 'utf8')) as Record<string, unknown>
    turn.schemaVersion = 1
    delete turn.stateChangedAt
    await writeFile(taskPath, JSON.stringify(task))
    await writeFile(turnPath, JSON.stringify(turn))

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    expect(restarted.getTaskRecord('task-1').environment).toMatchObject({
      version: 1,
      environmentId: expect.stringMatching(/^local:/)
    })
    expect(JSON.parse(await readFile(turnPath, 'utf8'))).not.toHaveProperty('executionId')
  })

  it('同一 execution 终态重复提交返回 duplicate，部分提交重试修复 Task', async () => {
    const { store } = await createStore()
    const environmentId = store.getTaskRecord('task-1').environment.environmentId
    await store.admitExecutionTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      executionId: 'execution-1',
      environmentId,
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    await store.transitionExecution(
      { taskId: 'task-1', turnId: 'turn-1', executionId: 'execution-1' },
      'running',
      '2026-08-12T00:00:01.000Z'
    )
    const identity = { taskId: 'task-1', turnId: 'turn-1', executionId: 'execution-1' }
    await expect(
      store.commitExecutionTerminal(identity, {
        state: 'completed',
        endedAt: '2026-08-12T00:00:02.000Z'
      })
    ).resolves.toMatchObject({ kind: 'committed' })
    await expect(
      store.commitExecutionTerminal(identity, {
        state: 'completed',
        endedAt: '2026-08-12T00:10:00.000Z'
      })
    ).resolves.toMatchObject({ kind: 'duplicate' })
  })

  it('已有 legacy activeTurn 时拒绝新的 execution admission', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'legacy-turn',
      promptDisplayText: '旧 Turn',
      model: { modelId: 'model-1' }
    })
    await expect(
      store.admitExecutionTurn({
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1',
        environmentId: store.getTaskRecord('task-1').environment.environmentId,
        promptDisplayText: '新 Turn',
        model: { modelId: 'model-1' }
      })
    ).rejects.toMatchObject({ code: 'invalid-state' })
  })

  it('删除 token 一次性绑定 revision，并只删除本地 Task 目录', async () => {
    const { store } = await createStore()
    const preview = await store.previewTaskDeletion('task-1')
    await store.deleteTask('task-1', preview.token)
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
    await expect(store.deleteTask('task-1', preview.token)).rejects.toThrow()
  })

  it('删除准备 rollback 会恢复仍有效的一次性 token，commit 后不可再次使用', async () => {
    const { store } = await createStore()
    const preview = await store.previewTaskDeletion('task-1')
    const firstPreparation = store.prepareTaskDeletion('task-1', preview.token)
    firstPreparation.rollback()

    const retryPreparation = store.prepareTaskDeletion('task-1', preview.token)
    await retryPreparation.commit()
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
    expect(() => store.prepareTaskDeletion('task-1', preview.token)).toThrow()
  })

  it('Task 删除 reservation 拒绝后续写入，rollback 后恢复写入与 token', async () => {
    const { store } = await createStore()
    const preview = await store.previewTaskDeletion('task-1')
    const preparation = store.prepareTaskDeletion('task-1', preview.token)

    await expect(
      store.createTurn({
        taskId: 'task-1',
        turnId: 'turn-blocked',
        promptDisplayText: '不应落盘',
        model: { modelId: 'model-1' }
      })
    ).rejects.toMatchObject({ code: 'invalid-state' })
    expect(preparation.rollback()).toBe(true)

    await expect(
      store.createTurn({
        taskId: 'task-1',
        turnId: 'turn-allowed',
        promptDisplayText: '恢复写入',
        model: { modelId: 'model-1' }
      })
    ).resolves.toMatchObject({ turnId: 'turn-allowed' })
  })

  it('Task 删除等待已有写入排空，提交后不会重建幽灵目录', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '测试',
      model: { modelId: 'model-1' }
    })
    await store.finishTurn('task-1', 'turn-1', 'completed')
    const preview = await store.previewTaskDeletion('task-1')
    const writer = (store as unknown as { writer: AtomicJsonWriter }).writer
    const originalWrite = writer.write.bind(writer)
    const writeStarted = deferred<void>()
    const releaseWrite = deferred<void>()
    let blockTaskRecord = true
    writer.write = async (path, value) => {
      if (blockTaskRecord && path.endsWith('/turn-1/turn.json')) {
        blockTaskRecord = false
        writeStarted.resolve()
        await releaseWrite.promise
      }
      return originalWrite(path, value)
    }

    const mutation = store.appendEvent({
      runtimeId: 'grok',
      capabilityState: 'native',
      taskId: 'task-1',
      turnId: 'turn-1',
      sequence: 1,
      observedAt: '2026-08-12T00:00:00.000Z',
      kind: 'agent-message',
      text: '排队写入'
    })
    await writeStarted.promise
    const preparation = store.prepareTaskDeletion('task-1', preview.token)
    const commit = preparation.commit()
    let commitSettled = false
    void commit.finally(() => {
      commitSettled = true
    })
    await Promise.resolve()
    expect(commitSettled).toBe(false)

    releaseWrite.resolve()
    await mutation
    await expect(commit).resolves.toBeUndefined()
    expect(preparation.rollback()).toBe(false)
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
    await expect(
      readdir(join(registry.getProjectDirectory(project.projectId), 'tasks'))
    ).resolves.not.toContain('task-1')
  })

  it('Project 删除 reservation 拒绝新 Task，rollback 后允许创建', async () => {
    const { store, project } = await createStore()
    const preview = await store.previewProjectDeletion(project.projectId)
    const preparation = store.prepareProjectHistoryDeletion(project.projectId, preview.token)

    await expect(
      store.createTask({
        taskId: 'task-2',
        projectId: project.projectId,
        root: project.canonicalRoot,
        runtimeId: 'grok',
        session: {
          runtimeId: 'grok',
          runtimeSessionId: 'private-session-2',
          workspace: project.canonicalRoot
        },
        capabilitySnapshot: capabilitySnapshot()
      })
    ).rejects.toMatchObject({ code: 'invalid-state' })

    expect(preparation.rollback()).toBe(true)
    await expect(
      store.createTask({
        taskId: 'task-2',
        projectId: project.projectId,
        root: project.canonicalRoot,
        runtimeId: 'grok',
        session: {
          runtimeId: 'grok',
          runtimeSessionId: 'private-session-2',
          workspace: project.canonicalRoot
        },
        capabilitySnapshot: capabilitySnapshot()
      })
    ).resolves.toMatchObject({ taskId: 'task-2' })
  })

  it('删除 rename 失败时恢复 token，双 commit 只执行一次物理删除', async () => {
    const { store } = await createStore()
    const writer = (store as unknown as { writer: AtomicJsonWriter }).writer
    const originalRename = writer.renameDurably.bind(writer)
    let failRename = true
    const renameSpy = vi
      .spyOn(writer, 'renameDurably')
      .mockImplementation(async (source, target) => {
        if (failRename && source.endsWith('/tasks/task-1')) {
          failRename = false
          throw new Error('模拟 rename 失败')
        }
        return originalRename(source, target)
      })
    const preview = await store.previewTaskDeletion('task-1')
    const first = store.prepareTaskDeletion('task-1', preview.token)
    await expect(first.commit()).rejects.toThrow('删除提交失败')
    expect(first.rollback()).toBe(true)

    const retry = store.prepareTaskDeletion('task-1', preview.token)
    await Promise.all([retry.commit(), retry.commit()])
    expect(
      renameSpy.mock.calls.filter(([source]) => source.endsWith('/tasks/task-1'))
    ).toHaveLength(2)
    expect(retry.rollback()).toBe(false)
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
  })

  it('删除 rename 已完成但父目录同步失败时按磁盘结果提交且不恢复 token', async () => {
    const syncFailure = { directory: undefined as string | undefined, count: 0 }
    const writer = new AtomicJsonWriter({
      fileSystem: {
        open: async (path, flags, mode) => {
          if (path === syncFailure.directory && flags === 'r' && syncFailure.count === 0) {
            syncFailure.count += 1
            return {
              sync: async () => {
                throw Object.assign(new Error('模拟目录同步失败'), { code: 'EIO' })
              },
              close: async () => undefined
            } as unknown as Awaited<ReturnType<typeof open>>
          }
          return open(path, flags, mode)
        }
      }
    })
    const { store, registry, project } = await createStore({ writer })
    syncFailure.directory = join(registry.getProjectDirectory(project.projectId), 'tasks')
    const renameSpy = vi.spyOn(writer, 'renameDurably')
    const preview = await store.previewTaskDeletion('task-1')
    const preparation = store.prepareTaskDeletion('task-1', preview.token)

    await preparation.commit()
    await preparation.commit()

    expect(syncFailure.count).toBe(1)
    expect(
      renameSpy.mock.calls.filter(([source]) => source.endsWith('/tasks/task-1'))
    ).toHaveLength(1)
    expect(preparation.rollback()).toBe(false)
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
    await expect(readdir(syncFailure.directory)).resolves.not.toContain('task-1')
    await expect(readdir(join(registry.historyRoot, 'deleting'))).resolves.toEqual([])
  })

  it('容量淘汰跳过持有外部历史 mutation lease 的终态 Task', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '完成 Task 1',
      model: { modelId: 'model-1' }
    })
    await store.finishTurn('task-1', 'turn-1', 'completed')
    await store.createTask({
      taskId: 'task-2',
      projectId: project.projectId,
      root: project.canonicalRoot,
      runtimeId: 'grok',
      session: {
        runtimeId: 'grok',
        runtimeSessionId: 'private-session-2',
        workspace: project.canonicalRoot
      },
      capabilitySnapshot: capabilitySnapshot()
    })

    const mutationLease = store.beginTaskHistoryMutation('task-1')
    // 投影完整 256 MiB，稳定触发淘汰；Task 2 作为当前写入目标不会被淘汰。
    const oversizedProjection = 256 * 1024 * 1024
    await expect(
      store.ensureAdditionalHistoryCapacity('task-2', oversizedProjection)
    ).rejects.toMatchObject({ code: 'history-capacity-exceeded' })
    expect(store.getTaskDetail('task-1').state).toBe('completed')
    await expect(
      readdir(join(registry.getProjectDirectory(project.projectId), 'tasks'))
    ).resolves.toContain('task-1')

    mutationLease.release()
    await expect(
      store.ensureAdditionalHistoryCapacity('task-2', oversizedProjection)
    ).rejects.toMatchObject({ code: 'history-capacity-exceeded' })
    expect(() => store.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
    await expect(
      readdir(join(registry.getProjectDirectory(project.projectId), 'tasks'))
    ).resolves.not.toContain('task-1')
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
    ).resolves.toEqual({ kind: 'history-truncated', reason: 'event-bytes' })
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

  it('重命名只改展示标题，不碰 Runtime session 与项目文件', async () => {
    const { store, project } = await createStore()
    const before = store.getTaskRecord('task-1')

    const renamed = await store.renameTask('task-1', '  登录改邮箱  ')

    expect(renamed.title).toBe('登录改邮箱')
    expect(renamed.taskId).toBe('task-1')
    expect(renamed.projectId).toBe(project.projectId)
    expect(renamed.runtimeSession).toEqual(before.runtimeSession)
    expect(renamed.state).toBe(before.state)
    expect(renamed.turnCount).toBe(before.turnCount)
    expect(renamed.revision).toBe(before.revision + 1)
    expect(store.getTaskDetail('task-1').title).toBe('登录改邮箱')
    expect(store.getTaskRecord('task-1').runtimeSession.runtimeSessionId).toBe('private-session')
  })

  it('标题为空、仅空白或含 NUL 时拒绝重命名', async () => {
    const { store } = await createStore()
    const before = store.getTaskRecord('task-1')

    await expect(store.renameTask('task-1', '')).rejects.toMatchObject({ code: 'invalid-state' })
    await expect(store.renameTask('task-1', '   ')).rejects.toMatchObject({ code: 'invalid-state' })
    await expect(store.renameTask('task-1', 'bad\0title')).rejects.toMatchObject({
      code: 'invalid-state'
    })
    expect(store.getTaskRecord('task-1').title).toBe(before.title)
    expect(store.getTaskRecord('task-1').revision).toBe(before.revision)
  })

  it.each(['running', 'waiting-permission'] as const)(
    '%s Task 拒绝归档，且历史文件仍在',
    async (state) => {
      const { store } = await createStore()
      const environmentId = store.getTaskRecord('task-1').environment.environmentId
      await store.admitExecutionTurn({
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1',
        environmentId,
        promptDisplayText: '测试',
        model: { modelId: 'model-1' }
      })
      await store.transitionExecution(
        { taskId: 'task-1', turnId: 'turn-1', executionId: 'execution-1' },
        'running',
        '2026-08-12T00:00:01.000Z'
      )
      if (state === 'waiting-permission') {
        await store.transitionExecution(
          { taskId: 'task-1', turnId: 'turn-1', executionId: 'execution-1' },
          'waiting-permission',
          '2026-08-12T00:00:02.000Z'
        )
      }

      await expect(store.archiveTask('task-1')).rejects.toMatchObject({ code: 'invalid-state' })
      expect(store.getTaskRecord('task-1').archivedAt).toBeUndefined()
      expect(store.getTaskRecord('task-1').state).toBe(state)
    }
  )

  it.each(['running', 'waiting-permission'] as const)(
    '%s Task 拒绝删除，token 协议不变',
    async (state) => {
      const { store } = await createStore()
      const environmentId = store.getTaskRecord('task-1').environment.environmentId
      await store.admitExecutionTurn({
        taskId: 'task-1',
        turnId: 'turn-1',
        executionId: 'execution-1',
        environmentId,
        promptDisplayText: '测试',
        model: { modelId: 'model-1' }
      })
      await store.transitionExecution(
        { taskId: 'task-1', turnId: 'turn-1', executionId: 'execution-1' },
        'running',
        '2026-08-12T00:00:01.000Z'
      )
      if (state === 'waiting-permission') {
        await store.transitionExecution(
          { taskId: 'task-1', turnId: 'turn-1', executionId: 'execution-1' },
          'waiting-permission',
          '2026-08-12T00:00:02.000Z'
        )
      }

      const preview = await store.previewTaskDeletion('task-1')
      await expect(store.deleteTask('task-1', preview.token)).rejects.toMatchObject({
        code: 'invalid-state'
      })
      expect(store.getTaskDetail('task-1').state).toBe(state)
    }
  )

  it('默认 list 省略已归档 Task，get 仍能打开', async () => {
    const { store, project } = await createStore()
    await store.createTask({
      taskId: 'task-2',
      projectId: project.projectId,
      root: project.canonicalRoot,
      runtimeId: 'grok',
      session: {
        runtimeId: 'grok',
        runtimeSessionId: 'private-session-2',
        workspace: project.canonicalRoot
      },
      capabilitySnapshot: capabilitySnapshot()
    })

    const archived = await store.archiveTask('task-1')
    expect(archived.archivedAt).toEqual(expect.any(String))
    expect(store.getTaskDetail('task-1')).toMatchObject({
      taskId: 'task-1',
      archived: true,
      title: expect.any(String)
    })

    const page = await store.listTasks(project.projectId)
    expect(page.items.map((item) => item.taskId)).toEqual(['task-2'])
    expect(page.items.some((item) => item.taskId === 'task-1')).toBe(false)
  })

  it('归档后重启仍省略默认列表，get 仍能读到 archived', async () => {
    const { store, registry, project } = await createStore()
    await store.archiveTask('task-1')

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    expect((await restarted.listTasks(project.projectId)).items).toEqual([])
    expect(restarted.getTaskDetail('task-1').archived).toBe(true)
    expect(restarted.getTaskRecord('task-1').archivedAt).toEqual(expect.any(String))
  })

  it('给已有 Turn 覆盖绑定 validationIds，并经 listTurns 往返', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '跑测试',
      model: { modelId: 'model-1' }
    })

    const attached = await store.attachTurnValidationIds('task-1', 'turn-1', ['val-1', 'val-2'])
    expect(attached).toMatchObject({
      turnId: 'turn-1',
      taskId: 'task-1',
      validationIds: ['val-1', 'val-2']
    })
    expect(attached).not.toHaveProperty('schemaVersion')
    expect((await store.listTurns('task-1')).items[0]).toMatchObject({
      turnId: 'turn-1',
      validationIds: ['val-1', 'val-2']
    })

    const replaced = await store.attachTurnValidationIds('task-1', 'turn-1', ['val-9'])
    expect(replaced.validationIds).toEqual(['val-9'])
    expect((await store.listTurns('task-1')).items[0]?.validationIds).toEqual(['val-9'])

    const cleared = await store.attachTurnValidationIds('task-1', 'turn-1', [])
    expect(cleared.validationIds).toBeUndefined()
    expect((await store.listTurns('task-1')).items[0]?.validationIds).toBeUndefined()

    const turnPath = join(
      registry.getProjectDirectory(project.projectId),
      'tasks/task-1/turns/turn-1/turn.json'
    )
    const disk = JSON.parse(await readFile(turnPath, 'utf8')) as { schemaVersion: number }
    expect(disk.schemaVersion).toBe(2)
  })

  it('非法 validationId 或未知 Task/Turn 时拒绝写入', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '跑测试',
      model: { modelId: 'model-1' }
    })

    await expect(
      store.attachTurnValidationIds('missing-task', 'turn-1', ['val-1'])
    ).rejects.toMatchObject({
      code: 'history-not-found'
    })
    await expect(
      store.attachTurnValidationIds('task-1', 'missing-turn', ['val-1'])
    ).rejects.toMatchObject({
      code: 'history-not-found'
    })
    await expect(
      store.attachTurnValidationIds('task-1', 'turn-1', ['bad/id'])
    ).rejects.toMatchObject({
      code: 'invalid-state'
    })
    await expect(
      store.attachTurnValidationIds('task-1', 'turn-1', ['bad\\id'])
    ).rejects.toMatchObject({
      code: 'invalid-state'
    })
    await expect(
      store.attachTurnValidationIds('task-1', 'turn-1', ['bad\0id'])
    ).rejects.toMatchObject({
      code: 'invalid-state'
    })
    await expect(store.attachTurnValidationIds('task-1', 'turn-1', [''])).rejects.toMatchObject({
      code: 'invalid-state'
    })
    await expect(
      store.attachTurnValidationIds('task-1', 'turn-1', ['val-1', 'val-1'])
    ).rejects.toMatchObject({ code: 'invalid-state' })
    await expect(store.attachTurnValidationIds('task-1', 'a/b', ['val-1'])).rejects.toMatchObject({
      code: 'invalid-state'
    })
    expect((await store.listTurns('task-1')).items[0]?.validationIds).toBeUndefined()
  })

  it('给已有 Turn 覆盖绑定 artifactIds，并经 listTurns 往返', async () => {
    const { store } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '写文档',
      model: { modelId: 'model-1' }
    })

    const attached = await store.attachTurnArtifactIds('task-1', 'turn-1', ['art-1', 'art-2'])
    expect(attached).toMatchObject({
      turnId: 'turn-1',
      artifactIds: ['art-1', 'art-2']
    })
    expect((await store.listTurns('task-1')).items[0]?.artifactIds).toEqual(['art-1', 'art-2'])

    const cleared = await store.attachTurnArtifactIds('task-1', 'turn-1', [])
    expect(cleared.artifactIds).toBeUndefined()
    await expect(store.attachTurnArtifactIds('task-1', 'turn-1', ['bad/id'])).rejects.toMatchObject(
      { code: 'invalid-state' }
    )
  })

  it('读盘仍接受历史里未校验的 validationIds 字符串数组，不把旧 Turn 标坏', async () => {
    const { store, registry, project } = await createStore()
    await store.createTurn({
      taskId: 'task-1',
      turnId: 'turn-1',
      promptDisplayText: '跑测试',
      model: { modelId: 'model-1' }
    })
    const turnPath = join(
      registry.getProjectDirectory(project.projectId),
      'tasks/task-1/turns/turn-1/turn.json'
    )
    const turn = JSON.parse(await readFile(turnPath, 'utf8')) as Record<string, unknown>
    turn.validationIds = ['legacy-id', 12, '']
    await writeFile(turnPath, JSON.stringify(turn))

    const restarted = new TaskStore({ projectRegistry: registry })
    await restarted.initialize()
    expect((await restarted.listTurns('task-1')).items[0]).toMatchObject({
      turnId: 'turn-1',
      validationIds: ['legacy-id', 12, '']
    })
  })
})

/** 构造无 sleep 的并发门禁，精确控制历史写入与删除提交时序。 */
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

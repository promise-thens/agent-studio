import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeCapabilitySnapshot } from '../../shared/agent'
import { AGENT_CAPABILITY_IDS } from '../../shared/agent'
import type { PermissionAuditRecord } from '../../shared/task-history'
import { TaskStore } from '../agent/task-store'
import { ProjectRegistry } from '../project/project-registry'
import { AtomicJsonWriter } from '../storage/atomic-json-file'
import { MAX_PERMISSION_AUDIT_FILE_BYTES, PermissionAuditStore } from './permission-audit-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('PermissionAuditStore', () => {
  it('新 Store 实例可在重启后读取已落盘的权限审计', async () => {
    const fixture = await createFixture()
    await fixture.store.append(createRecord(1))

    // 同时重建 ProjectRegistry 与 Store，避免把进程内缓存误当成重启恢复证据。
    const restartedRegistry = new ProjectRegistry({ userDataPath: fixture.userDataPath })
    await restartedRegistry.initialize()
    const restartedStore = new PermissionAuditStore({
      projectRegistry: restartedRegistry,
      getTaskIdentity: createTaskIdentity
    })

    await expect(restartedStore.list('task-1')).resolves.toMatchObject({
      items: [{ auditId: 'audit-1', reason: 'user-allowed' }]
    })
  })

  it('原子保存、分页读取并在超过 500 条时淘汰最旧记录', async () => {
    const fixture = await createFixture()
    await fs.writeFile(
      join(fixture.taskDirectory, 'permission-audits.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: 'task-1',
        projectId: 'project-1',
        records: Array.from({ length: 500 }, (_, index) => createRecord(index))
      })}\n`
    )
    for (let index = 500; index < 505; index += 1) await fixture.store.append(createRecord(index))

    const first = await fixture.store.list('task-1', undefined, 100)
    expect(first.items).toHaveLength(100)
    expect(first.items[0].auditId).toBe('audit-504')
    expect(first.nextCursor).toBe('audit-405')
    const persisted = JSON.parse(
      await fs.readFile(join(fixture.taskDirectory, 'permission-audits.json'), 'utf8')
    ) as { records: PermissionAuditRecord[] }
    expect(persisted.records).toHaveLength(500)
    expect(persisted.records[0].auditId).toBe('audit-5')
  })

  it('追加导致文件超过 2 MiB 时淘汰最旧记录并保持文件不超限', async () => {
    const fixture = await createFixture()
    const { seedRecords, overflowRecord } = createNearCapacityRecords()
    const path = join(fixture.taskDirectory, 'permission-audits.json')

    // 先落盘一个接近上限但仍合法的文件，再由 Store 追加一条触发容量淘汰。
    await fs.writeFile(path, `${JSON.stringify(createAuditFile(seedRecords))}\n`)
    expect(serializedAuditFileBytes(seedRecords)).toBeGreaterThan(
      MAX_PERMISSION_AUDIT_FILE_BYTES - 32 * 1024
    )

    await fixture.store.append(overflowRecord)

    const raw = await fs.readFile(path, 'utf8')
    const persisted = JSON.parse(raw) as { records: PermissionAuditRecord[] }
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(MAX_PERMISSION_AUDIT_FILE_BYTES)
    expect(persisted.records.some((record) => record.auditId === seedRecords[0]?.auditId)).toBe(
      false
    )
    expect(persisted.records.at(-1)?.auditId).toBe(overflowRecord.auditId)
  })

  it('逐记录隔离损坏项，未知新 schema 保留原文件且不覆盖', async () => {
    const fixture = await createFixture()
    await fixture.store.append(createRecord(1))
    const path = join(fixture.taskDirectory, 'permission-audits.json')
    const validFile = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      path,
      `${JSON.stringify({ ...validFile, records: [createRecord(1), { bad: true }] })}\n`
    )

    await expect(fixture.store.list('task-1')).resolves.toMatchObject({
      items: [{ auditId: 'audit-1' }]
    })
    const quarantineFiles = await fs.readdir(
      join(fixture.userDataPath, 'history', 'v1', 'quarantine')
    )
    expect(quarantineFiles.some((name) => name.includes('permission-record'))).toBe(true)

    await fs.writeFile(path, `${JSON.stringify({ ...validFile, schemaVersion: 2 })}\n`)
    const before = await fs.readFile(path, 'utf8')
    await expect(fixture.store.append(createRecord(2))).rejects.toMatchObject({
      code: 'history-version-unsupported'
    })
    expect(await fs.readFile(path, 'utf8')).toBe(before)
  })

  it('拒绝超长、Secret 原文形状和跨 Project 身份', async () => {
    const fixture = await createFixture()
    await expect(
      fixture.store.append({ ...createRecord(1), detail: 'x'.repeat(4 * 1024 + 1) })
    ).rejects.toThrow()
    await expect(
      fixture.store.append({ ...createRecord(1), projectId: 'project-other' })
    ).rejects.toMatchObject({ code: 'history-corrupt' })
    expect(JSON.stringify(await fixture.store.list('task-1'))).not.toContain('rawInput')
    expect(JSON.stringify(await fixture.store.list('task-1'))).not.toContain('apiKey')
  })

  it('保留受限 App 服务身份，并拒绝与 initiator 冲突的身份字段', async () => {
    const fixture = await createFixture()
    const appRecord: PermissionAuditRecord = {
      ...createRecord(1),
      initiator: 'app',
      runtimeId: undefined,
      appService: 'git'
    }
    await fixture.store.append(appRecord)
    await expect(fixture.store.list('task-1')).resolves.toMatchObject({
      items: [{ initiator: 'app', appService: 'git' }]
    })
    await expect(
      fixture.store.append({ ...appRecord, auditId: 'audit-invalid', runtimeId: 'grok' })
    ).rejects.toThrow()
  })

  it('同 Task 的 list 等待正在进行的 append，读取不到原子替换前的旧页', async () => {
    const writeGate = deferred<void>()
    let blockWrite = false
    const writer = new AtomicJsonWriter({
      fileSystem: {
        rename: async (source, target) => {
          if (blockWrite && target.endsWith('permission-audits.json')) await writeGate.promise
          await fs.rename(source, target)
        }
      }
    })
    const fixture = await createFixture(writer)
    await fixture.store.append(createRecord(1))
    blockWrite = true
    const appending = fixture.store.append(createRecord(2))
    await Promise.resolve()
    const listing = fixture.store.list('task-1')
    let listSettled = false
    void listing.finally(() => {
      listSettled = true
    })
    await Promise.resolve()
    expect(listSettled).toBe(false)

    writeGate.resolve()
    await appending
    await expect(listing).resolves.toMatchObject({
      items: [{ auditId: 'audit-2' }, { auditId: 'audit-1' }]
    })
  })

  it('写入前按审计文件正增长调用全局容量门禁，拒绝时不改写原文件', async () => {
    const ensureHistoryCapacity = vi.fn(async (taskId: string, additionalBytes: number) => {
      void taskId
      void additionalBytes
    })
    const fixture = await createFixture(undefined, true, ensureHistoryCapacity)
    await fixture.store.append(createRecord(1))
    expect(ensureHistoryCapacity).toHaveBeenCalledWith('task-1', expect.any(Number))
    expect(ensureHistoryCapacity.mock.calls[0]?.[1]).toBeGreaterThan(0)

    const path = join(fixture.taskDirectory, 'permission-audits.json')
    const before = await fs.readFile(path, 'utf8')
    ensureHistoryCapacity.mockRejectedValueOnce(new Error('历史容量已满。'))
    await expect(fixture.store.append(createRecord(2))).rejects.toThrow('历史容量已满。')
    expect(await fs.readFile(path, 'utf8')).toBe(before)
  })

  it('审计追加在写入完成前持有 Task 历史 mutation lease，并在失败时释放', async () => {
    const release = vi.fn()
    const beginTaskHistoryMutation = vi.fn(() => ({ release }))
    const ensureHistoryCapacity = vi.fn(async () => undefined)
    const fixture = await createFixture(
      undefined,
      true,
      ensureHistoryCapacity,
      beginTaskHistoryMutation
    )

    await fixture.store.append(createRecord(1))
    expect(beginTaskHistoryMutation).toHaveBeenCalledWith('task-1')
    expect(release).toHaveBeenCalledOnce()

    release.mockClear()
    ensureHistoryCapacity.mockRejectedValueOnce(new Error('容量拒绝。'))
    await expect(fixture.store.append(createRecord(2))).rejects.toThrow('容量拒绝。')
    expect(release).toHaveBeenCalledOnce()
  })

  it('审计 list 修复损坏记录时持有 Task 历史 mutation lease', async () => {
    const release = vi.fn()
    const beginTaskHistoryMutation = vi.fn(() => ({ release }))
    const fixture = await createFixture(undefined, true, undefined, beginTaskHistoryMutation)
    await fixture.store.append(createRecord(1))
    beginTaskHistoryMutation.mockClear()
    release.mockClear()

    const path = join(fixture.taskDirectory, 'permission-audits.json')
    const validFile = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>
    await fs.writeFile(
      path,
      `${JSON.stringify({ ...validFile, records: [createRecord(1), { bad: true }] })}\n`
    )

    await expect(fixture.store.list('task-1')).resolves.toMatchObject({
      items: [{ auditId: 'audit-1' }]
    })
    expect(beginTaskHistoryMutation).toHaveBeenCalledOnce()
    expect(beginTaskHistoryMutation).toHaveBeenCalledWith('task-1')
    expect(release).toHaveBeenCalledOnce()
  })

  it('TaskStore 物理删除 Task 时自然带走同目录的权限审计文件', async () => {
    const fixture = await createFixture(undefined, false)
    const taskStore = new TaskStore({
      projectRegistry: fixture.registry,
      createId: sequenceId('delete-token'),
      now: () => '2026-08-12T00:00:00.000Z'
    })
    await taskStore.initialize()
    await taskStore.createTask({
      taskId: 'task-1',
      projectId: fixture.project.projectId,
      root: fixture.project.canonicalRoot!,
      runtimeId: 'grok',
      session: {
        runtimeId: 'grok',
        runtimeSessionId: 'private-session',
        workspace: fixture.project.canonicalRoot!
      },
      capabilitySnapshot: createCapabilitySnapshot()
    })
    await fixture.store.append(createRecord(1))

    const auditPath = join(fixture.taskDirectory, 'permission-audits.json')
    await expect(fs.readFile(auditPath, 'utf8')).resolves.toContain('audit-1')

    const preview = await taskStore.previewTaskDeletion('task-1')
    await taskStore.deleteTask('task-1', preview.token)

    await expect(fs.readFile(auditPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('在途审计 mutation 会阻止 Task 删除准备，释放后才能删除', async () => {
    const fixture = await createFixture(undefined, false)
    const taskStore = new TaskStore({
      projectRegistry: fixture.registry,
      createId: sequenceId('delete-token'),
      now: () => '2026-08-12T00:00:00.000Z'
    })
    await taskStore.initialize()
    await taskStore.createTask({
      taskId: 'task-1',
      projectId: fixture.project.projectId,
      root: fixture.project.canonicalRoot!,
      runtimeId: 'grok',
      session: {
        runtimeId: 'grok',
        runtimeSessionId: 'private-session',
        workspace: fixture.project.canonicalRoot!
      },
      capabilitySnapshot: createCapabilitySnapshot()
    })
    const auditStore = new PermissionAuditStore({
      projectRegistry: fixture.registry,
      getTaskIdentity: createTaskIdentity,
      ensureHistoryCapacity: (taskId, bytes) =>
        taskStore.ensureAdditionalHistoryCapacity(taskId, bytes),
      beginTaskHistoryMutation: (taskId) => taskStore.beginTaskHistoryMutation(taskId)
    })
    const preview = await taskStore.previewTaskDeletion('task-1')
    const writeStarted = deferred<void>()
    const releaseWrite = deferred<void>()
    const writer = (auditStore as unknown as { writer: AtomicJsonWriter }).writer
    const originalWrite = writer.write.bind(writer)
    writer.write = async (path, value) => {
      if (path.endsWith('permission-audits.json')) {
        writeStarted.resolve()
        await releaseWrite.promise
      }
      return originalWrite(path, value)
    }

    const appending = auditStore.append(createRecord(1))
    await writeStarted.promise
    expect(() => taskStore.prepareTaskDeletion('task-1', preview.token)).toThrow(
      'Task 历史正在删除'
    )

    releaseWrite.resolve()
    await appending
    const preparation = taskStore.prepareTaskDeletion('task-1', preview.token)
    await preparation.commit()
    expect(() => taskStore.getTaskDetail('task-1')).toThrow('未找到指定 Task 历史')
  })
})

async function createFixture(
  writer?: AtomicJsonWriter,
  createTaskDirectory = true,
  ensureHistoryCapacity?: (taskId: string, additionalBytes: number) => Promise<void>,
  beginTaskHistoryMutation?: (taskId: string) => { release(): void }
): Promise<{
  store: PermissionAuditStore
  registry: ProjectRegistry
  project: Awaited<ReturnType<ProjectRegistry['register']>>
  userDataPath: string
  taskDirectory: string
}> {
  const userDataPath = await fs.mkdtemp(join(tmpdir(), 'permission-audit-'))
  temporaryDirectories.push(userDataPath)
  const projectRoot = join(userDataPath, 'project')
  await fs.mkdir(projectRoot)
  const registry = new ProjectRegistry({
    userDataPath,
    createId: () => 'project-1',
    now: () => '2026-08-12T00:00:00.000Z'
  })
  await registry.initialize()
  const project = await registry.register(projectRoot)
  const taskDirectory = join(registry.getProjectDirectory('project-1'), 'tasks', 'task-1')
  if (createTaskDirectory) await fs.mkdir(taskDirectory, { recursive: true })
  return {
    store: new PermissionAuditStore({
      projectRegistry: registry,
      getTaskIdentity: createTaskIdentity,
      ...(ensureHistoryCapacity ? { ensureHistoryCapacity } : {}),
      ...(beginTaskHistoryMutation ? { beginTaskHistoryMutation } : {}),
      ...(writer ? { writer } : {}),
      createId: sequenceId('quarantine')
    }),
    registry,
    project,
    userDataPath,
    taskDirectory
  }
}

function createTaskIdentity(taskId: string): { taskId: string; projectId: string } {
  return { taskId, projectId: 'project-1' }
}

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void
  })
  return { promise, resolve }
}

function createRecord(index: number): PermissionAuditRecord {
  return {
    auditId: `audit-${index}`,
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    environmentId: 'local:environment-1',
    initiator: 'runtime',
    runtimeId: 'grok',
    operationType: 'write-file',
    risk: 'L1',
    targetSummaries: ['src/index.ts'],
    title: '修改文件',
    impact: '会写入 Project 文件。',
    reason: 'user-allowed',
    scope: 'once',
    createdAt: new Date(index * 1_000).toISOString()
  }
}

/** 构造每条小于 16 KiB 的大记录，用来稳定触发单文件 2 MiB 边界。 */
function createLargeRecord(index: number): PermissionAuditRecord {
  const padding = 'x'.repeat(3_400)
  return {
    ...createRecord(index),
    targetSummaries: [`target-${index}-${padding}`],
    title: `title-${index}-${padding}`,
    impact: `impact-${index}-${padding}`,
    detail: `detail-${index}-${padding}`
  }
}

function createNearCapacityRecords(): {
  seedRecords: PermissionAuditRecord[]
  overflowRecord: PermissionAuditRecord
} {
  const seedRecords: PermissionAuditRecord[] = []
  for (let index = 0; index < 500; index += 1) {
    const record = createLargeRecord(index)
    if (serializedAuditFileBytes([...seedRecords, record]) > MAX_PERMISSION_AUDIT_FILE_BYTES) {
      return { seedRecords, overflowRecord: record }
    }
    seedRecords.push(record)
  }
  throw new Error('测试记录未能触发 2 MiB 容量上限。')
}

function createAuditFile(records: PermissionAuditRecord[]): {
  schemaVersion: 1
  taskId: string
  projectId: string
  records: PermissionAuditRecord[]
} {
  return { schemaVersion: 1, taskId: 'task-1', projectId: 'project-1', records }
}

function serializedAuditFileBytes(records: PermissionAuditRecord[]): number {
  return Buffer.byteLength(JSON.stringify(createAuditFile(records)), 'utf8')
}

/** TaskStore 只会取恢复与加载能力，但测试仍提供完整且中性的能力快照。 */
function createCapabilitySnapshot(): AgentRuntimeCapabilitySnapshot {
  return {
    runtimeId: 'grok',
    observedAt: '2026-08-12T00:00:00.000Z',
    capabilities: Object.fromEntries(
      AGENT_CAPABILITY_IDS.map((capabilityId) => [
        capabilityId,
        {
          capabilityId,
          support: 'unknown',
          verification: 'unverified',
          source: 'fallback'
        }
      ])
    ) as AgentRuntimeCapabilitySnapshot['capabilities']
  }
}

function sequenceId(prefix: string): () => string {
  let index = 0
  return () => `${prefix}-${++index}`
}

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { PermissionAuditPage, PermissionAuditRecord } from '../../shared/task-history'
import type { ProjectRegistry } from '../project/project-registry'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const AUDIT_SCHEMA_VERSION = 1
export const MAX_PERMISSION_AUDITS_PER_TASK = 500
export const MAX_PERMISSION_AUDIT_FIELD_BYTES = 4 * 1024
export const MAX_PERMISSION_AUDIT_RECORD_BYTES = 16 * 1024
export const MAX_PERMISSION_AUDIT_FILE_BYTES = 2 * 1024 * 1024
const MAX_AUDIT_READ_BYTES = MAX_PERMISSION_AUDIT_FILE_BYTES * 2

interface PermissionAuditFileV1 {
  schemaVersion: typeof AUDIT_SCHEMA_VERSION
  taskId: string
  projectId: string
  records: PermissionAuditRecord[]
}

export interface PermissionAuditTaskIdentity {
  taskId: string
  projectId: string
}

export type PermissionAuditStoreErrorCode =
  | 'history-not-found'
  | 'history-corrupt'
  | 'history-version-unsupported'
  | 'history-capacity-exceeded'

export class PermissionAuditStoreError extends Error {
  constructor(
    readonly code: PermissionAuditStoreErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'PermissionAuditStoreError'
  }
}

export interface PermissionAuditStoreOptions {
  projectRegistry: ProjectRegistry
  getTaskIdentity: (taskId: string) => PermissionAuditTaskIdentity
  /** 写入前由 TaskStore 按文件正增长执行全局 256 MiB 容量准入。 */
  ensureHistoryCapacity?: (taskId: string, additionalBytes: number) => Promise<void>
  /** 与 TaskStore 删除 reservation 串联，避免审计写在目录 rename 后重建幽灵目录。 */
  beginTaskHistoryMutation?: (taskId: string) => { release(): void }
  writer?: AtomicJsonWriter
  createId?: () => string
  now?: () => number
}

/**
 * 在既有 Task 历史目录内保存独立权限审计。
 * 单文件原子替换且按 Task 串行读改写，Task/Project 两阶段删除会自然带走审计文件。
 */
export class PermissionAuditStore {
  private readonly registry: ProjectRegistry
  private readonly getTaskIdentity: PermissionAuditStoreOptions['getTaskIdentity']
  private readonly ensureHistoryCapacity?: PermissionAuditStoreOptions['ensureHistoryCapacity']
  private readonly beginTaskHistoryMutation?: PermissionAuditStoreOptions['beginTaskHistoryMutation']
  private readonly writer: AtomicJsonWriter
  private readonly createId: () => string
  private readonly now: () => number
  private readonly taskQueues = new Map<string, Promise<void>>()

  constructor(options: PermissionAuditStoreOptions) {
    this.registry = options.projectRegistry
    this.getTaskIdentity = options.getTaskIdentity
    this.ensureHistoryCapacity = options.ensureHistoryCapacity
    this.beginTaskHistoryMutation = options.beginTaskHistoryMutation
    this.writer = options.writer ?? new AtomicJsonWriter()
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /** 写入前逐字段校验；超过条数或文件上限时只淘汰最旧记录。 */
  async append(record: PermissionAuditRecord): Promise<void> {
    validateAuditRecord(record)
    await this.enqueueTask(record.taskId, async () => {
      const mutationLease = this.beginTaskHistoryMutation?.(record.taskId)
      try {
        const identity = this.getTaskIdentity(record.taskId)
        if (identity.projectId !== record.projectId) {
          throw new PermissionAuditStoreError('history-corrupt', '权限审计身份不匹配。')
        }
        const current = await this.readFile(identity, true)
        const path = this.auditPath(identity)
        const currentBytes = await fileSize(path)
        const records = [...current.records, structuredClone(record)].slice(
          -MAX_PERMISSION_AUDITS_PER_TASK
        )
        while (
          records.length &&
          serializedFileBytes(identity, records) > MAX_PERMISSION_AUDIT_FILE_BYTES
        ) {
          records.shift()
        }
        if (!records.some((item) => item.auditId === record.auditId)) {
          throw new PermissionAuditStoreError(
            'history-capacity-exceeded',
            '权限审计记录超过容量上限。'
          )
        }
        const nextBytes = serializedFileBytes(identity, records)
        await this.ensureHistoryCapacity?.(record.taskId, Math.max(0, nextBytes - currentBytes))
        await this.writer.write(path, createAuditFile(identity, records))
      } finally {
        mutationLease?.release()
      }
    })
  }

  /** 按最新优先分页；cursor 只接受上一页最后一条 auditId。 */
  async list(taskId: string, cursor?: string, limit = 50): Promise<PermissionAuditPage> {
    return this.enqueueTask(taskId, async () => {
      // list 可能隔离损坏记录并重写审计文件，因此必须与 Task 删除、容量淘汰共用 mutation lease。
      const mutationLease = this.beginTaskHistoryMutation?.(taskId)
      try {
        // 读取与同 Task 的原子替换、损坏隔离共用队列，避免分页撞上读改写中间态。
        const identity = this.getTaskIdentity(taskId)
        const file = await this.readFile(identity, true)
        const acceptedLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 50
        const records = [...file.records].reverse()
        const start = cursor
          ? Math.max(0, records.findIndex((record) => record.auditId === cursor) + 1)
          : 0
        const page = records.slice(start, start + acceptedLimit)
        return {
          items: page.map((record) => structuredClone(record)),
          ...(start + page.length < records.length ? { nextCursor: page.at(-1)?.auditId } : {})
        }
      } finally {
        mutationLease?.release()
      }
    })
  }

  private async readFile(
    identity: PermissionAuditTaskIdentity,
    missingAsEmpty: boolean
  ): Promise<PermissionAuditFileV1> {
    const path = this.auditPath(identity)
    let value: unknown
    try {
      value = await this.writer.read(path, MAX_AUDIT_READ_BYTES)
    } catch (error) {
      if (isFileNotFound(error) && missingAsEmpty) return createAuditFile(identity, [])
      if (isFileNotFound(error)) {
        throw new PermissionAuditStoreError('history-not-found', '未找到权限审计历史。')
      }
      await this.quarantine(path, 'invalid-json')
      throw new PermissionAuditStoreError('history-corrupt', '权限审计历史损坏。')
    }

    const parsed = parseAuditFile(value, identity)
    if (parsed.kind === 'unsupported') {
      throw new PermissionAuditStoreError(
        'history-version-unsupported',
        '权限审计版本高于当前客户端。'
      )
    }
    if (parsed.kind === 'corrupt') {
      await this.quarantine(path, 'invalid-fields')
      throw new PermissionAuditStoreError('history-corrupt', '权限审计历史损坏。')
    }
    if (parsed.invalidIndexes.length) {
      await this.writeRecordQuarantine(identity, parsed.invalidIndexes)
      await this.writer.write(path, createAuditFile(identity, parsed.record.records))
    }
    return parsed.record
  }

  private auditPath(identity: PermissionAuditTaskIdentity): string {
    return join(
      this.registry.getProjectDirectory(identity.projectId),
      'tasks',
      identity.taskId,
      'permission-audits.json'
    )
  }

  /** 隔离只保存受控原因；损坏原文件仍留在权限受限的本地历史区。 */
  private async quarantine(
    source: string,
    reason: 'invalid-json' | 'invalid-fields'
  ): Promise<void> {
    const quarantineRoot = join(this.registry.historyRoot, 'quarantine')
    await this.writer.ensureDirectory(quarantineRoot)
    const target = join(quarantineRoot, `${this.now()}-permission-audits-${this.createId()}`)
    try {
      await this.writer.renameDurably(source, target)
      await this.writer.write(`${target}.reason.json`, { reason })
    } catch (error) {
      if (!isFileNotFound(error)) throw error
    }
  }

  private async writeRecordQuarantine(
    identity: PermissionAuditTaskIdentity,
    invalidIndexes: number[]
  ): Promise<void> {
    const quarantineRoot = join(this.registry.historyRoot, 'quarantine')
    await this.writer.ensureDirectory(quarantineRoot)
    await this.writer.write(
      join(quarantineRoot, `${this.now()}-permission-record-${this.createId()}.reason.json`),
      {
        reason: 'invalid-fields',
        taskId: identity.taskId,
        recordIndexes: invalidIndexes.slice(0, MAX_PERMISSION_AUDITS_PER_TASK)
      }
    )
  }

  private async enqueueTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve()
    let result: T
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        result = await operation()
      })
    this.taskQueues.set(taskId, current)
    try {
      await current
      return result!
    } finally {
      if (this.taskQueues.get(taskId) === current) this.taskQueues.delete(taskId)
    }
  }
}

function createAuditFile(
  identity: PermissionAuditTaskIdentity,
  records: PermissionAuditRecord[]
): PermissionAuditFileV1 {
  return {
    schemaVersion: AUDIT_SCHEMA_VERSION,
    taskId: identity.taskId,
    projectId: identity.projectId,
    records
  }
}

function parseAuditFile(
  value: unknown,
  identity: PermissionAuditTaskIdentity
):
  | { kind: 'valid'; record: PermissionAuditFileV1; invalidIndexes: number[] }
  | { kind: 'unsupported' }
  | { kind: 'corrupt' } {
  if (!isRecord(value) || !Number.isSafeInteger(value.schemaVersion)) return { kind: 'corrupt' }
  if (Number(value.schemaVersion) > AUDIT_SCHEMA_VERSION) return { kind: 'unsupported' }
  if (
    value.schemaVersion !== AUDIT_SCHEMA_VERSION ||
    value.taskId !== identity.taskId ||
    value.projectId !== identity.projectId ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_PERMISSION_AUDITS_PER_TASK
  ) {
    return { kind: 'corrupt' }
  }
  const records: PermissionAuditRecord[] = []
  const invalidIndexes: number[] = []
  value.records.forEach((record, index) => {
    try {
      validateAuditRecord(record)
      records.push(record as PermissionAuditRecord)
    } catch {
      invalidIndexes.push(index)
    }
  })
  return {
    kind: 'valid',
    record: createAuditFile(identity, records),
    invalidIndexes
  }
}

function validateAuditRecord(value: unknown): asserts value is PermissionAuditRecord {
  if (!isRecord(value)) throw new Error('invalid-record')
  const allowedFields = new Set([
    'auditId',
    'taskId',
    'turnId',
    'projectId',
    'environmentId',
    'initiator',
    'runtimeId',
    'appService',
    'operationType',
    'risk',
    'targetSummaries',
    'title',
    'impact',
    'reason',
    'scope',
    'detail',
    'createdAt',
    'truncated'
  ])
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new Error('unexpected-field')
  }
  const requiredTextFields = [
    'auditId',
    'taskId',
    'turnId',
    'projectId',
    'environmentId',
    'title',
    'impact',
    'createdAt'
  ] as const
  for (const field of requiredTextFields) validateAuditText(value[field])
  if (!['runtime', 'app'].includes(String(value.initiator))) throw new Error('invalid-initiator')
  if (value.runtimeId != null && !['grok', 'codex'].includes(String(value.runtimeId))) {
    throw new Error('invalid-runtime')
  }
  if (
    value.appService != null &&
    !['command-runner', 'git', 'worktree', 'other'].includes(String(value.appService))
  ) {
    throw new Error('invalid-app-service')
  }
  if (
    (value.initiator === 'runtime' && value.appService != null) ||
    (value.initiator === 'app' && value.runtimeId != null)
  ) {
    throw new Error('invalid-initiator-detail')
  }
  if (
    ![
      'read-project',
      'write-file',
      'execute-command',
      'delete-path',
      'git-read',
      'git-mutate',
      'worktree-create',
      'worktree-remove',
      'network-egress',
      'browser',
      'screen',
      'clipboard',
      'unknown'
    ].includes(String(value.operationType)) ||
    !['L0', 'L1', 'L2', 'L3'].includes(String(value.risk)) ||
    ![
      'auto-allowed',
      'grant-reused',
      'user-allowed',
      'user-denied',
      'cancelled',
      'expired',
      'invalid-target',
      'unsupported',
      'internal-error',
      'takeover-toggled'
    ].includes(String(value.reason))
  ) {
    throw new Error('invalid-enum')
  }
  if (value.scope != null && !['once', 'task'].includes(String(value.scope))) {
    throw new Error('invalid-scope')
  }
  if (!Array.isArray(value.targetSummaries) || value.targetSummaries.length > 32) {
    throw new Error('invalid-targets')
  }
  value.targetSummaries.forEach(validateAuditText)
  if (value.detail != null) validateAuditText(value.detail)
  if (!Number.isFinite(Date.parse(String(value.createdAt)))) throw new Error('invalid-time')
  if (value.truncated != null && value.truncated !== true) throw new Error('invalid-truncated')
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PERMISSION_AUDIT_RECORD_BYTES) {
    throw new Error('record-too-large')
  }
}

function validateAuditText(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PERMISSION_AUDIT_FIELD_BYTES
  ) {
    throw new Error('invalid-text')
  }
}

function serializedFileBytes(
  identity: PermissionAuditTaskIdentity,
  records: PermissionAuditRecord[]
): number {
  return Buffer.byteLength(`${JSON.stringify(createAuditFile(identity, records))}\n`, 'utf8')
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size
  } catch (error) {
    if (isFileNotFound(error)) return 0
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import type { ProjectSummary } from '../../shared/task-history'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const PROJECT_SCHEMA_VERSION = 1
const MAX_PROJECTS = 100
const MAX_PROJECT_FILE_BYTES = 128 * 1024
const MAX_IDENTIFIER_BYTES = 4 * 1024
const MAX_PROJECT_PATH_BYTES = 16 * 1024

interface ProjectRecordV1 {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  projectId: string
  canonicalRoot: string
  displayName: string
  status: 'active' | 'removed'
  registeredAt: string
  lastOpenedAt: string
  removedAt?: string
  revision: number
}

export type ProjectRegistryErrorCode =
  | 'project-not-found'
  | 'project-unavailable'
  | 'history-corrupt'
  | 'history-version-unsupported'
  | 'history-capacity-exceeded'
  | 'invalid-input'

export class ProjectRegistryError extends Error {
  constructor(
    readonly code: ProjectRegistryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ProjectRegistryError'
  }
}

export interface ProjectRegistryOptions {
  userDataPath: string
  writer?: AtomicJsonWriter
  createId?: () => string
  now?: () => string
}

/** 主进程持有 canonical Project 身份，Renderer 只能提交不可预测的 projectId。 */
export class ProjectRegistry {
  readonly historyRoot: string
  readonly projectsRoot: string

  private readonly writer: AtomicJsonWriter
  private readonly createId: () => string
  private readonly now: () => string
  private readonly records = new Map<string, ProjectRecordV1>()
  private readonly unsupportedRecords = new Map<string, ProjectSummary>()

  constructor(options: ProjectRegistryOptions) {
    this.historyRoot = join(options.userDataPath, 'history', 'v1')
    this.projectsRoot = join(this.historyRoot, 'projects')
    this.writer = options.writer ?? new AtomicJsonWriter()
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async initialize(): Promise<void> {
    await this.writer.ensureDirectory(this.projectsRoot)
    const entries = await fs.readdir(this.projectsRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!isValidIdentifier(entry.name)) {
        await this.quarantine(join(this.projectsRoot, entry.name), 'project', 'identity-mismatch')
        continue
      }
      const recordPath = this.getRecordPath(entry.name)
      try {
        const parsed = parseProjectRecord(
          await this.writer.read(recordPath, MAX_PROJECT_FILE_BYTES)
        )
        if (parsed.kind === 'valid' && parsed.record.projectId === entry.name) {
          this.records.set(parsed.record.projectId, parsed.record)
        } else if (parsed.kind === 'unsupported') {
          const summary = toUnsupportedSummary(entry.name, parsed.value)
          if (summary) this.unsupportedRecords.set(entry.name, summary)
        } else {
          await this.quarantine(this.getProjectDirectory(entry.name), 'project', 'invalid-fields')
        }
      } catch {
        await this.quarantine(this.getProjectDirectory(entry.name), 'project', 'invalid-json')
      }
    }
  }

  async register(path: string): Promise<ProjectSummary> {
    const canonicalRoot = await resolveCanonicalDirectory(path)
    const existing = [...this.records.values()].find((record) =>
      compareCanonicalPath(record.canonicalRoot, canonicalRoot)
    )
    const unsupported = [...this.unsupportedRecords.values()].find(
      (record) => record.canonicalRoot && compareCanonicalPath(record.canonicalRoot, canonicalRoot)
    )
    if (unsupported) {
      throw new ProjectRegistryError(
        'history-version-unsupported',
        '该目录存在由更新版本创建的 Project 记录，当前版本不会覆盖它。'
      )
    }
    const observedAt = this.now()

    if (existing) {
      const next: ProjectRecordV1 = {
        ...existing,
        status: 'active',
        lastOpenedAt: observedAt,
        revision: existing.revision + 1
      }
      delete next.removedAt
      await this.save(next)
      return this.toSummary(next)
    }

    if (this.records.size + this.unsupportedRecords.size >= MAX_PROJECTS) {
      throw new ProjectRegistryError('history-capacity-exceeded', 'Project 数量已达到 100 个上限。')
    }

    const projectId = validateIdentifier(this.createId())
    const record: ProjectRecordV1 = {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      canonicalRoot,
      displayName: basename(canonicalRoot) || canonicalRoot,
      status: 'active',
      registeredAt: observedAt,
      lastOpenedAt: observedAt,
      revision: 1
    }
    await this.save(record)
    return this.toSummary(record)
  }

  async list(): Promise<ProjectSummary[]> {
    const summaries = await Promise.all(
      [...this.records.values()].map((record) => this.toSummary(record))
    )
    return [...summaries, ...this.unsupportedRecords.values()].sort((left, right) =>
      right.lastOpenedAt.localeCompare(left.lastOpenedAt)
    )
  }

  /**
   * 用 Runtime 当前 workspace 反查仍有效的 Project ID。
   * 路径不能当 ID 用；切换模型重连必须拿真正的 projectId。
   */
  findActiveProjectIdByRoot(workspace: string): string | null {
    if (!isValidCanonicalRoot(workspace)) return null
    for (const record of this.records.values()) {
      if (record.status !== 'active') continue
      if (compareCanonicalPath(record.canonicalRoot, workspace)) return record.projectId
    }
    return null
  }

  getRecord(projectId: string): ProjectRecordV1 {
    validateIdentifier(projectId)
    if (this.unsupportedRecords.has(projectId)) {
      throw new ProjectRegistryError(
        'history-version-unsupported',
        '该 Project 记录版本高于当前客户端。'
      )
    }
    const record = this.records.get(projectId)
    if (!record) throw new ProjectRegistryError('project-not-found', '未找到指定 Project。')
    return { ...record }
  }

  async getSummary(projectId: string): Promise<ProjectSummary> {
    return this.toSummary(this.getRecord(projectId))
  }

  async resolveAvailableRoot(projectId: string): Promise<string> {
    const record = this.getRecord(projectId)
    try {
      const currentRoot = await resolveCanonicalDirectory(record.canonicalRoot)
      if (!compareCanonicalPath(currentRoot, record.canonicalRoot)) throw new Error('root drifted')
      return currentRoot
    } catch {
      throw new ProjectRegistryError('project-unavailable', 'Project 目录当前不可用。')
    }
  }

  async remove(projectId: string): Promise<void> {
    const current = this.getRecord(projectId)
    if (current.status === 'removed') return
    const next: ProjectRecordV1 = {
      ...current,
      status: 'removed',
      removedAt: this.now(),
      revision: current.revision + 1
    }
    await this.save(next)
  }

  getProjectDirectory(projectId: string): string {
    return join(this.projectsRoot, validateIdentifier(projectId))
  }

  private async save(record: ProjectRecordV1): Promise<void> {
    await this.writer.write(this.getRecordPath(record.projectId), record)
    this.records.set(record.projectId, record)
  }

  private async toSummary(record: ProjectRecordV1): Promise<ProjectSummary> {
    let availability: ProjectSummary['availability'] = { state: 'available' }
    try {
      await this.resolveRecordRoot(record)
    } catch {
      availability = { state: 'unavailable', message: '目录已移动、不可访问或权限已撤回。' }
    }
    return {
      projectId: record.projectId,
      canonicalRoot: record.canonicalRoot,
      displayName: record.displayName,
      status: record.status,
      availability,
      registeredAt: record.registeredAt,
      lastOpenedAt: record.lastOpenedAt,
      ...(record.removedAt ? { removedAt: record.removedAt } : {}),
      revision: record.revision
    }
  }

  private async resolveRecordRoot(record: ProjectRecordV1): Promise<void> {
    const root = await resolveCanonicalDirectory(record.canonicalRoot)
    if (!compareCanonicalPath(root, record.canonicalRoot)) throw new Error('root drifted')
  }

  private getRecordPath(projectId: string): string {
    return join(this.getProjectDirectory(projectId), 'project.json')
  }

  /** 损坏记录退出活动命名空间，隔离说明只保存有限枚举，不写入原始内容或异常。 */
  private async quarantine(
    source: string,
    label: string,
    reason: 'invalid-json' | 'invalid-fields' | 'identity-mismatch'
  ): Promise<void> {
    const quarantineRoot = join(this.historyRoot, 'quarantine')
    await this.writer.ensureDirectory(quarantineRoot)
    const target = join(quarantineRoot, `${Date.now()}-${label}-${this.createId()}`)
    try {
      await this.writer.renameDurably(source, target)
      await this.writer.write(`${target}.reason.json`, { reason })
    } catch (error) {
      if (!isFileNotFound(error)) throw error
    }
  }
}

async function resolveCanonicalDirectory(path: string): Promise<string> {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || !isAbsolute(path)) {
    throw new ProjectRegistryError('invalid-input', '请选择有效的绝对目录。')
  }
  try {
    const stats = await fs.stat(path)
    if (!stats.isDirectory()) throw new Error('not directory')
    return await fs.realpath(path)
  } catch {
    throw new ProjectRegistryError('project-unavailable', '请选择现有且可访问的目录。')
  }
}

function compareCanonicalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function isValidIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

function validateIdentifier(value: string): string {
  if (!isValidIdentifier(value)) {
    throw new ProjectRegistryError('invalid-input', 'Project ID 无效。')
  }
  return value
}

type ProjectParseResult =
  | { kind: 'valid'; record: ProjectRecordV1 }
  | { kind: 'unsupported'; value: Record<string, unknown> }
  | { kind: 'corrupt' }

function parseProjectRecord(value: unknown): ProjectParseResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'corrupt' }
  const record = value as Record<string, unknown>
  if (
    Number.isSafeInteger(record.schemaVersion) &&
    Number(record.schemaVersion) > PROJECT_SCHEMA_VERSION
  ) {
    return { kind: 'unsupported', value: record }
  }
  if (record.schemaVersion !== PROJECT_SCHEMA_VERSION) return { kind: 'corrupt' }
  if (!isValidIdentifier(record.projectId) || !isValidCanonicalRoot(record.canonicalRoot)) {
    return { kind: 'corrupt' }
  }
  if (
    typeof record.displayName !== 'string' ||
    Buffer.byteLength(record.displayName, 'utf8') > MAX_IDENTIFIER_BYTES ||
    !['active', 'removed'].includes(String(record.status))
  ) {
    return { kind: 'corrupt' }
  }
  if (
    !isIsoTimestamp(record.registeredAt) ||
    !isIsoTimestamp(record.lastOpenedAt) ||
    !Number.isSafeInteger(record.revision) ||
    Number(record.revision) < 1
  ) {
    return { kind: 'corrupt' }
  }
  if (record.status === 'removed' ? !isIsoTimestamp(record.removedAt) : record.removedAt != null) {
    return { kind: 'corrupt' }
  }
  return { kind: 'valid', record: record as unknown as ProjectRecordV1 }
}

function toUnsupportedSummary(
  projectId: string,
  value: Record<string, unknown>
): ProjectSummary | null {
  if (!isValidCanonicalRoot(value.canonicalRoot)) return null
  const observedAt = isIsoTimestamp(value.lastOpenedAt)
    ? value.lastOpenedAt
    : new Date(0).toISOString()
  return {
    projectId,
    canonicalRoot: value.canonicalRoot,
    displayName:
      typeof value.displayName === 'string' && value.displayName.trim()
        ? value.displayName.slice(0, 256)
        : basename(value.canonicalRoot),
    status: value.status === 'removed' ? 'removed' : 'active',
    availability: {
      state: 'version-unsupported',
      message: '该 Project 由更新版本创建，当前版本仅保留记录且不会重写。'
    },
    registeredAt: isIsoTimestamp(value.registeredAt) ? value.registeredAt : observedAt,
    lastOpenedAt: observedAt,
    revision: Number.isSafeInteger(value.revision) ? Math.max(1, Number(value.revision)) : 1
  }
}

function isValidCanonicalRoot(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_PROJECT_PATH_BYTES
  )
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

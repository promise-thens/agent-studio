import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  ARTIFACT_LIMITS,
  artifactLocationKey,
  classifyArtifactBytes,
  isPrimaryFileArtifactPath,
  parseArtifactDescriptor,
  sanitizeArtifactRelativePath,
  type ArtifactAvailability,
  type ArtifactDescriptor,
  type ArtifactKind,
  type ArtifactLocation,
  type ArtifactSource
} from '../../shared/artifact'
import type { TaskChangeSetQueryResult } from '../../shared/git-review'
import { isPathInsideRoot } from '../project/project-root-resolver'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

const DESCRIPTOR_SCHEMA_VERSION = 1
const DESCRIPTOR_MAX_BYTES = 16 * 1024

export type ArtifactRegistryErrorCode =
  | 'not-found'
  | 'invalid-path'
  | 'escaped'
  | 'not-file'
  | 'empty'
  | 'too-large'
  | 'unsupported-type'
  | 'mime-mismatch'
  | 'binary-text'
  | 'nul'
  | 'quota'

/** Artifact 注册错误对 Renderer 只暴露稳定 code，不夹带绝对路径。 */
export class ArtifactRegistryError extends Error {
  constructor(
    readonly code: ArtifactRegistryErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ArtifactRegistryError'
  }
}

export interface ArtifactTaskContext {
  projectId: string
  taskId: string
  environmentId: string
  executionRoot: string
  lastTurnId?: string
  taskDirectory: string
}

export type ArtifactImageProbe = (bytes: Buffer) => { width: number; height: number } | null

export interface ArtifactRegistryOptions {
  getTaskContext: (taskId: string) => ArtifactTaskContext | Promise<ArtifactTaskContext>
  attachTurnArtifactIds?: (
    taskId: string,
    turnId: string,
    artifactIds: string[]
  ) => Promise<unknown>
  probeImagePixels?: ArtifactImageProbe
  createId?: () => string
  now?: () => string
  writer?: AtomicJsonWriter
}

interface PersistedArtifactRecord extends ArtifactDescriptor {
  schemaVersion: typeof DESCRIPTOR_SCHEMA_VERSION
}

/**
 * Local Artifact 注册表。只持久化描述符与受限相对路径，不复制项目文件。
 */
export class ArtifactRegistry {
  private readonly getTaskContext: ArtifactRegistryOptions['getTaskContext']
  private readonly attachTurnArtifactIds: ArtifactRegistryOptions['attachTurnArtifactIds']
  private readonly probeImagePixels: ArtifactImageProbe | undefined
  private readonly createId: () => string
  private readonly now: () => string
  private readonly writer: AtomicJsonWriter

  constructor(options: ArtifactRegistryOptions) {
    this.getTaskContext = options.getTaskContext
    this.attachTurnArtifactIds = options.attachTurnArtifactIds
    this.probeImagePixels = options.probeImagePixels
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
    this.writer = options.writer ?? new AtomicJsonWriter()
  }

  async registerFileCandidate(input: {
    taskId: string
    turnId?: string
    source: ArtifactSource
    relativePath: string
  }): Promise<ArtifactDescriptor> {
    const context = await this.requireContext(input.taskId)
    const located = await this.resolveRegularFile(context.executionRoot, input.relativePath)
    const bytes = await fs.readFile(located.realPath)
    const classified = classifyArtifactBytes({
      relativePath: located.relativePath,
      bytes
    })
    if (!classified.ok) {
      throw new ArtifactRegistryError(classified.reason, rejectMessage(classified.reason))
    }
    if (classified.kind === 'image') {
      const pixels = this.probeImagePixels?.(bytes)
      if (!pixels) throw new ArtifactRegistryError('mime-mismatch', '无法解码该图片。')
      if (pixels.width * pixels.height > ARTIFACT_LIMITS.maxImagePixels) {
        throw new ArtifactRegistryError('too-large', '图片像素超过上限。')
      }
    }
    const contentHash = sha256(bytes)
    return this.upsertDescriptor(context, {
      turnId: input.turnId,
      source: input.source,
      kind: classified.kind,
      title: classified.title,
      mimeType: classified.mimeType,
      location: { kind: 'file', relativePath: located.relativePath },
      size: bytes.byteLength,
      contentHash,
      availability: 'ready',
      trustLevel: 'verified'
    })
  }

  async registerDiffCandidate(input: {
    taskId: string
    turnId?: string
    source: ArtifactSource
    path: string
  }): Promise<ArtifactDescriptor> {
    const context = await this.requireContext(input.taskId)
    const path = sanitizeArtifactRelativePath(input.path)
    if (!path) throw new ArtifactRegistryError('invalid-path', 'Artifact 路径无效。')
    return this.upsertDescriptor(context, {
      turnId: input.turnId,
      source: input.source,
      kind: 'diff',
      title: path.split('/').pop() || path,
      mimeType: 'text/x-diff',
      location: { kind: 'diff', path },
      size: 0,
      contentHash: `diff:${path}`,
      availability: 'ready',
      trustLevel: 'verified'
    })
  }

  async list(taskId: string): Promise<ArtifactDescriptor[]> {
    const context = await this.requireContext(taskId)
    const records = await this.readAll(context)
    const next: ArtifactDescriptor[] = []
    for (const record of records) {
      next.push(await this.revalidateAndPersist(context, record))
    }
    return next.sort(compareDescriptors)
  }

  async get(taskId: string, artifactId: string): Promise<ArtifactDescriptor> {
    const context = await this.requireContext(taskId)
    const record = await this.readOne(context, artifactId)
    if (!record) throw new ArtifactRegistryError('not-found', '未找到该 Artifact。')
    return this.revalidateAndPersist(context, record)
  }

  /**
   * 读取前再次校验真实路径。只返回字节，不把绝对路径交给内容服务以外的层。
   */
  async readVerifiedBytes(
    taskId: string,
    artifactId: string
  ): Promise<{
    descriptor: ArtifactDescriptor
    bytes: Buffer
  }> {
    const context = await this.requireContext(taskId)
    const descriptor = await this.get(taskId, artifactId)
    if (descriptor.location.kind !== 'file') {
      throw new ArtifactRegistryError('not-file', '该 Artifact 没有可读取的文件正文。')
    }
    if (descriptor.availability !== 'ready' && descriptor.availability !== 'changed') {
      throw new ArtifactRegistryError('not-found', 'Artifact 当前不可读取。')
    }
    const located = await this.resolveRegularFile(
      context.executionRoot,
      descriptor.location.relativePath
    )
    const bytes = await fs.readFile(located.realPath)
    return { descriptor, bytes }
  }

  async listPersisted(taskId: string): Promise<ArtifactDescriptor[]> {
    const context = await this.requireContext(taskId)
    return (await this.readAll(context)).sort(compareDescriptors)
  }

  /**
   * 从 Git Review 变更集提交候选。失败单条跳过，避免一个坏文件挡住整表。
   */
  async syncFromChangeSet(
    taskId: string,
    changeSet: Pick<TaskChangeSetQueryResult, 'paths'>
  ): Promise<void> {
    for (const item of changeSet.paths) {
      if (item.attribution !== 'task-added' && item.attribution !== 'task-modified') continue
      if (item.omitted) continue
      const relativePath = sanitizeArtifactRelativePath(item.path)
      if (!relativePath) continue
      if (isPrimaryFileArtifactPath(relativePath)) {
        await this.registerFileCandidate({
          taskId,
          source: 'git-review',
          relativePath
        }).catch(() => undefined)
      }
      await this.registerDiffCandidate({
        taskId,
        source: 'git-review',
        path: relativePath
      }).catch(() => undefined)
    }
  }

  private async upsertDescriptor(
    context: ArtifactTaskContext,
    input: {
      turnId?: string
      source: ArtifactSource
      kind: ArtifactKind
      title: string
      mimeType: string
      location: ArtifactLocation
      size: number
      contentHash: string
      availability: ArtifactAvailability
      trustLevel: ArtifactDescriptor['trustLevel']
    }
  ): Promise<ArtifactDescriptor> {
    const existing = await this.readAll(context)
    if (existing.length >= ARTIFACT_LIMITS.maxArtifactsPerTask) {
      const same = existing.find(
        (item) => artifactLocationKey(item.location) === artifactLocationKey(input.location)
      )
      if (!same) throw new ArtifactRegistryError('quota', '当前 Task 产物数量超过上限。')
    }
    const previous = existing.find(
      (item) => artifactLocationKey(item.location) === artifactLocationKey(input.location)
    )
    const turnId = input.turnId ?? previous?.turnId ?? context.lastTurnId
    if (!turnId) throw new ArtifactRegistryError('invalid-path', 'Artifact 缺少 Turn 身份。')
    const revision =
      previous && previous.contentHash !== input.contentHash
        ? previous.revision + 1
        : (previous?.revision ?? 1)
    const descriptor: ArtifactDescriptor = {
      artifactId: previous?.artifactId ?? this.createId(),
      projectId: context.projectId,
      taskId: context.taskId,
      turnId,
      kind: input.kind,
      title: input.title,
      mimeType: input.mimeType,
      source: previous?.source ?? input.source,
      environmentId: context.environmentId,
      location: input.location,
      size: input.size,
      contentHash: input.contentHash,
      createdAt: previous?.createdAt ?? this.now(),
      trustLevel: input.trustLevel,
      availability: input.availability,
      revision
    }
    await this.writeDescriptor(context, descriptor)
    await this.syncTurnArtifactIds(context, turnId)
    return descriptor
  }

  /**
   * 每次列表/读取都重新核对真实路径和哈希，避免把旧内容继续标成已验证。
   */
  private async revalidateAndPersist(
    context: ArtifactTaskContext,
    record: ArtifactDescriptor
  ): Promise<ArtifactDescriptor> {
    if (record.location.kind === 'diff') {
      const path = sanitizeArtifactRelativePath(record.location.path)
      const next: ArtifactDescriptor = {
        ...record,
        availability: path ? 'ready' : 'unavailable',
        trustLevel: path ? 'verified' : 'unsupported'
      }
      if (next.availability !== record.availability) await this.writeDescriptor(context, next)
      return next
    }

    const verified = await this.inspectFile(context.executionRoot, record.location.relativePath)
    let next: ArtifactDescriptor = { ...record, availability: verified.availability }
    if (verified.availability === 'ready' && verified.contentHash !== record.contentHash) {
      next = {
        ...record,
        size: verified.size,
        contentHash: verified.contentHash,
        availability: 'changed',
        revision: record.revision + 1
      }
    }
    if (
      next.availability !== record.availability ||
      next.contentHash !== record.contentHash ||
      next.revision !== record.revision
    ) {
      await this.writeDescriptor(context, next)
    }
    return next
  }

  private async inspectFile(
    executionRoot: string,
    relativePath: string
  ): Promise<
    | { availability: 'ready'; contentHash: string; size: number }
    | { availability: Exclude<ArtifactAvailability, 'ready' | 'changed'> }
  > {
    try {
      const located = await this.resolveRegularFile(executionRoot, relativePath)
      const bytes = await fs.readFile(located.realPath)
      const classified = classifyArtifactBytes({
        relativePath: located.relativePath,
        bytes
      })
      if (!classified.ok) return { availability: 'unsupported' }
      return {
        availability: 'ready',
        contentHash: sha256(bytes),
        size: bytes.byteLength
      }
    } catch (error) {
      if (error instanceof ArtifactRegistryError && error.code === 'not-file') {
        return { availability: 'unavailable' }
      }
      if (error instanceof ArtifactRegistryError && error.code === 'escaped') {
        return { availability: 'unavailable' }
      }
      if (error instanceof ArtifactRegistryError && error.code === 'invalid-path') {
        return { availability: 'unavailable' }
      }
      if (isFileNotFound(error)) return { availability: 'missing' }
      return { availability: 'unavailable' }
    }
  }

  /**
   * 先 lstat 拒绝符号链接，再 realpath 确认仍落在 Local execution root 内。
   */
  private async resolveRegularFile(
    executionRoot: string,
    relativePath: string
  ): Promise<{ relativePath: string; realPath: string }> {
    const sanitized = sanitizeArtifactRelativePath(relativePath)
    if (!sanitized) throw new ArtifactRegistryError('invalid-path', 'Artifact 路径无效。')
    const joined = resolve(executionRoot, sanitized)
    if (isAbsolute(relativePath) || !isPathInsideRoot(executionRoot, joined)) {
      throw new ArtifactRegistryError('escaped', 'Artifact 路径越界。')
    }
    const stats = await fs.lstat(joined)
    if (stats.isSymbolicLink()) {
      throw new ArtifactRegistryError('escaped', '拒绝跟随符号链接。')
    }
    if (!stats.isFile() || stats.isDirectory()) {
      throw new ArtifactRegistryError('not-file', '只能注册普通文件。')
    }
    const realPath = await fs.realpath(joined)
    if (!isPathInsideRoot(executionRoot, realPath)) {
      throw new ArtifactRegistryError('escaped', 'Artifact 路径越界。')
    }
    return { relativePath: sanitized, realPath }
  }

  private async requireContext(taskId: string): Promise<ArtifactTaskContext> {
    const context = await this.getTaskContext(taskId)
    if (!context || context.taskId !== taskId) {
      throw new ArtifactRegistryError('not-found', '未找到指定 Task。')
    }
    // macOS 上 /var 常是 /private/var 的符号链接，必须用真实根做越界判断。
    const executionRoot = await fs.realpath(context.executionRoot)
    return { ...context, executionRoot }
  }

  private artifactsRoot(context: ArtifactTaskContext): string {
    return join(context.taskDirectory, 'artifacts')
  }

  private descriptorPath(context: ArtifactTaskContext, artifactId: string): string {
    return join(this.artifactsRoot(context), `${artifactId}.json`)
  }

  private async readAll(context: ArtifactTaskContext): Promise<ArtifactDescriptor[]> {
    const root = this.artifactsRoot(context)
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const items: ArtifactDescriptor[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const artifactId = entry.name.slice(0, -'.json'.length)
      const parsed = await this.readOne(context, artifactId)
      if (parsed) items.push(parsed)
    }
    return items
  }

  private async readOne(
    context: ArtifactTaskContext,
    artifactId: string
  ): Promise<ArtifactDescriptor | null> {
    if (!isArtifactIdentity(artifactId)) return null
    try {
      const raw = await this.writer.read(
        this.descriptorPath(context, artifactId),
        DESCRIPTOR_MAX_BYTES
      )
      if (!isRecord(raw) || raw.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) return null
      const parsed = parseArtifactDescriptor(raw)
      if (!parsed || parsed.taskId !== context.taskId || parsed.artifactId !== artifactId)
        return null
      return parsed
    } catch {
      return null
    }
  }

  private async writeDescriptor(
    context: ArtifactTaskContext,
    descriptor: ArtifactDescriptor
  ): Promise<void> {
    const parsed = parseArtifactDescriptor(descriptor)
    if (!parsed) throw new ArtifactRegistryError('invalid-path', 'Artifact 描述符无效。')
    const record: PersistedArtifactRecord = { schemaVersion: DESCRIPTOR_SCHEMA_VERSION, ...parsed }
    await this.writer.write(this.descriptorPath(context, parsed.artifactId), record)
  }

  private async syncTurnArtifactIds(context: ArtifactTaskContext, turnId: string): Promise<void> {
    if (!this.attachTurnArtifactIds) return
    const ids = (await this.readAll(context))
      .filter((item) => item.turnId === turnId)
      .map((item) => item.artifactId)
    await this.attachTurnArtifactIds(context.taskId, turnId, ids)
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareDescriptors(left: ArtifactDescriptor, right: ArtifactDescriptor): number {
  const time = left.createdAt.localeCompare(right.createdAt)
  if (time !== 0) return time
  return left.artifactId.localeCompare(right.artifactId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isArtifactIdentity(value: string): boolean {
  return (
    Boolean(value.trim()) && !value.includes('/') && !value.includes('\\') && !value.includes('\0')
  )
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function rejectMessage(reason: ArtifactRegistryErrorCode): string {
  if (reason === 'empty') return '文件为空。'
  if (reason === 'too-large') return '文件超过大小上限。'
  if (reason === 'unsupported-type') return '不支持该文件类型。'
  if (reason === 'mime-mismatch') return '扩展名与文件内容不一致。'
  if (reason === 'binary-text') return '文本内容不是合法 UTF-8。'
  if (reason === 'nul') return '文本内容包含非法空字符。'
  if (reason === 'invalid-path') return 'Artifact 路径无效。'
  return '无法注册该文件。'
}

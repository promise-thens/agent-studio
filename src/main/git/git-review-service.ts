import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  deriveValidationResult,
  takeLatestCommandEvidencePage,
  type CommandExecutionEvidence,
  type ValidationResult
} from '../../shared/command'
import type { ProjectAvailability } from '../../shared/task-history'
import type {
  FileDiffResult,
  FileDiffStatus,
  ResolvedProjectRoot,
  TaskChangeAttribution,
  TaskChangeBaseline,
  TaskChangePath,
  TaskChangePathSnapshot,
  TaskChangeSetQueryResult,
  TurnChangeCheckpoint
} from '../../shared/git-review'
import { redactSensitiveText } from '../security/sensitive-redaction'
import {
  DEFAULT_GIT_TIMEOUT_MS,
  isPathInsideRoot,
  resolveProjectRoot,
  runReadOnlyGit,
  toPosixRelativePath,
  type ReadOnlyGitOptions
} from '../project/project-root-resolver'
import { evaluateBaselineValidity, type TaskChangeBaselineStore } from './task-change-baseline'
import type { TurnChangeCheckpointStore } from './turn-change-checkpoint'

export const MAX_CHANGE_SET_PATHS = 500
export const MAX_FILE_DIFF_BYTES = 64 * 1024
export const REVERT_UNAVAILABLE_REASON = '当前版本仅提供只读审阅，不支持一键撤销。'

const MAX_HASH_FILE_BYTES = 256 * 1024
const MAX_HASH_TOTAL_BYTES = 2 * 1024 * 1024
const BINARY_SAMPLE_BYTES = 8 * 1024
const MAX_STATUS_CODE_CHARS = 8
const MAX_LISTING_DEPTH = 4
const MAX_LISTING_ENTRIES = 256
const MAX_VALIDATION_COMMAND_IDS = 32
const SKIP_LISTING_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'target',
  'build',
  'coverage',
  '.cache'
])

export interface GitReviewTaskIdentity {
  taskId: string
  projectId: string
  environmentId: string
  executionRoot: string
}

export interface RecordTurnChangeCheckpointInput {
  taskId: string
  turnId: string
  projectId: string
  environmentId: string
  executionRoot: string
  phase: 'before' | 'after'
}

export interface GitReviewServiceDependencies {
  baselineStore: TaskChangeBaselineStore
  checkpointStore: TurnChangeCheckpointStore
  getTaskIdentity: (taskId: string) => GitReviewTaskIdentity
  getProjectAvailability: (projectId: string) => Promise<ProjectAvailability>
  listCommandEvidence?: (taskId: string) => Promise<CommandExecutionEvidence[]>
  hasPersistIncomplete?: (taskId: string) => boolean
  waitForEvidenceWrites?: () => Promise<void>
  attachTurnValidationIds?: (
    taskId: string,
    turnId: string,
    validationIds: string[]
  ) => Promise<unknown>
  now?: () => string
  gitExecutable?: string
  sourceEnvironment?: NodeJS.ProcessEnv
}

/**
 * 计算 Task 变更归因、有界 Diff 和验证摘要。只读 git，不经 AppCommandRunner。
 */
export class GitReviewService {
  private readonly now: () => string

  constructor(private readonly deps: GitReviewServiceDependencies) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  async getChangeSet(taskId: string): Promise<TaskChangeSetQueryResult> {
    if (this.deps.waitForEvidenceWrites) await this.deps.waitForEvidenceWrites()
    const identity = this.deps.getTaskIdentity(taskId)
    const computed = await this.computeAttributedChangeSet(identity)
    const validations = await this.collectValidations(taskId)
    return toQueryResult(computed.changeSet, validations)
  }

  async getFileDiff(taskId: string, requestedPath: string): Promise<FileDiffResult> {
    const identity = this.deps.getTaskIdentity(taskId)
    return await this.buildFileDiff(identity, requestedPath)
  }

  async listTurnCheckpoints(taskId: string): Promise<TurnChangeCheckpoint[]> {
    this.deps.getTaskIdentity(taskId)
    return await this.deps.checkpointStore.list(taskId)
  }

  /**
   * 写入型 Turn 的 before/after 快照。调用方必须吞掉抛错，不得让 Turn 失败。
   */
  async recordTurnCheckpoint(input: RecordTurnChangeCheckpointInput): Promise<void> {
    if (input.phase === 'before') {
      await this.captureBeforeCheckpoint(input)
      return
    }
    await this.captureAfterCheckpoint(input)
  }

  private async computeAttributedChangeSet(identity: GitReviewTaskIdentity): Promise<{
    changeSet: import('../../shared/git-review').TaskChangeSet
    resolved: ResolvedProjectRoot
    current: TaskChangePathSnapshot[]
    baseline: TaskChangeBaseline | null
    lastCompleteAfter?: TaskChangePathSnapshot[]
  }> {
    const generatedAt = this.now()
    const gitOptions = this.gitOptions()
    const resolved = await resolveProjectRoot({
      taskId: identity.taskId,
      projectId: identity.projectId,
      environmentId: identity.environmentId,
      environmentKind: 'local',
      executionRoot: identity.executionRoot,
      now: this.now,
      gitExecutable: this.deps.gitExecutable,
      sourceEnvironment: this.deps.sourceEnvironment,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    })
    const baseline = await this.deps.baselineStore.get(identity.taskId, identity.environmentId)
    const availability = await this.safeProjectAvailability(identity.projectId)
    const baselineUsable = await this.isBaselineUsable(baseline, resolved, availability, gitOptions)
    const snapshot = await snapshotWorkingTree(resolved, gitOptions, MAX_CHANGE_SET_PATHS)
    const lastComplete = await this.findLastCompleteCheckpoint(identity.taskId)
    const lastCompleteAfter = lastComplete?.afterPaths
    const attributed = attributeWorkingTreePaths({
      current: snapshot.paths,
      baseline,
      lastCompleteAfter,
      baselineUsable,
      maxPaths: MAX_CHANGE_SET_PATHS
    })
    const truncated = snapshot.truncated || attributed.truncated || snapshot.unavailable
    const changeSet: import('../../shared/git-review').TaskChangeSet = {
      taskId: identity.taskId,
      environmentId: identity.environmentId,
      baselineStatus: baselineUsable
        ? 'captured'
        : baseline?.status === 'unavailable'
          ? 'unavailable'
          : 'invalid',
      gitPresence: resolved.git.kind,
      generatedAt,
      paths: attributed.paths,
      revertible: { kind: 'none', reason: REVERT_UNAVAILABLE_REASON }
    }
    if (!baselineUsable && baseline?.invalidReason) changeSet.invalidReason = baseline.invalidReason
    if (!baselineUsable && !changeSet.invalidReason) {
      const validity =
        baseline && baseline.status === 'captured'
          ? await evaluateBaselineValidity(baseline, resolved, availability, gitOptions)
          : null
      if (validity && !validity.valid && validity.reason) changeSet.invalidReason = validity.reason
    }
    if (baselineUsable && baseline?.baseCommit) changeSet.baseCommit = baseline.baseCommit
    else if (resolved.git.kind === 'git' && resolved.git.head.oid) {
      changeSet.baseCommit = baseline?.baseCommit ?? resolved.git.head.oid
    }
    if (truncated) changeSet.truncated = true
    return { changeSet, resolved, current: snapshot.paths, baseline, lastCompleteAfter }
  }

  private async captureBeforeCheckpoint(input: RecordTurnChangeCheckpointInput): Promise<void> {
    const existing = await this.deps.checkpointStore.get(input.taskId, input.turnId)
    if (existing) return
    const resolved = await resolveProjectRoot({
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      environmentKind: 'local',
      executionRoot: input.executionRoot,
      now: this.now,
      gitExecutable: this.deps.gitExecutable,
      sourceEnvironment: this.deps.sourceEnvironment,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    })
    const snapshot = await snapshotWorkingTree(resolved, this.gitOptions(), MAX_CHANGE_SET_PATHS)
    const previous = (await this.deps.checkpointStore.list(input.taskId)).at(-1)
    const checkpoint: TurnChangeCheckpoint = {
      schemaVersion: 1,
      taskId: input.taskId,
      turnId: input.turnId,
      environmentId: input.environmentId,
      capturedBeforeAt: this.now(),
      status: 'incomplete',
      beforePaths: snapshot.paths,
      affectedPaths: []
    }
    if (previous) checkpoint.previousCheckpointId = previous.turnId
    const drift = await this.detectDrift(input, resolved)
    if (drift) checkpoint.drift = drift
    await this.deps.checkpointStore.put(checkpoint)
  }

  private async captureAfterCheckpoint(input: RecordTurnChangeCheckpointInput): Promise<void> {
    const existing = await this.deps.checkpointStore.get(input.taskId, input.turnId)
    if (existing?.status === 'complete' || existing?.status === 'no-change') return
    const resolved = await resolveProjectRoot({
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      environmentKind: 'local',
      executionRoot: input.executionRoot,
      now: this.now,
      gitExecutable: this.deps.gitExecutable,
      sourceEnvironment: this.deps.sourceEnvironment,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    })
    const snapshot = await snapshotWorkingTree(resolved, this.gitOptions(), MAX_CHANGE_SET_PATHS)
    const beforePaths = existing?.beforePaths ?? []
    const capturedBeforeAt = existing?.capturedBeforeAt ?? this.now()
    const affectedPaths = diffSnapshotPaths(beforePaths, snapshot.paths)
    const noChange = affectedPaths.length === 0
    const computed = await this.computeAttributedChangeSet({
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      executionRoot: input.executionRoot
    })
    const attributionSummary = summarizeAttributions(
      computed.changeSet.paths.filter((item) => affectedPaths.includes(item.path))
    )
    const checkpoint: TurnChangeCheckpoint = {
      schemaVersion: 1,
      taskId: input.taskId,
      turnId: input.turnId,
      environmentId: input.environmentId,
      capturedBeforeAt,
      capturedAfterAt: this.now(),
      status: noChange ? 'no-change' : 'complete',
      beforePaths,
      afterPaths: snapshot.paths,
      affectedPaths,
      ...(existing?.previousCheckpointId
        ? { previousCheckpointId: existing.previousCheckpointId }
        : {})
    }
    if (Object.keys(attributionSummary).length > 0)
      checkpoint.attributionSummary = attributionSummary
    const drift = await this.detectDrift(input, resolved)
    if (drift) checkpoint.drift = drift
    await this.deps.checkpointStore.put(checkpoint)
    await this.bindTurnValidations(input.taskId, input.turnId)
  }

  private async bindTurnValidations(taskId: string, turnId: string): Promise<void> {
    if (!this.deps.attachTurnValidationIds) return
    const validations = await this.collectValidations(taskId)
    const matched = validations.find((item) => item.turnId === turnId)
    if (!matched) return
    try {
      await this.deps.attachTurnValidationIds(taskId, turnId, [matched.validationId])
    } catch {
      // 绑定失败不得影响检查点或 Turn 终态。
    }
  }

  private async collectValidations(taskId: string): Promise<ValidationResult[]> {
    if (!this.deps.listCommandEvidence) return []
    const listed = await this.deps.listCommandEvidence(taskId)
    const scoped = listed.filter((item) => item.taskId === taskId)
    const persistIncomplete = this.deps.hasPersistIncomplete?.(taskId) === true
    return deriveTaskValidations(scoped, { persistIncomplete })
  }

  private async buildFileDiff(
    identity: GitReviewTaskIdentity,
    requestedPath: string
  ): Promise<FileDiffResult> {
    const safeRequested = sanitizeRequestedPath(requestedPath)
    if (safeRequested.kind === 'escaped') {
      return { taskId: identity.taskId, path: safeRequested.displayPath, status: 'escaped' }
    }

    const resolved = await resolveProjectRoot({
      taskId: identity.taskId,
      projectId: identity.projectId,
      environmentId: identity.environmentId,
      environmentKind: 'local',
      executionRoot: identity.executionRoot,
      now: this.now,
      gitExecutable: this.deps.gitExecutable,
      sourceEnvironment: this.deps.sourceEnvironment,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    })
    if (resolved.git.kind === 'invalid') {
      return { taskId: identity.taskId, path: safeRequested.path, status: 'unavailable' }
    }

    const gitRoot = resolved.git.kind === 'git' ? resolved.git.gitRoot : resolved.executionRoot
    const located = await resolveContainedWorkingPath(
      resolved.executionRoot,
      gitRoot,
      safeRequested.path
    )
    if (!located) {
      return { taskId: identity.taskId, path: safeRequested.path, status: 'escaped' }
    }
    if (located.kind === 'escaped') {
      return { taskId: identity.taskId, path: located.relativePath, status: 'escaped' }
    }

    const relativePath = located.relativePath
    const classification = await classifyDiffPath(located, resolved, this.gitOptions())
    if (classification.status !== 'ok' && classification.status !== 'untracked') {
      return {
        taskId: identity.taskId,
        path: relativePath,
        status: classification.status,
        ...(classification.truncated ? { truncated: true as const } : {}),
        ...(classification.unifiedDiff ? { unifiedDiff: classification.unifiedDiff } : {})
      }
    }

    if (resolved.git.kind !== 'git') {
      if (located.kind === 'missing') {
        return { taskId: identity.taskId, path: relativePath, status: 'missing' }
      }
      return await readUntrackedDiff(identity.taskId, relativePath, located.realPath)
    }

    if (classification.status === 'untracked' && located.kind === 'inside') {
      return await readUntrackedDiff(identity.taskId, relativePath, located.realPath)
    }

    const gitRelative = toPosixRelativePath(
      resolved.git.gitRoot,
      join(resolved.executionRoot, relativePath.split('/').join('/'))
    )
    const pathspec =
      gitRelative ||
      toPosixRelativePath(
        resolved.git.gitRoot,
        located.kind === 'inside' ? located.realPath : resolve(resolved.executionRoot, relativePath)
      )
    if (!pathspec) {
      return { taskId: identity.taskId, path: relativePath, status: 'escaped' }
    }

    const diff = await runReadOnlyGit(
      resolved.git.gitRoot,
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--unified=3',
        'HEAD',
        '--',
        pathspec
      ],
      { ...this.gitOptions(), allowedRoot: resolved.executionRoot }
    )
    if (!diff.ok) {
      return { taskId: identity.taskId, path: relativePath, status: 'unavailable' }
    }
    const redacted = redactDiffText(diff.stdout, [resolved.executionRoot, resolved.git.gitRoot])
    if (isBinaryDiffOutput(redacted)) {
      return { taskId: identity.taskId, path: relativePath, status: 'binary' }
    }
    if (Buffer.byteLength(redacted, 'utf8') > MAX_FILE_DIFF_BYTES) {
      return {
        taskId: identity.taskId,
        path: relativePath,
        status: 'truncated',
        truncated: true,
        unifiedDiff: truncateUtf8(redacted, MAX_FILE_DIFF_BYTES)
      }
    }
    if (located.kind === 'missing' && !redacted.trim()) {
      return { taskId: identity.taskId, path: relativePath, status: 'missing' }
    }
    return {
      taskId: identity.taskId,
      path: relativePath,
      status: 'ok',
      ...(redacted ? { unifiedDiff: redacted } : {})
    }
  }

  private async findLastCompleteCheckpoint(taskId: string): Promise<TurnChangeCheckpoint | null> {
    const listed = await this.deps.checkpointStore.list(taskId)
    for (let index = listed.length - 1; index >= 0; index -= 1) {
      const item = listed[index]
      if (item && item.status === 'complete' && item.afterPaths) return item
    }
    return null
  }

  private async isBaselineUsable(
    baseline: TaskChangeBaseline | null,
    resolved: ResolvedProjectRoot,
    availability: ProjectAvailability,
    gitOptions: ReadOnlyGitOptions
  ): Promise<boolean> {
    if (!baseline || baseline.status !== 'captured') return false
    if (baseline.environmentId !== resolved.environmentId) return false
    const validity = await evaluateBaselineValidity(baseline, resolved, availability, gitOptions)
    return validity.valid
  }

  private async detectDrift(
    input: RecordTurnChangeCheckpointInput,
    resolved: ResolvedProjectRoot
  ): Promise<TurnChangeCheckpoint['drift'] | undefined> {
    const baseline = await this.deps.baselineStore.get(input.taskId, input.environmentId)
    if (baseline && baseline.environmentId !== input.environmentId) return 'environment-mismatch'
    if (resolved.environmentId !== input.environmentId) return 'environment-mismatch'
    const availability = await this.safeProjectAvailability(input.projectId)
    if (!baseline || baseline.status !== 'captured') return 'baseline-invalid'
    const validity = await evaluateBaselineValidity(
      baseline,
      resolved,
      availability,
      this.gitOptions()
    )
    if (!validity.valid) {
      if (validity.reason === 'head-changed' || validity.reason === 'path-replaced')
        return 'external'
      return 'baseline-invalid'
    }
    return undefined
  }

  private async safeProjectAvailability(projectId: string): Promise<ProjectAvailability> {
    try {
      return await this.deps.getProjectAvailability(projectId)
    } catch {
      return { state: 'unavailable', message: 'Project 当前不可用。' }
    }
  }

  private gitOptions(): ReadOnlyGitOptions {
    return {
      gitExecutable: this.deps.gitExecutable,
      sourceEnvironment: this.deps.sourceEnvironment,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    }
  }
}

/**
 * TaskExecutor 可选 hook：before 写在 baseline 之后，after 写在终态提交之后。
 */
export function createRecordTurnChangeCheckpoint(
  service: GitReviewService
): (input: RecordTurnChangeCheckpointInput) => Promise<void> {
  return async (input) => {
    await service.recordTurnCheckpoint(input)
  }
}

export function deriveTaskValidations(
  evidences: CommandExecutionEvidence[],
  options: { persistIncomplete?: boolean } = {}
): ValidationResult[] {
  const page = takeLatestCommandEvidencePage(evidences)
  const grouped = new Map<string, CommandExecutionEvidence[]>()
  for (const evidence of page.items) {
    const bucket = grouped.get(evidence.turnId) ?? []
    bucket.push(evidence)
    grouped.set(evidence.turnId, bucket)
  }
  const results: ValidationResult[] = []
  for (const [turnId, items] of grouped) {
    const first = items[0]
    if (!first) continue
    let window = items
    let incomplete = Boolean(options.persistIncomplete) || page.truncated === true
    if (window.length > MAX_VALIDATION_COMMAND_IDS) {
      window = window.slice(-MAX_VALIDATION_COMMAND_IDS)
      incomplete = true
    }
    const derived = deriveValidationResult(window, `val_${first.taskId}_${turnId}`, {
      listIncomplete: incomplete
    })
    if (derived) results.push(derived)
  }
  return results
}

export function attributeWorkingTreePaths(input: {
  current: TaskChangePathSnapshot[]
  baseline: TaskChangeBaseline | null
  lastCompleteAfter?: TaskChangePathSnapshot[]
  baselineUsable: boolean
  maxPaths?: number
}): { paths: TaskChangePath[]; truncated: boolean } {
  const maxPaths = input.maxPaths ?? MAX_CHANGE_SET_PATHS
  const currentByPath = new Map(input.current.map((item) => [item.path, item]))
  const baselineByPath = new Map(
    (input.baseline?.preExistingPaths ?? []).map((item) => [item.path, item])
  )
  const afterByPath = new Map((input.lastCompleteAfter ?? []).map((item) => [item.path, item]))
  const allPaths = new Set<string>([
    ...currentByPath.keys(),
    ...baselineByPath.keys(),
    ...afterByPath.keys()
  ])
  const ordered = [...allPaths].sort((left, right) => left.localeCompare(right))
  const paths: TaskChangePath[] = []
  let truncated = false

  for (const path of ordered) {
    if (paths.length >= maxPaths) {
      truncated = true
      break
    }
    const current = currentByPath.get(path)
    const baselinePath = baselineByPath.get(path)
    const afterPath = afterByPath.get(path)
    const attribution = attributeOnePath({
      current,
      baseline: baselinePath,
      after: afterPath,
      hasCompleteAfter: Boolean(input.lastCompleteAfter),
      baselineUsable: input.baselineUsable
    })
    const omitted = resolvePathOmission(current, baselinePath)
    const result: TaskChangePath = { path, attribution }
    const hash = current?.contentHash ?? afterPath?.contentHash ?? baselinePath?.contentHash
    if (hash) result.contentHash = hash
    if (omitted) result.omitted = omitted
    paths.push(result)
  }
  return { paths, truncated }
}

function attributeOnePath(input: {
  current?: TaskChangePathSnapshot
  baseline?: TaskChangePathSnapshot
  after?: TaskChangePathSnapshot
  hasCompleteAfter: boolean
  baselineUsable: boolean
}): TaskChangeAttribution {
  if (input.hasCompleteAfter && !pathSnapshotsEquivalent(input.after, input.current ?? null)) {
    return 'user-changed-after-task'
  }
  if (!input.baselineUsable) return 'overlap-unknown'
  if (input.baseline) {
    if (!input.current || isDeletedSnapshot(input.current)) return 'overlap-unknown'
    if (pathSnapshotsEquivalent(input.baseline, input.current)) return 'pre-existing'
    return 'overlap-unknown'
  }
  if (!input.current) return 'overlap-unknown'
  if (input.current.kind === 'untracked' && !isDeletedSnapshot(input.current)) return 'task-added'
  if (isDeletedSnapshot(input.current)) return 'task-deleted'
  if (input.current.kind === 'tracked') return 'task-modified'
  return 'overlap-unknown'
}

function resolvePathOmission(
  current?: TaskChangePathSnapshot,
  baseline?: TaskChangePathSnapshot
): TaskChangePath['omitted'] | undefined {
  const omitted = current?.omitted ?? baseline?.omitted
  if (omitted === 'too-large' || omitted === 'binary' || omitted === 'limit') return omitted
  if (current?.kind === 'untracked' && !isDeletedSnapshot(current)) return 'untracked'
  return undefined
}

function toQueryResult(
  changeSet: import('../../shared/git-review').TaskChangeSet,
  validations: ValidationResult[]
): TaskChangeSetQueryResult {
  let preExistingCount = 0
  let taskChangedCount = 0
  let unknownCount = 0
  for (const path of changeSet.paths) {
    if (path.attribution === 'pre-existing') preExistingCount += 1
    else if (
      path.attribution === 'task-added' ||
      path.attribution === 'task-modified' ||
      path.attribution === 'task-deleted'
    ) {
      taskChangedCount += 1
    } else unknownCount += 1
  }
  const result: TaskChangeSetQueryResult = {
    taskId: changeSet.taskId,
    environmentId: changeSet.environmentId,
    baselineStatus: changeSet.baselineStatus,
    gitPresence: changeSet.gitPresence,
    generatedAt: changeSet.generatedAt,
    paths: changeSet.paths,
    revertible: changeSet.revertible,
    preExistingCount,
    taskChangedCount,
    unknownCount,
    validations
  }
  if (changeSet.invalidReason) result.invalidReason = changeSet.invalidReason
  if (changeSet.baseCommit) result.baseCommit = changeSet.baseCommit
  if (changeSet.truncated) result.truncated = true
  return result
}

function summarizeAttributions(
  paths: TaskChangePath[]
): Partial<Record<TaskChangeAttribution, number>> {
  const summary: Partial<Record<TaskChangeAttribution, number>> = {}
  for (const path of paths) {
    summary[path.attribution] = (summary[path.attribution] ?? 0) + 1
  }
  return summary
}

interface WorkingTreeSnapshot {
  paths: TaskChangePathSnapshot[]
  truncated: boolean
  unavailable: boolean
}

async function snapshotWorkingTree(
  resolved: ResolvedProjectRoot,
  gitOptions: ReadOnlyGitOptions,
  maxPaths: number
): Promise<WorkingTreeSnapshot> {
  if (resolved.git.kind === 'invalid') {
    return { paths: [], truncated: false, unavailable: true }
  }
  if (resolved.git.kind === 'non-git') {
    const listing = await listBoundedWorkingTreeFiles(resolved.executionRoot, maxPaths)
    return {
      paths: listing.paths,
      truncated: listing.truncated,
      unavailable: resolved.git.reason === 'git-unavailable'
    }
  }
  const status = await runReadOnlyGit(
    resolved.git.gitRoot,
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--untracked-files=all'],
    { ...gitOptions, allowedRoot: resolved.executionRoot }
  )
  if (!status.ok) return { paths: [], truncated: false, unavailable: true }
  const snapshot = await snapshotPorcelainPaths(
    status.stdout,
    resolved.executionRoot,
    resolved.git.gitRoot,
    maxPaths
  )
  return { paths: snapshot.paths, truncated: snapshot.truncated, unavailable: false }
}

interface PorcelainEntry {
  path: string
  kind: TaskChangePathSnapshot['kind']
  statusCode: string
}

async function snapshotPorcelainPaths(
  stdout: string,
  executionRoot: string,
  gitRoot: string,
  maxPaths: number
): Promise<{ paths: TaskChangePathSnapshot[]; truncated: boolean }> {
  const entries = parsePorcelainV2(stdout)
  const paths: TaskChangePathSnapshot[] = []
  let truncated = false
  let hashedBytes = 0

  for (const entry of entries) {
    const located = await resolveContainedWorkingPath(executionRoot, gitRoot, entry.path)
    if (!located || located.kind === 'escaped') continue
    if (paths.length >= maxPaths) {
      truncated = true
      break
    }
    const snapshot: TaskChangePathSnapshot = {
      path: located.relativePath,
      kind: entry.kind,
      statusCode: entry.statusCode.slice(0, MAX_STATUS_CODE_CHARS)
    }
    if (located.kind === 'inside') {
      const hashed = await hashWorkingTreeFile(
        located.realPath,
        MAX_HASH_FILE_BYTES,
        MAX_HASH_TOTAL_BYTES - hashedBytes
      )
      if (hashed.kind === 'hash') {
        snapshot.contentHash = hashed.contentHash
        hashedBytes += hashed.bytes
      } else if (hashed.kind === 'omitted') {
        snapshot.omitted = hashed.omitted
      }
    }
    paths.push(snapshot)
  }
  return { paths, truncated }
}

async function listBoundedWorkingTreeFiles(
  executionRoot: string,
  maxPaths: number
): Promise<{ paths: TaskChangePathSnapshot[]; truncated: boolean }> {
  const paths: TaskChangePathSnapshot[] = []
  let truncated = false
  let hashedBytes = 0
  let visited = 0
  const queue: Array<{ dir: string; depth: number }> = [{ dir: executionRoot, depth: 0 }]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (
        SKIP_LISTING_DIRECTORY_NAMES.has(entry.name) ||
        entry.name === '.' ||
        entry.name === '..'
      ) {
        continue
      }
      visited += 1
      if (visited > MAX_LISTING_ENTRIES) {
        truncated = true
        break
      }
      const child = join(current.dir, entry.name)
      const located = await resolveContainedWorkingPath(
        executionRoot,
        executionRoot,
        toPosixRelativePath(executionRoot, child) ?? entry.name
      )
      if (!located || located.kind === 'escaped' || located.kind === 'missing') continue
      let stats: { isDirectory(): boolean; isFile(): boolean }
      try {
        stats = await fs.stat(located.realPath)
      } catch {
        continue
      }
      if (stats.isDirectory()) {
        if (current.depth < MAX_LISTING_DEPTH) {
          queue.push({ dir: located.realPath, depth: current.depth + 1 })
        }
        continue
      }
      if (!stats.isFile()) continue
      if (paths.length >= maxPaths) {
        truncated = true
        return { paths, truncated }
      }
      const snapshot: TaskChangePathSnapshot = { path: located.relativePath, kind: 'untracked' }
      const hashed = await hashWorkingTreeFile(
        located.realPath,
        MAX_HASH_FILE_BYTES,
        MAX_HASH_TOTAL_BYTES - hashedBytes
      )
      if (hashed.kind === 'hash') {
        snapshot.contentHash = hashed.contentHash
        hashedBytes += hashed.bytes
      } else if (hashed.kind === 'omitted') {
        snapshot.omitted = hashed.omitted
      }
      paths.push(snapshot)
    }
    if (truncated) break
  }
  return { paths, truncated }
}

/**
 * 先 join 再 realpath，确认目标同时落在 execution root 与 git root 内才允许 stat/hash/open。
 */
async function resolveContainedWorkingPath(
  executionRoot: string,
  gitRoot: string,
  gitRelativePath: string
): Promise<
  | { kind: 'inside'; relativePath: string; realPath: string }
  | { kind: 'escaped'; relativePath: string }
  | { kind: 'missing'; relativePath: string }
  | null
> {
  if (
    !gitRelativePath ||
    gitRelativePath.includes('\0') ||
    isAbsolute(gitRelativePath) ||
    hasParentTraversal(gitRelativePath)
  ) {
    return null
  }
  const joined = resolve(gitRoot, gitRelativePath)
  if (!isPathInsideRoot(executionRoot, joined) || !isPathInsideRoot(gitRoot, joined)) {
    return null
  }
  const relativePath = toPosixRelativePath(executionRoot, joined)
  if (!relativePath) return null
  try {
    const realPath = await fs.realpath(joined)
    if (!isPathInsideRoot(executionRoot, realPath) || !isPathInsideRoot(gitRoot, realPath)) {
      return { kind: 'escaped', relativePath }
    }
    return { kind: 'inside', relativePath, realPath }
  } catch {
    return { kind: 'missing', relativePath }
  }
}

async function hashWorkingTreeFile(
  realPath: string,
  maxFileBytes: number,
  remainingTotalBytes: number
): Promise<
  | { kind: 'hash'; contentHash: string; bytes: number }
  | { kind: 'omitted'; omitted: 'too-large' | 'binary' }
  | { kind: 'skip' }
> {
  let handle: fs.FileHandle | null = null
  try {
    const stats = await fs.stat(realPath)
    if (!stats.isFile()) return { kind: 'skip' }
    if (stats.size > maxFileBytes || stats.size > remainingTotalBytes) {
      return { kind: 'omitted', omitted: 'too-large' }
    }
    handle = await fs.open(realPath, 'r')
    const sampleSize = Math.min(stats.size, BINARY_SAMPLE_BYTES)
    const sample = Buffer.alloc(sampleSize)
    await handle.read(sample, 0, sampleSize, 0)
    if (sample.includes(0)) return { kind: 'omitted', omitted: 'binary' }
    const contents = Buffer.alloc(stats.size)
    if (stats.size > 0) await handle.read(contents, 0, stats.size, 0)
    return {
      kind: 'hash',
      contentHash: createHash('sha256').update(contents).digest('hex'),
      bytes: stats.size
    }
  } catch {
    return { kind: 'skip' }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function parsePorcelainV2(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('? ')) {
      entries.push({ path: line.slice(2), kind: 'untracked', statusCode: '?' })
      continue
    }
    if (line.startsWith('! ')) continue
    const ordinary = line.match(/^1 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/u)
    if (ordinary?.[1] && ordinary[2]) {
      entries.push({ path: ordinary[2], kind: 'tracked', statusCode: ordinary[1] })
      continue
    }
    const renamed = line.match(/^2 (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/u)
    if (renamed?.[1] && renamed[2]) {
      const [dest, source] = renamed[2].split('\t')
      if (dest) entries.push({ path: dest, kind: 'tracked', statusCode: renamed[1] })
      if (source) entries.push({ path: source, kind: 'tracked', statusCode: `${renamed[1]}D` })
      continue
    }
    const unmerged = line.match(/^u (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/u)
    if (unmerged?.[1] && unmerged[2]) {
      entries.push({ path: unmerged[2], kind: 'tracked', statusCode: unmerged[1] })
    }
  }
  return entries
}

function sanitizeRequestedPath(
  requestedPath: string
): { kind: 'ok'; path: string } | { kind: 'escaped'; displayPath: string } {
  if (typeof requestedPath !== 'string' || requestedPath.includes('\0')) {
    return { kind: 'escaped', displayPath: '' }
  }
  const trimmed = requestedPath.trim()
  if (!trimmed || isAbsolute(trimmed) || trimmed.includes('\\')) {
    return { kind: 'escaped', displayPath: '' }
  }
  if (hasParentTraversal(trimmed)) {
    return { kind: 'escaped', displayPath: trimmed }
  }
  return { kind: 'ok', path: trimmed.split(/[\\/]/u).join('/') }
}

async function classifyDiffPath(
  located:
    | { kind: 'inside'; relativePath: string; realPath: string }
    | { kind: 'missing'; relativePath: string },
  resolved: ResolvedProjectRoot,
  gitOptions: ReadOnlyGitOptions
): Promise<{ status: FileDiffStatus; unifiedDiff?: string; truncated?: true }> {
  if (located.kind === 'inside') {
    const hashed = await hashWorkingTreeFile(
      located.realPath,
      MAX_HASH_FILE_BYTES,
      MAX_HASH_FILE_BYTES
    )
    if (hashed.kind === 'omitted' && hashed.omitted === 'binary') return { status: 'binary' }
    if (hashed.kind === 'omitted' && hashed.omitted === 'too-large') return { status: 'too-large' }
  }
  if (resolved.git.kind !== 'git') return { status: 'ok' }
  const gitRelative =
    located.kind === 'inside'
      ? toPosixRelativePath(resolved.git.gitRoot, located.realPath)
      : toPosixRelativePath(
          resolved.git.gitRoot,
          resolve(resolved.executionRoot, located.relativePath)
        )
  if (!gitRelative) return { status: 'escaped' }
  const tracked = await runReadOnlyGit(
    resolved.git.gitRoot,
    ['ls-files', '--error-unmatch', '--', gitRelative],
    { ...gitOptions, allowedRoot: resolved.executionRoot }
  )
  if (!tracked.ok && located.kind === 'inside') return { status: 'untracked' }
  if (located.kind === 'inside') {
    const numstat = await runReadOnlyGit(
      resolved.git.gitRoot,
      [
        '-c',
        'core.quotepath=false',
        'diff',
        '--numstat',
        '--no-color',
        '--no-ext-diff',
        'HEAD',
        '--',
        gitRelative
      ],
      { ...gitOptions, allowedRoot: resolved.executionRoot }
    )
    if (numstat.ok && isBinaryNumstat(numstat.stdout)) return { status: 'binary' }
  }
  return { status: 'ok' }
}

async function readUntrackedDiff(
  taskId: string,
  relativePath: string,
  realPath: string
): Promise<FileDiffResult> {
  const hashed = await hashWorkingTreeFile(realPath, MAX_HASH_FILE_BYTES, MAX_HASH_FILE_BYTES)
  if (hashed.kind === 'omitted' && hashed.omitted === 'binary') {
    return { taskId, path: relativePath, status: 'binary' }
  }
  if (hashed.kind === 'omitted' && hashed.omitted === 'too-large') {
    return { taskId, path: relativePath, status: 'too-large' }
  }
  let contents: Buffer
  try {
    contents = await fs.readFile(realPath)
  } catch {
    return { taskId, path: relativePath, status: 'missing' }
  }
  if (contents.includes(0)) return { taskId, path: relativePath, status: 'binary' }
  const synthesized = synthesizeAddDiff(relativePath, contents.toString('utf8'))
  if (synthesized.truncated) {
    return {
      taskId,
      path: relativePath,
      status: 'untracked',
      truncated: true,
      unifiedDiff: synthesized.diff
    }
  }
  return { taskId, path: relativePath, status: 'untracked', unifiedDiff: synthesized.diff }
}

function synthesizeAddDiff(
  relativePath: string,
  content: string
): { diff: string; truncated: boolean } {
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  const body = lines.map((line) => `+${line}`).join('\n')
  const header = [
    `diff --git a/${relativePath} b/${relativePath}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`
  ].join('\n')
  const diff = `${header}\n${body}\n`
  if (Buffer.byteLength(diff, 'utf8') > MAX_FILE_DIFF_BYTES) {
    return { diff: truncateUtf8(diff, MAX_FILE_DIFF_BYTES), truncated: true }
  }
  return { diff, truncated: false }
}

function redactDiffText(text: string, roots: string[]): string {
  let redacted = text
  const sorted = [...new Set(roots.filter(Boolean))].sort(
    (left, right) => right.length - left.length
  )
  for (const root of sorted) {
    redacted = redacted.split(root).join('.')
    const posix = root.split(/[\\/]/u).join('/')
    if (posix !== root) redacted = redacted.split(posix).join('.')
  }
  return redactSensitiveText(redacted)
}

function isBinaryDiffOutput(text: string): boolean {
  return /Binary files .* differ/u.test(text) || text.includes('\0')
}

function isBinaryNumstat(stdout: string): boolean {
  return /^(?:-\t-\t|-\t-\s)/mu.test(stdout.trim())
}

function isDeletedSnapshot(snapshot: TaskChangePathSnapshot): boolean {
  if (snapshot.contentHash) return false
  const code = snapshot.statusCode ?? ''
  if (!code || code === '?') return false
  return code.includes('D')
}

function pathSnapshotsEquivalent(
  left: TaskChangePathSnapshot | null | undefined,
  right: TaskChangePathSnapshot | null | undefined
): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  if (left.kind !== right.kind) return false
  if ((left.omitted ?? null) !== (right.omitted ?? null)) return false
  if ((left.contentHash ?? null) !== (right.contentHash ?? null)) return false
  if (isDeletedSnapshot(left) !== isDeletedSnapshot(right)) return false
  return true
}

function diffSnapshotPaths(
  before: TaskChangePathSnapshot[],
  after: TaskChangePathSnapshot[]
): string[] {
  const beforeByPath = new Map(before.map((item) => [item.path, item]))
  const afterByPath = new Map(after.map((item) => [item.path, item]))
  const names = new Set([...beforeByPath.keys(), ...afterByPath.keys()])
  const affected: string[] = []
  for (const path of names) {
    if (!pathSnapshotsEquivalent(beforeByPath.get(path), afterByPath.get(path))) affected.push(path)
  }
  return affected.sort((left, right) => left.localeCompare(right))
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let result = ''
  let used = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > maxBytes) break
    result += character
    used += size
  }
  return result
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..')
}

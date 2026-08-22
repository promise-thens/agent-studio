import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { OperationIntent } from '../../shared/agent'
import {
  deriveValidationResult,
  takeLatestCommandEvidencePage,
  type CommandExecutionEvidence,
  type ValidationResult
} from '../../shared/command'
import type { ProjectAvailability } from '../../shared/task-history'
import {
  isSafeRelativePosixPath,
  type FileDiffResult,
  type FileDiffStatus,
  type LatestTurnRestorePreview,
  type LatestTurnRestoreResult,
  type ResolvedProjectRoot,
  type RestorePlanItem,
  type RestoreRefusalReason,
  type TaskChangeAttribution,
  type TaskChangeBaseline,
  type TaskChangePath,
  type TaskChangePathSnapshot,
  type TaskChangeRevertible,
  type TaskChangeSet,
  type TaskChangeSetQueryResult,
  type TurnChangeCheckpoint
} from '../../shared/git-review'
import { redactSensitiveText } from '../security/sensitive-redaction'
import type { PermissionAuthorizationResult, PermissionBroker } from '../security/permission-broker'
import {
  DEFAULT_GIT_TIMEOUT_MS,
  isPathInsideRoot,
  resolveProjectRoot,
  runReadOnlyGit,
  runReadOnlyGitBytes,
  toPosixRelativePath,
  type ReadOnlyGitOptions
} from '../project/project-root-resolver'
import { evaluateBaselineValidity, type TaskChangeBaselineStore } from './task-change-baseline'
import type { TurnChangeCheckpointStore } from './turn-change-checkpoint'

export const MAX_CHANGE_SET_PATHS = 500
export const MAX_FILE_DIFF_BYTES = 64 * 1024
export const REVERT_UNAVAILABLE_REASON = '当前版本仅提供只读审阅，不支持一键撤销。'
const RECOVERY_TURN_PREFIX = 'recovery_'
/** 与 PermissionPolicy MAX_TARGETS 对齐，超出则整次拒绝，禁止拆成部分应用。 */
const MAX_RESTORE_INTENT_TARGETS = 32

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
  /** 由 TaskExecutor 注入，禁止 Renderer 自报是否空闲。 */
  hasActiveExecution?: () => boolean
  /** 只调用 authorizeOperation；不得改 Broker 内部，也不得走 git reset。 */
  broker?: Pick<PermissionBroker, 'authorizeOperation'>
  createRecoveryId?: () => string
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
    const evaluation = await this.evaluateRestoreFromComputed(identity, computed)
    computed.changeSet.revertible = toPublicRevertible(evaluation)
    const validations = await this.collectValidations(taskId)
    return toQueryResult(computed.changeSet, validations)
  }

  async getFileDiff(taskId: string, requestedPath: string): Promise<FileDiffResult> {
    const identity = this.deps.getTaskIdentity(taskId)
    return await this.buildFileDiff(identity, requestedPath)
  }

  async listTurnCheckpoints(taskId: string): Promise<TurnChangeCheckpoint[]> {
    this.deps.getTaskIdentity(taskId)
    return (await this.deps.checkpointStore.list(taskId)).items
  }

  /** 只读预览。主进程重新计算 predicate，不信任 UI 缓存的 revertible。 */
  async previewLatestTurnRestore(taskId: string): Promise<LatestTurnRestorePreview> {
    const identity = this.deps.getTaskIdentity(taskId)
    const computed = await this.computeAttributedChangeSet(identity)
    const evaluation = await this.evaluateRestoreFromComputed(identity, computed)
    if (evaluation.kind !== 'latest-turn') {
      return {
        taskId: identity.taskId,
        revertible: { kind: 'none', reason: evaluation.reason },
        willLosePaths: []
      }
    }
    return {
      taskId: identity.taskId,
      revertible: toPublicRevertible(evaluation),
      willLosePaths: [...evaluation.paths]
    }
  }

  /**
   * 恢复前再次计算 predicate，经 Broker 写/删。
   * 检查点只存哈希不是 git blob，因此禁止 git reset/checkout/clean/stash。
   */
  async restoreLatestTurn(taskId: string): Promise<LatestTurnRestoreResult> {
    const identity = this.deps.getTaskIdentity(taskId)
    const computed = await this.computeAttributedChangeSet(identity)
    const evaluation = await this.evaluateRestoreFromComputed(identity, computed)
    if (evaluation.kind !== 'latest-turn') {
      return {
        taskId: identity.taskId,
        ok: false,
        reason: evaluation.refusal,
        message: evaluation.reason
      }
    }
    return await this.executeRestore(identity, computed, evaluation)
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

  private async computeAttributedChangeSet(
    identity: GitReviewTaskIdentity
  ): Promise<ComputedChangeSet> {
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
    const listed = await this.deps.checkpointStore.list(identity.taskId)
    const checkpoints = listed.items
    const lastComplete = findLastCompleteCheckpoint(checkpoints)
    const lastCompleteAfter = lastComplete?.afterPaths
    const attributed = attributeWorkingTreePaths({
      current: snapshot.paths,
      baseline,
      lastCompleteAfter,
      baselineUsable,
      currentUsable: !snapshot.unavailable,
      maxPaths: MAX_CHANGE_SET_PATHS
    })
    const truncated =
      snapshot.truncated || attributed.truncated || snapshot.unavailable || listed.truncated
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
    return {
      changeSet,
      resolved,
      current: snapshot.paths,
      baseline,
      baselineUsable,
      lastCompleteAfter,
      checkpoints,
      truncated,
      unavailable: snapshot.unavailable,
      checkpointsTruncated: listed.truncated
    }
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
    const previous = (await this.deps.checkpointStore.list(input.taskId)).items.at(-1)
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
    // git status 失败不得把空 after 写成 complete/no-change，否则会当成文件全消失。
    if (snapshot.unavailable) {
      const incomplete: TurnChangeCheckpoint = {
        schemaVersion: 1,
        taskId: input.taskId,
        turnId: input.turnId,
        environmentId: input.environmentId,
        capturedBeforeAt: existing?.capturedBeforeAt ?? this.now(),
        status: 'incomplete',
        beforePaths: existing?.beforePaths ?? [],
        affectedPaths: existing?.affectedPaths ?? []
      }
      if (existing?.previousCheckpointId) {
        incomplete.previousCheckpointId = existing.previousCheckpointId
      }
      const drift = await this.detectDrift(input, resolved)
      if (drift) incomplete.drift = drift
      else if (existing?.drift) incomplete.drift = existing.drift
      await this.deps.checkpointStore.put(incomplete)
      return
    }
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

  private async evaluateRestoreFromComputed(
    identity: GitReviewTaskIdentity,
    computed: ComputedChangeSet
  ): Promise<RestoreEvaluation> {
    if (this.deps.hasActiveExecution?.() === true) {
      return refuseRestore('active-turn', '当前有活动 Turn，不能自动撤销。')
    }
    if (computed.checkpointsTruncated) {
      return refuseRestore('incomplete', '检查点列表被截断，不能确定最新一轮，不能自动撤销。')
    }
    if (computed.unavailable || computed.truncated || computed.changeSet.truncated) {
      return refuseRestore('incomplete', '变更列表不完整，不能自动撤销。')
    }
    if (!computed.baselineUsable && computed.changeSet.baselineStatus !== 'captured') {
      return refuseRestore('none', '基线未捕获或已失效，不能自动撤销。')
    }
    if (!computed.baseline || computed.baseline.status !== 'captured' || !computed.baselineUsable) {
      return refuseRestore('none', '基线未捕获或已失效，不能自动撤销。')
    }
    if (computed.resolved.environmentId !== identity.environmentId) {
      return refuseRestore('drift', '执行环境已漂移，不能自动撤销。')
    }
    if (computed.resolved.executionRoot !== identity.executionRoot) {
      return refuseRestore('drift', '执行根目录已漂移，不能自动撤销。')
    }

    const latest = computed.checkpoints.at(-1)
    if (!latest) return refuseRestore('none', '没有已完成的写入型最新一轮。')
    if (latest.turnId.startsWith(RECOVERY_TURN_PREFIX)) {
      return refuseRestore('none', '最新一轮已撤销，历史检查点仍保留。')
    }
    if (latest.status === 'incomplete') {
      return refuseRestore('incomplete', '最新检查点不完整，不能自动撤销。')
    }
    if (latest.status !== 'complete' || !latest.afterPaths || latest.affectedPaths.length === 0) {
      return refuseRestore('none', '没有已完成的写入型最新一轮。')
    }
    if (latest.environmentId !== identity.environmentId || latest.drift) {
      return refuseRestore('drift', '检查点环境已漂移，不能自动撤销。')
    }
    if (
      latest.beforePaths.length >= MAX_CHANGE_SET_PATHS ||
      latest.afterPaths.length >= MAX_CHANGE_SET_PATHS
    ) {
      return refuseRestore('incomplete', '检查点路径列表可能被截断，不能自动撤销。')
    }

    const currentByPath = new Map(computed.current.map((item) => [item.path, item]))
    const afterByPath = new Map(latest.afterPaths.map((item) => [item.path, item]))
    const beforeByPath = new Map(latest.beforePaths.map((item) => [item.path, item]))
    const attributionByPath = new Map(
      computed.changeSet.paths.map((item) => [item.path, item.attribution])
    )

    for (const path of latest.affectedPaths) {
      if (!isSafeRestorePath(path)) {
        return refuseRestore('not-recoverable', '恢复路径越界，已拒绝写入。')
      }
      const after = afterByPath.get(path)
      const current = currentByPath.get(path)
      if (!currentMatchesAfter(after, current)) {
        return refuseRestore('drift', '当前工作区与该轮结束时的哈希不一致，不能自动覆盖。')
      }
      const attribution = attributionByPath.get(path)
      if (
        attribution === 'pre-existing' ||
        attribution === 'overlap-unknown' ||
        attribution === 'user-changed-after-task'
      ) {
        return refuseRestore('drift', '这些路径存在任务开始前改动、重叠或事后编辑，不能自动覆盖。')
      }
      // 重命名只记下 dest，无法从 HEAD 证明 source before，整次拒绝以免只删 dest。
      if (
        isRenameOrCopyStatus(after?.statusCode) ||
        isRenameOrCopyStatus(beforeByPath.get(path)?.statusCode)
      ) {
        return refuseRestore(
          'not-recoverable',
          '重命名无法从 Git HEAD 完整恢复源路径，不能自动撤销。'
        )
      }
    }

    const restorePlan: RestorePlanItem[] = []
    const blobs = new Map<string, Buffer>()
    const gitOptions = this.gitOptions()
    for (const path of latest.affectedPaths) {
      const planned = await this.planPathRestore({
        path,
        before: beforeByPath.get(path),
        after: afterByPath.get(path),
        resolved: computed.resolved,
        gitOptions,
        baseCommit: computed.baseline.baseCommit ?? computed.changeSet.baseCommit
      })
      if ('refuse' in planned) return refuseRestore(planned.refuse, planned.reason)
      restorePlan.push({ path: planned.path, action: planned.action, from: planned.from })
      if (planned.bytes) blobs.set(path, planned.bytes)
    }
    if (restorePlan.length === 0) {
      return refuseRestore('none', '没有已完成的写入型最新一轮。')
    }
    const writes = restorePlan.filter((item) => item.action === 'write')
    const deletes = restorePlan.filter((item) => item.action === 'delete')
    if (writes.length > MAX_RESTORE_INTENT_TARGETS || deletes.length > MAX_RESTORE_INTENT_TARGETS) {
      return refuseRestore('not-recoverable', '恢复路径过多，不能自动撤销。')
    }
    return {
      kind: 'latest-turn',
      turnId: latest.turnId,
      paths: [...latest.affectedPaths],
      restorePlan,
      blobs,
      checkpoint: latest
    }
  }

  private async planPathRestore(input: {
    path: string
    before?: TaskChangePathSnapshot
    after?: TaskChangePathSnapshot
    resolved: ResolvedProjectRoot
    gitOptions: ReadOnlyGitOptions
    baseCommit?: string
  }): Promise<PlannedRestorePath | RestoreRefuse> {
    const omitted = input.after?.omitted ?? input.before?.omitted
    if (omitted === 'binary' || omitted === 'too-large' || omitted === 'limit') {
      return {
        refuse: 'not-recoverable',
        reason: '二进制、超大或截断文件无法从 Git 对象恢复。'
      }
    }
    const beforePresent = isPresentSnapshot(input.before)
    const afterPresent = isPresentSnapshot(input.after)
    const head = await readHeadBlob(input.resolved, input.path, input.gitOptions, input.baseCommit)
    if (head.kind === 'present') {
      if (beforePresent && input.before?.contentHash && head.hash !== input.before.contentHash) {
        return {
          refuse: 'not-recoverable',
          reason: '无法从 Git HEAD 证明恢复前状态（检查点只存哈希，禁止 git reset/checkout）。'
        }
      }
      if (beforePresent && (input.before?.kind === 'untracked' || !input.before?.contentHash)) {
        return {
          refuse: 'not-recoverable',
          reason: '未跟踪或缺少哈希的事前文件无法从 Git 对象恢复。'
        }
      }
      return { path: input.path, action: 'write', from: 'head', bytes: head.bytes }
    }
    if (head.kind !== 'missing') {
      return {
        refuse: 'not-recoverable',
        reason: 'Git 无法读取 HEAD blob，不能把失败当成文件本不存在。'
      }
    }
    if (!beforePresent && afterPresent && canDeleteAsTaskAdded(input.after)) {
      return { path: input.path, action: 'delete', from: 'absent' }
    }
    if (!beforePresent && !afterPresent) {
      return { refuse: 'not-recoverable', reason: '无法证明恢复前状态，禁止 git reset。' }
    }
    return {
      refuse: 'not-recoverable',
      reason: '无法从 Git HEAD 证明恢复前状态（检查点只存哈希，禁止 git reset/checkout）。'
    }
  }

  private async executeRestore(
    identity: GitReviewTaskIdentity,
    computed: ComputedChangeSet,
    evaluation: Extract<RestoreEvaluation, { kind: 'latest-turn' }>
  ): Promise<LatestTurnRestoreResult> {
    const broker = this.deps.broker
    if (!broker) {
      return {
        taskId: identity.taskId,
        ok: false,
        reason: 'not-recoverable',
        message: '权限服务尚未就绪，未改写任何文件。'
      }
    }

    const writes = evaluation.restorePlan.filter((item) => item.action === 'write')
    const deletes = evaluation.restorePlan.filter((item) => item.action === 'delete')
    const applied: string[] = []
    const isActive = (): boolean => this.deps.hasActiveExecution?.() !== true
    let mutated = false

    if (writes.length > 0) {
      const writeAuth = await broker.authorizeOperation(
        this.createRestoreIntent(identity, evaluation.turnId, 'write-file', writes),
        async () => {
          if (!mutated) {
            const fresh = await this.recheckRestore(identity, evaluation)
            if (fresh.kind !== 'ok') return fresh
          }
          try {
            for (const step of writes) {
              const bytes = evaluation.blobs.get(step.path)
              if (!bytes) {
                return {
                  kind: 'refuse' as const,
                  reason: 'not-recoverable' as const,
                  message: '缺少可写回的 Git blob，未继续删除。'
                }
              }
              await writeContainedFile(
                computed.resolved.executionRoot,
                gitRootOf(computed.resolved),
                step.path,
                bytes
              )
              applied.push(step.path)
              mutated = true
            }
            return { kind: 'ok' as const }
          } catch {
            return {
              kind: 'refuse' as const,
              reason: 'not-recoverable' as const,
              message: '写入目标越界或不可用，已停止。'
            }
          }
        },
        { isActive }
      )
      const writeFailure = restoreAuthorizationFailure(identity.taskId, writeAuth, applied, '写入')
      if (writeFailure) return writeFailure
    }

    if (deletes.length > 0) {
      const deleteAuth = await broker.authorizeOperation(
        this.createRestoreIntent(identity, evaluation.turnId, 'delete-path', deletes),
        async () => {
          // 写回已经改变 after 哈希；删除阶段不得用 reset 回滚已写文件，但要再核对待删路径。
          if (!mutated) {
            const fresh = await this.recheckRestore(identity, evaluation)
            if (fresh.kind !== 'ok') return fresh
          } else if (this.deps.hasActiveExecution?.() === true) {
            return {
              kind: 'refuse' as const,
              reason: 'active-turn' as const,
              message: '当前有活动 Turn，已停止删除。'
            }
          } else {
            const stillMatch = await deleteTargetsStillMatchAfter(
              computed.resolved,
              evaluation,
              deletes
            )
            if (!stillMatch) {
              return {
                kind: 'refuse' as const,
                reason: 'drift' as const,
                message: '待删除路径在写回后已漂移，已停止删除。'
              }
            }
          }
          try {
            for (const step of deletes) {
              await deleteContainedFile(
                computed.resolved.executionRoot,
                gitRootOf(computed.resolved),
                step.path
              )
              applied.push(step.path)
              mutated = true
            }
            return { kind: 'ok' as const }
          } catch {
            return {
              kind: 'refuse' as const,
              reason: 'not-recoverable' as const,
              message: '删除目标越界或不可用，已停止。'
            }
          }
        },
        { isActive }
      )
      const deleteFailure = restoreAuthorizationFailure(
        identity.taskId,
        deleteAuth,
        applied,
        '删除'
      )
      if (deleteFailure) return deleteFailure
    }

    const recoveryId = this.allocateRecoveryId()
    const afterSnapshot = await snapshotWorkingTree(
      computed.resolved,
      this.gitOptions(),
      MAX_CHANGE_SET_PATHS
    )
    const lastTime =
      computed.checkpoints.at(-1)?.capturedAfterAt ??
      computed.checkpoints.at(-1)?.capturedBeforeAt ??
      this.now()
    const capturedAt = laterTimestamp(lastTime)
    const recoveryBase = {
      schemaVersion: 1 as const,
      taskId: identity.taskId,
      turnId: recoveryId,
      environmentId: identity.environmentId,
      previousCheckpointId: evaluation.turnId,
      capturedBeforeAt: capturedAt,
      beforePaths: evaluation.checkpoint.afterPaths ?? [],
      affectedPaths: [...evaluation.paths]
    }
    // git status 失败不得把空 after 写成 complete，否则归因会把文件当成全消失。
    const recovery: TurnChangeCheckpoint =
      afterSnapshot.unavailable || afterSnapshot.truncated
        ? { ...recoveryBase, status: 'incomplete' }
        : {
            ...recoveryBase,
            capturedAfterAt: capturedAt,
            status: 'complete',
            afterPaths: afterSnapshot.paths
          }
    await this.deps.checkpointStore.put(recovery)
    return {
      taskId: identity.taskId,
      ok: true,
      message: '已撤销最新一轮写入，历史检查点仍保留。',
      recoveryCheckpointId: recoveryId,
      restoredPaths: [...applied],
      appliedPaths: [...applied]
    }
  }

  private async recheckRestore(
    identity: GitReviewTaskIdentity,
    expected: Extract<RestoreEvaluation, { kind: 'latest-turn' }>
  ): Promise<{ kind: 'ok' } | { kind: 'refuse'; reason: RestoreRefusalReason; message: string }> {
    if (this.deps.hasActiveExecution?.() === true) {
      return { kind: 'refuse', reason: 'active-turn', message: '当前有活动 Turn，不能自动撤销。' }
    }
    const computed = await this.computeAttributedChangeSet(identity)
    const evaluation = await this.evaluateRestoreFromComputed(identity, computed)
    if (evaluation.kind !== 'latest-turn' || evaluation.turnId !== expected.turnId) {
      return {
        kind: 'refuse',
        reason: evaluation.kind === 'none' ? evaluation.refusal : 'drift',
        message: evaluation.kind === 'none' ? evaluation.reason : '恢复条件已变化，未继续改写文件。'
      }
    }
    return { kind: 'ok' }
  }

  private createRestoreIntent(
    identity: GitReviewTaskIdentity,
    turnId: string,
    operationType: 'write-file' | 'delete-path',
    steps: RestorePlanItem[]
  ): OperationIntent {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          kind: 'latest-turn-restore',
          taskId: identity.taskId,
          turnId,
          operationType,
          paths: steps.map((item) => item.path).sort()
        })
      )
      .digest('hex')
    const count = steps.length
    if (operationType === 'write-file') {
      return {
        initiator: { kind: 'app', service: 'git' },
        taskId: identity.taskId,
        turnId,
        projectId: identity.projectId,
        environmentId: identity.environmentId,
        executionRoot: identity.executionRoot,
        operationType,
        targets: steps.map((item) => ({ kind: 'path', value: item.path })),
        parameterFingerprint: fingerprint,
        title: '写回最新一轮撤销目标',
        impact: `将把 ${count} 个文件恢复为 Git HEAD 中的内容。检查点只存哈希，不会执行 git reset、checkout、clean 或 stash。`
      }
    }
    return {
      initiator: { kind: 'app', service: 'git' },
      taskId: identity.taskId,
      turnId,
      projectId: identity.projectId,
      environmentId: identity.environmentId,
      executionRoot: identity.executionRoot,
      operationType,
      targets: steps.map((item) => ({ kind: 'path', value: item.path })),
      parameterFingerprint: fingerprint,
      title: '删除本轮新增文件',
      impact: `将删除 ${count} 个本轮新增路径。不会执行 git clean 或 reset。`
    }
  }

  private allocateRecoveryId(): string {
    const created = this.deps.createRecoveryId?.() ?? `${RECOVERY_TURN_PREFIX}${randomUUID()}`
    return created.startsWith(RECOVERY_TURN_PREFIX) ? created : `${RECOVERY_TURN_PREFIX}${created}`
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
  /** 当前工作树快照失败时不得把空列表当成文件全消失。 */
  currentUsable?: boolean
  maxPaths?: number
}): { paths: TaskChangePath[]; truncated: boolean } {
  if (input.currentUsable === false) {
    return { paths: [], truncated: true }
  }
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
      // 只收 dest，与 Task 1 一致。rename 源未在基线出现时不得假装 task-deleted。
      const [dest] = renamed[2].split('\t')
      if (dest) entries.push({ path: dest, kind: 'tracked', statusCode: renamed[1] })
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

interface ComputedChangeSet {
  changeSet: TaskChangeSet
  resolved: ResolvedProjectRoot
  current: TaskChangePathSnapshot[]
  baseline: TaskChangeBaseline | null
  baselineUsable: boolean
  lastCompleteAfter?: TaskChangePathSnapshot[]
  checkpoints: TurnChangeCheckpoint[]
  truncated: boolean
  unavailable: boolean
  checkpointsTruncated: boolean
}

type RestoreRefuse = { refuse: RestoreRefusalReason; reason: string }

type PlannedRestorePath = RestorePlanItem & { bytes?: Buffer }

type RestoreEvaluation =
  | { kind: 'none'; reason: string; refusal: RestoreRefusalReason }
  | {
      kind: 'latest-turn'
      turnId: string
      paths: string[]
      restorePlan: RestorePlanItem[]
      blobs: Map<string, Buffer>
      checkpoint: TurnChangeCheckpoint
    }

type RestoreExecuteResult =
  { kind: 'ok' } | { kind: 'refuse'; reason: RestoreRefusalReason; message: string }

function refuseRestore(refusal: RestoreRefusalReason, reason: string): RestoreEvaluation {
  return { kind: 'none', refusal, reason }
}

function toPublicRevertible(evaluation: RestoreEvaluation): TaskChangeRevertible {
  if (evaluation.kind !== 'latest-turn') {
    return { kind: 'none', reason: evaluation.reason }
  }
  return {
    kind: 'latest-turn',
    turnId: evaluation.turnId,
    paths: evaluation.paths,
    restorePlan: evaluation.restorePlan
  }
}

function findLastCompleteCheckpoint(list: TurnChangeCheckpoint[]): TurnChangeCheckpoint | null {
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index]
    if (item && item.status === 'complete' && item.afterPaths) return item
  }
  return null
}

function isPresentSnapshot(snapshot?: TaskChangePathSnapshot): snapshot is TaskChangePathSnapshot {
  return Boolean(snapshot && !isDeletedSnapshot(snapshot))
}

function currentMatchesAfter(
  after: TaskChangePathSnapshot | undefined,
  current: TaskChangePathSnapshot | undefined
): boolean {
  const afterPresent = isPresentSnapshot(after)
  const currentPresent = isPresentSnapshot(current)
  if (!afterPresent && !currentPresent) return true
  return pathSnapshotsEquivalent(after, current)
}

function isSafeRestorePath(value: string): boolean {
  return isSafeRelativePosixPath(value)
}

function gitRootOf(resolved: ResolvedProjectRoot): string {
  return resolved.git.kind === 'git' ? resolved.git.gitRoot : resolved.executionRoot
}

function laterTimestamp(iso: string): string {
  const milliseconds = Date.parse(iso)
  if (!Number.isFinite(milliseconds)) return iso
  return new Date(milliseconds + 1).toISOString()
}

function restoreAuthorizationFailure(
  taskId: string,
  auth: PermissionAuthorizationResult<RestoreExecuteResult>,
  applied: string[],
  phase: string
): LatestTurnRestoreResult | null {
  if (auth.ok) {
    if (auth.value.kind === 'refuse') {
      return {
        taskId,
        ok: false,
        reason: auth.value.reason,
        message: auth.value.message,
        ...(applied.length ? { appliedPaths: [...applied] } : {})
      }
    }
    return null
  }
  const reason: RestoreRefusalReason =
    auth.reason === 'invalid-target' ? 'not-recoverable' : 'denied'
  const message =
    auth.reason === 'user-denied'
      ? `用户拒绝了${phase}授权，未继续改写其余文件。`
      : auth.reason === 'invalid-target'
        ? `${phase}目标越界，未继续改写。`
        : `${phase}授权未通过，未继续改写其余文件。`
  return {
    taskId,
    ok: false,
    reason,
    message,
    ...(applied.length ? { appliedPaths: [...applied] } : {})
  }
}

type HeadBlobResult =
  | { kind: 'present'; bytes: Buffer; hash: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'unsafe' }
  | { kind: 'too-large' }

async function readHeadBlob(
  resolved: ResolvedProjectRoot,
  relativePath: string,
  gitOptions: ReadOnlyGitOptions,
  baseCommit?: string
): Promise<HeadBlobResult> {
  if (resolved.git.kind === 'invalid') return { kind: 'unavailable' }
  // 非 Git 没有 blob；仅当路径是本轮新增时才允许删除。
  if (resolved.git.kind !== 'git') return { kind: 'missing' }
  if (!isSafeRestorePath(relativePath) || relativePath.includes(':')) return { kind: 'unsafe' }
  const gitRelative = toPosixRelativePath(
    resolved.git.gitRoot,
    join(resolved.executionRoot, ...relativePath.split('/'))
  )
  if (!gitRelative || gitRelative.includes(':') || !isSafeRestorePath(gitRelative)) {
    return { kind: 'unsafe' }
  }
  const rev = baseCommit && /^[0-9a-f]{7,64}$/i.test(baseCommit) ? baseCommit : 'HEAD'
  const shown = await runReadOnlyGitBytes(
    resolved.git.gitRoot,
    ['-c', 'core.quotepath=false', 'show', `${rev}:${gitRelative}`],
    { ...gitOptions, allowedRoot: resolved.executionRoot }
  )
  if (shown.ok) {
    if (shown.stdout.length > MAX_HASH_FILE_BYTES) return { kind: 'too-large' }
    return {
      kind: 'present',
      bytes: shown.stdout,
      hash: createHash('sha256').update(shown.stdout).digest('hex')
    }
  }
  // 超时、git 不可用或路径映射失败不得当成「本不存在」。
  if (shown.unavailable) return { kind: 'unavailable' }
  if (isMissingHeadBlobError(shown.exitCode, shown.stderr)) return { kind: 'missing' }
  return { kind: 'unavailable' }
}

/** 只有明确的 missing blob（exit 128 且文案指向该 rev 中无此路径）才允许按新增删除。 */
function isMissingHeadBlobError(exitCode: number | undefined, stderr: string): boolean {
  if (exitCode !== 128) return false
  if (/not a valid object name/i.test(stderr) && !/does not exist in/i.test(stderr)) return false
  return (
    /does not exist in ['"][^'"]+['"]/i.test(stderr) ||
    /exists on disk, but not in ['"][^'"]+['"]/i.test(stderr)
  )
}

function isRenameOrCopyStatus(statusCode?: string): boolean {
  if (!statusCode) return false
  const xy = statusCode.slice(0, 2)
  return /[RC]/i.test(xy)
}

function isAddedStatus(statusCode?: string): boolean {
  if (!statusCode || isRenameOrCopyStatus(statusCode)) return false
  return statusCode.slice(0, 2).includes('A')
}

function canDeleteAsTaskAdded(after?: TaskChangePathSnapshot): boolean {
  if (!isPresentSnapshot(after) || isRenameOrCopyStatus(after.statusCode)) return false
  if (after.kind === 'untracked') return true
  return isAddedStatus(after.statusCode)
}

/**
 * 只对 realpath 后仍落在 execution root 与 git root 内的路径写文件。
 * 已存在的外部符号链接直接拒绝，避免 writeFile 跟随写到仓库外。
 */
async function writeContainedFile(
  executionRoot: string,
  gitRoot: string,
  relativePath: string,
  bytes: Buffer
): Promise<void> {
  const joined = resolveContainedJoin(executionRoot, gitRoot, relativePath)
  try {
    const existing = await fs.realpath(joined)
    if (!isPathInsideRoot(executionRoot, existing) || !isPathInsideRoot(gitRoot, existing)) {
      throw new Error('escaped')
    }
    await fs.writeFile(existing, bytes)
    return
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
  await ensureContainedParentDir(executionRoot, gitRoot, dirname(joined))
  await fs.writeFile(joined, bytes)
  const written = await fs.realpath(joined)
  if (!isPathInsideRoot(executionRoot, written) || !isPathInsideRoot(gitRoot, written)) {
    // 只删除刚创建的目录项，绝不 unlink realpath 指向的外部目标。
    await fs.unlink(joined).catch(() => undefined)
    throw new Error('escaped')
  }
}

/** lstat 父目录；若是指向 root 外的符号链接则拒绝，避免 mkdir/write 跟出去。 */
async function ensureContainedParentDir(
  executionRoot: string,
  gitRoot: string,
  parent: string
): Promise<void> {
  if (!isPathInsideRoot(executionRoot, parent) || !isPathInsideRoot(gitRoot, parent)) {
    throw new Error('escaped')
  }
  try {
    const listed = await fs.lstat(parent)
    if (listed.isSymbolicLink()) {
      const real = await fs.realpath(parent)
      if (!isPathInsideRoot(executionRoot, real) || !isPathInsideRoot(gitRoot, real)) {
        throw new Error('escaped')
      }
      return
    }
    if (!listed.isDirectory()) throw new Error('escaped')
    const real = await fs.realpath(parent)
    if (!isPathInsideRoot(executionRoot, real) || !isPathInsideRoot(gitRoot, real)) {
      throw new Error('escaped')
    }
    return
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
  const relative = toPosixRelativePath(executionRoot, parent)
  if (relative === null) throw new Error('escaped')
  const segments = relative ? relative.split('/') : []
  let current = executionRoot
  for (const segment of segments) {
    current = join(current, segment)
    if (!isPathInsideRoot(executionRoot, current) || !isPathInsideRoot(gitRoot, current)) {
      throw new Error('escaped')
    }
    try {
      const listed = await fs.lstat(current)
      if (listed.isSymbolicLink()) {
        const real = await fs.realpath(current)
        if (!isPathInsideRoot(executionRoot, real) || !isPathInsideRoot(gitRoot, real)) {
          throw new Error('escaped')
        }
        current = real
        continue
      }
      if (!listed.isDirectory()) throw new Error('escaped')
    } catch (error) {
      if (!isNotFoundError(error)) throw error
      await fs.mkdir(current)
    }
  }
}

async function deleteTargetsStillMatchAfter(
  resolved: ResolvedProjectRoot,
  evaluation: Extract<RestoreEvaluation, { kind: 'latest-turn' }>,
  deletes: RestorePlanItem[]
): Promise<boolean> {
  const afterByPath = new Map(
    (evaluation.checkpoint.afterPaths ?? []).map((item) => [item.path, item])
  )
  const gitRoot = gitRootOf(resolved)
  for (const step of deletes) {
    const after = afterByPath.get(step.path)
    if (!after?.contentHash) return false
    const located = await resolveContainedWorkingPath(resolved.executionRoot, gitRoot, step.path)
    if (!located || located.kind !== 'inside') return false
    const hashed = await hashWorkingTreeFile(
      located.realPath,
      MAX_HASH_FILE_BYTES,
      MAX_HASH_FILE_BYTES
    )
    if (hashed.kind !== 'hash' || hashed.contentHash !== after.contentHash) return false
  }
  return true
}

/** unlink 目录项本身，不跟随符号链接去删外部目标。 */
async function deleteContainedFile(
  executionRoot: string,
  gitRoot: string,
  relativePath: string
): Promise<void> {
  const joined = resolveContainedJoin(executionRoot, gitRoot, relativePath)
  try {
    const existing = await fs.realpath(joined)
    if (!isPathInsideRoot(executionRoot, existing) || !isPathInsideRoot(gitRoot, existing)) {
      throw new Error('escaped')
    }
  } catch (error) {
    if (isNotFoundError(error)) return
    throw error
  }
  await fs.unlink(joined)
}

function resolveContainedJoin(
  executionRoot: string,
  gitRoot: string,
  relativePath: string
): string {
  if (!isSafeRestorePath(relativePath)) throw new Error('escaped')
  const joined = resolve(executionRoot, ...relativePath.split('/'))
  if (!isPathInsideRoot(executionRoot, joined) || !isPathInsideRoot(gitRoot, joined)) {
    throw new Error('escaped')
  }
  return joined
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

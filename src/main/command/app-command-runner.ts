import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentPermissionResolutionReason, OperationIntent } from '../../shared/agent'
import {
  MAX_COMMAND_FIELD_UTF8_BYTES,
  type CommandExecutionEvidence,
  type CommandExecutionStatus
} from '../../shared/command'
import { redactSensitiveText } from '../security/sensitive-redaction'
import type { PermissionBroker } from '../security/permission-broker'
import {
  MAX_COMMAND_TRANSCRIPT_BYTES,
  MAX_COMMAND_TRANSCRIPT_CHUNKS,
  type CommandEvidenceStore,
  type CommandTranscriptChunk
} from './command-evidence-store'
import { buildCommandEnvironment, collectCommandEnvironmentSecrets } from './command-environment'

/** 单条命令默认超时，覆盖常见 lint/test/build；更长的跑批必须由可信 spec 显式声明。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 60_000

/** 硬上限，避免误传巨大 timeout 把 runner 挂死。 */
export const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000

const MAX_EXECUTABLE_BYTES = 16 * 1024
const MAX_ARG_BYTES = 64 * 1024
const PROCESS_TEARDOWN_GRACE_MS = 1_000
const textEncoder = new TextEncoder()

export type CommandEnvPolicy = 'minimal'

/**
 * 主进程可信服务生成的受限命令。没有 Shell 字符串字段；
 * 确需 Shell 语义时由调用方显式给出固定 executable（如 /bin/sh）和 args 数组。
 */
export interface CommandSpec {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  envPolicy: CommandEnvPolicy
  actionSource: string
  actionId: string
}

/** 身份只来自权威 Task 上下文，禁止 Runner 自报 execution root。 */
export interface CommandExecutionIdentity {
  taskId: string
  turnId: string
  projectId: string
  environmentId: string
  executionRoot: string
}

export interface AppCommandRunnerOptions {
  store: CommandEvidenceStore
  broker: PermissionBroker
  sourceEnvironment?: NodeJS.ProcessEnv
  now?: () => number
  createId?: () => string
}

export type AppCommandRunResult =
  | { ok: true; evidence: CommandExecutionEvidence }
  | {
      ok: false
      reason: Extract<
        AgentPermissionResolutionReason,
        | 'user-denied'
        | 'cancelled'
        | 'expired'
        | 'invalid-target'
        | 'unsupported'
        | 'internal-error'
      >
    }

export class CommandSpecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandSpecError'
  }
}

interface CommandCapture {
  startedAt: string
  endedAt: string
  status: CommandExecutionStatus
  timedOut: boolean
  exitCode?: number
  signal?: string
  chunks: CommandTranscriptChunk[]
  totalBytes: number
  truncated: boolean
}

type StopReason = 'timeout' | 'abort'

interface ChildOutcome {
  spawnError: Error | null
  exitCode: number | null
  signal?: string
  stopReason: StopReason | null
}

/**
 * App 自有非交互命令执行器。spawn 只发生在 Permission Broker 允许的回调内。
 */
export class AppCommandRunner {
  private readonly store: CommandEvidenceStore
  private readonly broker: PermissionBroker
  private readonly sourceEnvironment?: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly createId: () => string

  constructor(options: AppCommandRunnerOptions) {
    this.store = options.store
    this.broker = options.broker
    this.sourceEnvironment = options.sourceEnvironment
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
  }

  /**
   * 校验受限 spec、在 execution root 内解析 cwd，再请求 Broker。
   * 拒绝/取消授权时不 spawn；副作用（spawn）只在获批回调里发生。
   */
  async run(input: {
    spec: CommandSpec
    identity: CommandExecutionIdentity
    signal?: AbortSignal
  }): Promise<AppCommandRunResult> {
    const spec = parseCommandSpec(input.spec)
    if (!spec) throw new CommandSpecError('命令规格无效。')
    const cwdAbsolute = await resolveCommandCwd(input.identity.executionRoot, spec.cwd)
    const commandId = this.requireIdentity(this.createId())
    const transcriptId = this.requireIdentity(this.createId())
    const displayCommand = formatDisplayCommand(spec.executable, spec.args)
    const intent = createCommandIntent(spec, input.identity, displayCommand)

    const authorization = await this.broker.authorizeOperation(
      intent,
      async () =>
        this.spawnAndCapture({
          spec,
          cwdAbsolute,
          signal: input.signal
        }),
      {
        isActive: () => !input.signal?.aborted
      }
    )

    if (!authorization.ok) {
      return { ok: false, reason: authorization.reason }
    }

    const capture = authorization.value
    const sourceEnvironment = this.sourceEnvironment ?? process.env
    const secrets = collectCommandEnvironmentSecrets(sourceEnvironment)
    const chunks = capture.chunks.map((chunk) => ({
      stream: chunk.stream,
      text: redactSensitiveText(chunk.text, secrets)
    }))
    const transcriptRef = await this.store.writeTranscript({
      transcriptId,
      commandId,
      taskId: input.identity.taskId,
      chunks,
      totalBytes: capture.totalBytes,
      truncated: capture.truncated
    })
    const evidence: CommandExecutionEvidence = {
      commandId,
      taskId: input.identity.taskId,
      turnId: input.identity.turnId,
      environmentId: input.identity.environmentId,
      source: 'app-runner',
      displayCommand,
      cwd: spec.cwd,
      startedAt: capture.startedAt,
      endedAt: capture.endedAt,
      timedOut: capture.timedOut,
      status: capture.status,
      transcriptRef,
      truncated: transcriptRef.truncated,
      trustLevel: 'app-enforced',
      ...(typeof capture.exitCode === 'number' ? { exitCode: capture.exitCode } : {}),
      ...(capture.signal ? { signal: capture.signal } : {})
    }
    await this.store.writeEvidence(evidence)
    return { ok: true, evidence }
  }

  /**
   * 使用 spawn + args 数组执行；stdin 忽略，stdout/stderr 分开有界采集。
   * 超时或取消时按进程组 SIGKILL，避免残留孙进程。
   */
  private async spawnAndCapture(input: {
    spec: CommandSpec
    cwdAbsolute: string
    signal?: AbortSignal
  }): Promise<CommandCapture> {
    const startedAt = new Date(this.now()).toISOString()
    const sourceEnvironment = this.sourceEnvironment ?? process.env
    const env = buildCommandEnvironment(sourceEnvironment)
    const collector = new BoundedTranscriptCollector()

    if (input.signal?.aborted) {
      return finalizeCapture(collector, startedAt, new Date(this.now()).toISOString(), {
        spawnError: null,
        exitCode: null,
        stopReason: 'abort'
      })
    }

    let child: ChildProcess
    try {
      child = spawn(input.spec.executable, input.spec.args, {
        cwd: input.cwdAbsolute,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (error) {
      return finalizeCapture(collector, startedAt, new Date(this.now()).toISOString(), {
        spawnError: error instanceof Error ? error : new Error('spawn failed'),
        exitCode: null,
        stopReason: null
      })
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      collector.push('stdout', toBuffer(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      collector.push('stderr', toBuffer(chunk))
    })

    const outcome = await waitForChild(child, {
      timeoutMs: input.spec.timeoutMs,
      signal: input.signal
    })
    return finalizeCapture(collector, startedAt, new Date(this.now()).toISOString(), outcome)
  }

  private requireIdentity(value: string): string {
    if (!isStoreIdentity(value)) throw new CommandSpecError('无法分配命令身份。')
    return value
  }
}

/**
 * 只接受 executable + args + 相对 cwd。出现 command/shell/script 或字符串 args 即视为拼接注入。
 */
export function parseCommandSpec(value: unknown): CommandSpec | null {
  if (!isPlainRecord(value)) return null
  if ('shell' in value || 'command' in value || 'script' in value) return null
  if (typeof value.executable !== 'string' || !isExecutable(value.executable)) return null
  if (!Array.isArray(value.args) || !value.args.every((arg) => isCommandArg(arg))) return null
  if (typeof value.cwd !== 'string' || !isRelativeCwd(value.cwd)) return null
  if (
    typeof value.timeoutMs !== 'number' ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs <= 0 ||
    value.timeoutMs > MAX_COMMAND_TIMEOUT_MS
  ) {
    return null
  }
  if (value.envPolicy !== 'minimal') return null
  if (typeof value.actionSource !== 'string' || !isActionIdentity(value.actionSource)) return null
  if (typeof value.actionId !== 'string' || !isActionIdentity(value.actionId)) return null

  return {
    executable: value.executable,
    args: [...value.args],
    cwd: value.cwd,
    timeoutMs: value.timeoutMs,
    envPolicy: 'minimal',
    actionSource: value.actionSource,
    actionId: value.actionId
  }
}

/**
 * cwd 必须落在给定 Task execution root 内（根目录或已声明子目录）。
 * 词法 `..`、绝对路径和 realpath 后逃逸都拒绝。
 */
async function resolveCommandCwd(executionRoot: string, relativeCwd: string): Promise<string> {
  if (!isRelativeCwd(relativeCwd)) {
    throw new CommandSpecError('cwd 必须是 execution root 内的相对路径。')
  }
  if (typeof executionRoot !== 'string' || !executionRoot || executionRoot.includes('\0')) {
    throw new CommandSpecError('execution root 无效。')
  }
  if (!isAbsolute(executionRoot)) {
    throw new CommandSpecError('execution root 必须是绝对路径。')
  }

  let canonicalRoot: string
  try {
    canonicalRoot = await fs.realpath(executionRoot)
  } catch {
    throw new CommandSpecError('execution root 无效。')
  }

  const candidate =
    relativeCwd === '.' ? canonicalRoot : resolve(canonicalRoot, ...relativeCwd.split('/'))
  if (escapesRoot(canonicalRoot, candidate)) {
    throw new CommandSpecError('cwd 不得越出 execution root。')
  }

  try {
    const canonicalCwd = await fs.realpath(candidate)
    if (escapesRoot(canonicalRoot, canonicalCwd)) {
      throw new CommandSpecError('cwd 不得越出 execution root。')
    }
    const stats = await fs.stat(canonicalCwd)
    if (!stats.isDirectory()) {
      throw new CommandSpecError('cwd 必须是目录。')
    }
    return canonicalCwd
  } catch (error) {
    if (error instanceof CommandSpecError) throw error
    return candidate
  }
}

function createCommandIntent(
  spec: CommandSpec,
  identity: CommandExecutionIdentity,
  displayCommand: string
): OperationIntent {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        actionSource: spec.actionSource,
        actionId: spec.actionId,
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd
      })
    )
    .digest('hex')
  return {
    initiator: { kind: 'app', service: 'command-runner' },
    taskId: identity.taskId,
    turnId: identity.turnId,
    projectId: identity.projectId,
    environmentId: identity.environmentId,
    executionRoot: identity.executionRoot,
    operationType: 'execute-command',
    targets: [{ kind: 'command', value: displayCommand }],
    parameterFingerprint: fingerprint,
    title: truncateUtf8(`执行固定命令：${spec.actionId}`, MAX_COMMAND_FIELD_UTF8_BYTES),
    impact: '在当前 Task execution root 内非交互执行固定命令；子进程环境不含模型凭据。'
  }
}

function waitForChild(
  child: ChildProcess,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    let settled = false
    let spawnError: Error | null = null
    let exitCode: number | null = null
    let signalName: string | undefined
    let stopReason: StopReason | null = null
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        spawnError,
        exitCode,
        ...(signalName ? { signal: signalName } : {}),
        stopReason
      })
    }

    const beginTeardown = (reason: StopReason): void => {
      if (settled || stopReason) return
      stopReason = reason
      killProcessGroup(child)
      graceTimer = setTimeout(finish, PROCESS_TEARDOWN_GRACE_MS)
    }

    const onAbort = (): void => {
      beginTeardown('abort')
    }

    const timeoutTimer = setTimeout(() => {
      beginTeardown('timeout')
    }, options.timeoutMs)

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error('spawn failed')
      finish()
    })
    child.once('close', (code, signal) => {
      exitCode = code
      signalName = asSignal(signal)
      finish()
    })
  })
}

/**
 * 超时/取消必须杀掉整个进程组。Unix 需要独立 process group，
 * 否则 kill(-pid) 会误伤 vitest / Electron 主进程。
 */
function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid
  if (process.platform === 'win32') {
    if (pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已经退出。
      }
    }
    return
  }

  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // 回退到杀当前子进程。
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 进程可能已经退出。
  }
}

function finalizeCapture(
  collector: BoundedTranscriptCollector,
  startedAt: string,
  endedAt: string,
  outcome: ChildOutcome
): CommandCapture {
  const snapshot = collector.snapshot()
  const facts = deriveExecutionFacts(outcome)
  return {
    startedAt,
    endedAt,
    status: facts.status,
    timedOut: facts.timedOut,
    chunks: snapshot.chunks,
    totalBytes: snapshot.totalBytes,
    truncated: snapshot.truncated,
    ...(typeof facts.exitCode === 'number' ? { exitCode: facts.exitCode } : {}),
    ...(facts.signal ? { signal: facts.signal } : {})
  }
}

function deriveExecutionFacts(outcome: ChildOutcome): {
  status: CommandExecutionStatus
  timedOut: boolean
  exitCode?: number
  signal?: string
} {
  if (outcome.spawnError) {
    return { status: 'start-failed', timedOut: false }
  }
  if (outcome.stopReason === 'abort') {
    return {
      status: 'cancelled',
      timedOut: false,
      ...(typeof outcome.exitCode === 'number' ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.signal ? { signal: outcome.signal } : {})
    }
  }
  if (outcome.stopReason === 'timeout') {
    return {
      status: 'timed-out',
      timedOut: true,
      ...(typeof outcome.exitCode === 'number' ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.signal ? { signal: outcome.signal } : {})
    }
  }
  if (outcome.exitCode === 0) {
    return {
      status: 'succeeded',
      timedOut: false,
      exitCode: 0,
      ...(outcome.signal ? { signal: outcome.signal } : {})
    }
  }
  if (typeof outcome.exitCode === 'number') {
    return {
      status: 'failed',
      timedOut: false,
      exitCode: outcome.exitCode,
      ...(outcome.signal ? { signal: outcome.signal } : {})
    }
  }
  return {
    status: 'unknown-exit',
    timedOut: false,
    ...(outcome.signal ? { signal: outcome.signal } : {})
  }
}

class BoundedTranscriptCollector {
  private readonly chunks: Array<{ stream: 'stdout' | 'stderr'; bytes: Buffer }> = []
  private storedBytes = 0
  private totalBytes = 0
  private truncated = false

  push(stream: 'stdout' | 'stderr', data: Buffer): void {
    if (data.byteLength === 0) return
    this.totalBytes += data.byteLength
    if (this.storedBytes >= MAX_COMMAND_TRANSCRIPT_BYTES) {
      this.truncated = true
      return
    }
    if (this.chunks.length >= MAX_COMMAND_TRANSCRIPT_CHUNKS) {
      this.truncated = true
      return
    }
    const remaining = MAX_COMMAND_TRANSCRIPT_BYTES - this.storedBytes
    const slice = data.byteLength > remaining ? data.subarray(0, remaining) : data
    if (slice.byteLength < data.byteLength) this.truncated = true
    this.chunks.push({ stream, bytes: Buffer.from(slice) })
    this.storedBytes += slice.byteLength
  }

  snapshot(): { chunks: CommandTranscriptChunk[]; totalBytes: number; truncated: boolean } {
    return {
      chunks: this.chunks.map((chunk) => ({
        stream: chunk.stream,
        text: chunk.bytes.toString('utf8')
      })),
      totalBytes: this.totalBytes,
      truncated: this.truncated || this.totalBytes > this.storedBytes
    }
  }
}

function formatDisplayCommand(executable: string, args: string[]): string {
  const parts = [executable, ...args].map((part) =>
    /[\s"']/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part
  )
  return truncateUtf8(parts.join(' '), MAX_COMMAND_FIELD_UTF8_BYTES)
}

function isRelativeCwd(value: string): boolean {
  if (value.length === 0 || value.includes('\0')) return false
  if (utf8ByteLength(value) > MAX_COMMAND_FIELD_UTF8_BYTES) return false
  if (value.includes('\\') || value.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  if (value === '.') return true
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function isExecutable(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\0') &&
    !value.includes('\n') &&
    !value.includes('\r') &&
    utf8ByteLength(value) <= MAX_EXECUTABLE_BYTES
  )
}

function isCommandArg(value: unknown): value is string {
  return (
    typeof value === 'string' && !value.includes('\0') && utf8ByteLength(value) <= MAX_ARG_BYTES
  )
}

function isActionIdentity(value: string): boolean {
  return (
    Boolean(value.trim()) &&
    !value.includes('\0') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    utf8ByteLength(value) <= MAX_COMMAND_FIELD_UTF8_BYTES
  )
}

function isStoreIdentity(value: string): boolean {
  return isActionIdentity(value) && value !== '.' && value !== '..'
}

function escapesRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel.startsWith('..') || isAbsolute(rel)
}

function asSignal(value: NodeJS.Signals | number | null | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return undefined
  if (utf8ByteLength(value) > 32) return undefined
  return value
}

function toBuffer(chunk: Buffer | string): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.byteLength <= maxBytes) return text
  return encoded.subarray(0, maxBytes).toString('utf8')
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

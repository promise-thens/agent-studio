import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest'
import type { AgentPermissionRequest } from '../../shared/agent'
import { parseCommandExecutionEvidence } from '../../shared/command'
import { PermissionBroker } from '../security/permission-broker'
import type { PermissionAuditStore } from '../security/permission-audit-store'
import { createLocalEnvironmentId } from '../security/permission-policy'
import {
  AppCommandRunner,
  CommandSpecError,
  parseCommandSpec,
  type CommandSpec
} from './app-command-runner'
import { CommandEvidenceStore, MAX_COMMAND_TRANSCRIPT_BYTES } from './command-evidence-store'

const PLANTED_XAI_API_KEY = 'planted-xai-api-key-not-real'
const PLANTED_AUTHORIZATION = 'Bearer planted-authorization-not-real'
const originalXaiApiKey = process.env.XAI_API_KEY
const originalAuthorization = process.env.AUTHORIZATION
const temporaryDirectories: string[] = []
const livePids: number[] = []

afterEach(async () => {
  restoreEnvVar('XAI_API_KEY', originalXaiApiKey)
  restoreEnvVar('AUTHORIZATION', originalAuthorization)
  for (const pid of livePids.splice(0)) killPidBestEffort(pid)
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('parseCommandSpec', () => {
  it('拒绝 Shell 字符串字段、字符串 args 和逃出 execution root 的 cwd', () => {
    const valid = validSpec()
    expect(parseCommandSpec(valid)).toEqual(valid)
    expect(parseCommandSpec({ ...valid, command: 'ls -la' })).toBeNull()
    expect(parseCommandSpec({ ...valid, shell: '/bin/sh' })).toBeNull()
    expect(parseCommandSpec({ ...valid, script: 'echo hi' })).toBeNull()
    expect(parseCommandSpec({ ...valid, args: ' -la' })).toBeNull()
    expect(parseCommandSpec({ ...valid, cwd: '..' })).toBeNull()
    expect(parseCommandSpec({ ...valid, cwd: '/etc' })).toBeNull()
    expect(parseCommandSpec({ ...valid, cwd: 'foo/../../etc' })).toBeNull()
    expect(parseCommandSpec({ ...valid, cwd: 'C:\\Windows' })).toBeNull()
    expectTypeOf<CommandSpec>().toHaveProperty('executable')
    expectTypeOf<CommandSpec>().toHaveProperty('args')
    expectTypeOf<CommandSpec>().not.toHaveProperty('command')
    expectTypeOf<CommandSpec>().not.toHaveProperty('shell')
  })
})

describe('AppCommandRunner', () => {
  it('CommandSpec 逃逸 cwd 在授权和 spawn 前被拒绝', async () => {
    const fixture = await createRunnerFixture()
    await expect(
      fixture.runner.run({
        spec: { ...validSpec(), cwd: '../escape' },
        identity: fixture.identity
      })
    ).rejects.toBeInstanceOf(CommandSpecError)
    expect(fixture.approvals).toHaveLength(0)
  })

  it('子进程环境不含宿主植入的 XAI_API_KEY / AUTHORIZATION', async () => {
    const fixture = await createRunnerFixture()
    process.env.XAI_API_KEY = PLANTED_XAI_API_KEY
    process.env.AUTHORIZATION = PLANTED_AUTHORIZATION
    const dumpScript = [
      'const fs = require("node:fs")',
      'fs.writeFileSync("env-dump.json", JSON.stringify({',
      '  xai: process.env.XAI_API_KEY ?? null,',
      '  authorization: process.env.AUTHORIZATION ?? null,',
      '  keys: Object.keys(process.env)',
      '}))'
    ].join('\n')

    const result = await fixture.runner.run({
      spec: validSpec({ args: ['-e', dumpScript], actionId: 'dump-env' }),
      identity: fixture.identity
    })

    expect(result.ok).toBe(true)
    expect(process.env.XAI_API_KEY).toBe(PLANTED_XAI_API_KEY)
    expect(process.env.AUTHORIZATION).toBe(PLANTED_AUTHORIZATION)
    const dump = JSON.parse(
      await readFile(join(fixture.identity.executionRoot, 'env-dump.json'), 'utf8')
    ) as {
      xai: string | null
      authorization: string | null
      keys: string[]
    }
    expect(dump.xai).toBeNull()
    expect(dump.authorization).toBeNull()
    expect(dump.keys).not.toContain('XAI_API_KEY')
    expect(dump.keys).not.toContain('AUTHORIZATION')
    expect(JSON.stringify(dump)).not.toContain(PLANTED_XAI_API_KEY)
    expect(JSON.stringify(dump)).not.toContain(PLANTED_AUTHORIZATION)
  })

  it('成功命令写入 exit 0、succeeded 和 transcript', async () => {
    const fixture = await createRunnerFixture()
    const result = await fixture.runner.run({
      spec: validSpec(),
      identity: fixture.identity
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected evidence')
    const parsed = parseCommandExecutionEvidence(result.evidence)
    expect(parsed).toMatchObject({
      source: 'app-runner',
      trustLevel: 'app-enforced',
      status: 'succeeded',
      exitCode: 0,
      timedOut: false,
      cwd: '.',
      truncated: false
    })
    expect(result.evidence.transcriptRef.truncated).toBe(false)
    const transcript = await fixture.store.readTranscript(
      result.evidence.taskId,
      result.evidence.transcriptRef.transcriptId
    )
    expect(transcript?.chunks.some((chunk) => chunk.text.includes('ok-app-runner'))).toBe(true)
  })

  it('非零退出写入 failed 和 exitCode', async () => {
    const fixture = await createRunnerFixture()
    const result = await fixture.runner.run({
      spec: validSpec({
        args: ['-e', 'process.exit(7)'],
        actionId: 'fail-exit'
      }),
      identity: fixture.identity
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected evidence')
    expect(result.evidence.status).toBe('failed')
    expect(result.evidence.exitCode).toBe(7)
    expect(result.evidence.timedOut).toBe(false)
    expect(parseCommandExecutionEvidence(result.evidence)?.status).toBe('failed')
  })

  it('超时标记 timed-out 且进程不再残留', async () => {
    const fixture = await createRunnerFixture()
    const result = await fixture.runner.run({
      spec: sleepSpec({ timeoutMs: 800, actionId: 'timeout-sleep' }),
      identity: fixture.identity
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected evidence')
    expect(result.evidence.status).toBe('timed-out')
    expect(result.evidence.timedOut).toBe(true)
    const pid = Number(
      (await readFile(join(fixture.identity.executionRoot, 'child.pid'), 'utf8')).trim()
    )
    livePids.push(pid)
    await waitUntil(() => !isPidAlive(pid), 1500)
    expect(isPidAlive(pid)).toBe(false)
  }, 15_000)

  it('AbortSignal 取消后状态为 cancelled', async () => {
    const fixture = await createRunnerFixture()
    const controller = new AbortController()
    const running = fixture.runner.run({
      spec: sleepSpec({ timeoutMs: 10_000, actionId: 'abort-sleep' }),
      identity: fixture.identity,
      signal: controller.signal
    })
    const pid = Number(
      (await waitForFile(join(fixture.identity.executionRoot, 'child.pid'))).trim()
    )
    livePids.push(pid)
    controller.abort()
    const result = await running

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected evidence')
    expect(result.evidence.status).toBe('cancelled')
    expect(result.evidence.timedOut).toBe(false)
    await waitUntil(() => !isPidAlive(pid), 1500)
    expect(isPidAlive(pid)).toBe(false)
  }, 15_000)

  it('缺失可执行文件写入 start-failed', async () => {
    const fixture = await createRunnerFixture()
    const result = await fixture.runner.run({
      spec: validSpec({
        executable: join(fixture.identity.executionRoot, 'missing-agent-studio-cmd'),
        args: [],
        actionId: 'missing-bin'
      }),
      identity: fixture.identity
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected evidence')
    expect(result.evidence.status).toBe('start-failed')
    expect(result.evidence.exitCode).toBeUndefined()
    expect(result.evidence.timedOut).toBe(false)
    expect(parseCommandExecutionEvidence(result.evidence)?.status).toBe('start-failed')
  })

  it('超大 stdout 截断且 evidence 与 transcriptRef 都标记 truncated', async () => {
    const fixture = await createRunnerFixture()
    const bytes = MAX_COMMAND_TRANSCRIPT_BYTES + 32 * 1024
    const result = await fixture.runner.run({
      spec: validSpec({
        args: ['-e', `process.stdout.write("A".repeat(${bytes}))`],
        actionId: 'huge-stdout'
      }),
      identity: fixture.identity
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected evidence')
    expect(result.evidence.truncated).toBe(true)
    expect(result.evidence.transcriptRef.truncated).toBe(true)
    expect(result.evidence.transcriptRef.availableBytes).toBeLessThanOrEqual(
      MAX_COMMAND_TRANSCRIPT_BYTES
    )
    expect(result.evidence.transcriptRef.totalBytes).toBeGreaterThan(
      result.evidence.transcriptRef.availableBytes
    )
    expect(parseCommandExecutionEvidence(result.evidence)?.truncated).toBe(true)
  }, 15_000)

  it('中文输出完整保留', async () => {
    const fixture = await createRunnerFixture()
    const result = await fixture.runner.run({
      spec: validSpec({
        args: ['-e', 'process.stdout.write("你好，世界")'],
        actionId: 'chinese-stdout'
      }),
      identity: fixture.identity
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected evidence')
    const transcript = await fixture.store.readTranscript(
      result.evidence.taskId,
      result.evidence.transcriptRef.transcriptId
    )
    expect(transcript?.chunks.some((chunk) => chunk.text.includes('你好，世界'))).toBe(true)
    expect(result.evidence.truncated).toBe(false)
  })

  it('Broker 拒绝或取消授权时不 spawn', async () => {
    const denied = await createRunnerFixture({ approval: 'deny' })
    const cancelled = await createRunnerFixture({ approval: 'drop' })
    const deniedMarker = join(denied.identity.executionRoot, 'spawned-denied')
    const cancelledMarker = join(cancelled.identity.executionRoot, 'spawned-cancelled')

    const deniedResult = await denied.runner.run({
      spec: markerSpec(deniedMarker, 'deny-spawn'),
      identity: denied.identity
    })
    const cancelledResult = await cancelled.runner.run({
      spec: markerSpec(cancelledMarker, 'cancel-spawn'),
      identity: cancelled.identity
    })

    expect(deniedResult).toMatchObject({ ok: false, reason: 'user-denied' })
    expect(cancelledResult).toMatchObject({ ok: false, reason: 'cancelled' })
    await delay(200)
    await expect(access(deniedMarker)).rejects.toThrow()
    await expect(access(cancelledMarker)).rejects.toThrow()
  })
})

function validSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("ok-app-runner")'],
    cwd: '.',
    timeoutMs: 10_000,
    envPolicy: 'minimal',
    actionSource: 'test-suite',
    actionId: 'print-ok',
    ...overrides
  }
}

function sleepSpec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return validSpec({
    args: [
      '-e',
      'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1 << 30)'
    ],
    ...overrides
  })
}

function markerSpec(markerPath: string, actionId: string): CommandSpec {
  return validSpec({
    args: ['-e', `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "spawned")`],
    actionId
  })
}

async function createRunnerFixture(
  options: { approval?: 'allow-once' | 'deny' | 'drop' } = {}
): Promise<{
  runner: AppCommandRunner
  store: CommandEvidenceStore
  identity: {
    taskId: string
    turnId: string
    projectId: string
    environmentId: string
    executionRoot: string
  }
  approvals: AgentPermissionRequest[]
}> {
  const executionRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-command-root-')))
  const storeRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-command-store-')))
  temporaryDirectories.push(executionRoot, storeRoot)
  const identity = {
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    executionRoot,
    environmentId: createLocalEnvironmentId('project-1', executionRoot)
  }
  const store = new CommandEvidenceStore({ rootDir: storeRoot })
  const approvals: AgentPermissionRequest[] = []
  const decision = options.approval ?? 'allow-once'
  const broker = new PermissionBroker({
    auditStore: {
      append: async () => undefined
    } as unknown as PermissionAuditStore,
    onApproval: (request) => {
      approvals.push(request)
      if (decision === 'drop') return false
      queueMicrotask(() => {
        void broker.respond({
          approvalId: request.approvalId,
          taskId: request.taskId,
          turnId: request.turnId,
          decision: decision === 'deny' ? 'deny' : 'allow-once'
        })
      })
      return true
    },
    resolveIntentContext: () => ({
      taskId: identity.taskId,
      turnId: identity.turnId,
      projectId: identity.projectId,
      executionRoot: identity.executionRoot,
      environmentId: identity.environmentId,
      runtimeId: 'grok',
      environmentKind: 'local',
      active: true
    }),
    createId: () => randomUUID()
  })
  const runner = new AppCommandRunner({ store, broker })
  return { runner, store, identity, approvals }
}

function restoreEnvVar(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = original
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPidBestEffort(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 进程组可能已经退出。
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 单进程可能已经退出。
  }
}

async function waitForFile(path: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch {
      await delay(20)
    }
  }
  throw new Error(`文件未在预期时间内出现: ${path}`)
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(20)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

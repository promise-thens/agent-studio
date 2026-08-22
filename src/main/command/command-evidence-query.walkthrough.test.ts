import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPermissionRequest } from '../../shared/agent'
import {
  deriveValidationResult,
  parseCommandExecutionEvidence,
  type CommandExecutionEvidence
} from '../../shared/command'
import type { DesktopIpcResult } from '../../shared/ipc-result'
import { TASK_INVOKE_CHANNELS } from '../../shared/task-ipc'
import { registerTaskIpcHandlers, type TaskHistoryIpcRuntime } from '../agent/task-ipc'
import type { DesktopIpcHandler } from '../ipc-types'
import {
  accumulateGrokCommandToolFacts,
  mapGrokCommandEvidence,
  type GrokCommandEvidenceMapping
} from '../runtime/grok/grok-command-evidence-mapper'
import type { PermissionAuditStore } from '../security/permission-audit-store'
import { PermissionBroker } from '../security/permission-broker'
import { createLocalEnvironmentId } from '../security/permission-policy'
import type { TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { AppCommandRunner, type CommandSpec } from './app-command-runner'
import { CommandEvidenceStore } from './command-evidence-store'

const PLANTED_XAI_API_KEY = 'planted-xai-api-key-not-real'
const originalXaiApiKey = process.env.XAI_API_KEY
const FAKE_GROK_KEY = 'sk-fake-grok-command-evidence'
const TIMESTAMP = '2026-08-22T12:00:00.000Z'
const event = {} as TrustedIpcInvokeEvent
const temporaryDirectories: string[] = []
const livePids: number[] = []

afterEach(async () => {
  restoreEnvVar('XAI_API_KEY', originalXaiApiKey)
  for (const pid of livePids.splice(0)) killPidBestEffort(pid)
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('命令证据查询走查', () => {
  it('App 成功/失败/超时/取消与 Grok 成功/失败/缺字段/output_file 经查询 API 可读且不混淆', async () => {
    process.env.XAI_API_KEY = PLANTED_XAI_API_KEY
    const fixture = await createQueryFixture()

    const success = await fixture.runner.run({
      spec: validSpec({
        args: [
          '-e',
          'process.stdout.write(JSON.stringify({ ok: true, keys: Object.keys(process.env) }))'
        ],
        actionId: 'walk-success'
      }),
      identity: fixture.identity
    })
    const failed = await fixture.runner.run({
      spec: validSpec({ args: ['-e', 'process.exit(3)'], actionId: 'walk-fail' }),
      identity: fixture.identity
    })
    const timedOut = await fixture.runner.run({
      spec: sleepSpec('timeout.pid', { timeoutMs: 800, actionId: 'walk-timeout' }),
      identity: fixture.identity
    })
    const controller = new AbortController()
    const cancelling = fixture.runner.run({
      spec: sleepSpec('cancel.pid', { timeoutMs: 10_000, actionId: 'walk-cancel' }),
      identity: fixture.identity,
      signal: controller.signal
    })
    const pid = Number(
      (await waitForFile(join(fixture.identity.executionRoot, 'cancel.pid'))).trim()
    )
    livePids.push(pid)
    controller.abort()
    const cancelled = await cancelling

    expect({
      success: success.ok,
      failed: failed.ok,
      timedOut: timedOut.ok,
      cancelled: cancelled.ok,
      successReason: success.ok ? undefined : success.reason,
      failedReason: failed.ok ? undefined : failed.reason,
      timedOutReason: timedOut.ok ? undefined : timedOut.reason,
      cancelledReason: cancelled.ok ? undefined : cancelled.reason
    }).toMatchObject({
      success: true,
      failed: true,
      timedOut: true,
      cancelled: true
    })
    if (!success.ok || !failed.ok || !timedOut.ok || !cancelled.ok) {
      throw new Error('expected app-runner evidence')
    }

    await persistGrokMapping(
      fixture.store,
      mapGrokCommandEvidence(
        grokFacts({
          toolCallId: 'tool-success',
          rawInput: { command: 'pnpm test' },
          rawOutput: { exit_code: 0, timed_out: false, output: `ok ${FAKE_GROK_KEY}` }
        }),
        redactFake
      )
    )
    await persistGrokMapping(
      fixture.store,
      mapGrokCommandEvidence(
        grokFacts({
          toolCallId: 'tool-fail',
          title: 'Tests passed',
          rawInput: { command: 'pnpm test' },
          rawOutput: { exit_code: 2, timed_out: false, output: 'failed' }
        }),
        redactFake
      )
    )
    await persistGrokMapping(
      fixture.store,
      mapGrokCommandEvidence(
        grokFacts({
          toolCallId: 'tool-missing',
          title: 'Tests passed',
          rawInput: { ignored: true },
          rawOutput: { unexpected: 0 }
        }),
        redactFake
      )
    )
    await persistGrokMapping(
      fixture.store,
      mapGrokCommandEvidence(
        grokFacts({
          toolCallId: 'tool-output-file',
          rawInput: { command: 'pnpm test' },
          rawOutput: {
            exit_code: 0,
            timed_out: false,
            output: 'inline',
            output_file: '/tmp/should-not-leak.log'
          }
        }),
        redactFake
      )
    )

    const listed = await fixture.invoke<{ items: CommandExecutionEvidence[] }>(
      TASK_INVOKE_CHANNELS.listCommandEvidence,
      { taskId: 'task-1' }
    )
    expect(listed.ok).toBe(true)
    if (!listed.ok) throw new Error('expected list')
    const items = listed.value.items
    expect(items.every((item) => parseCommandExecutionEvidence(item))).toBe(true)
    expect(
      items.some((item) => item.source === 'app-runner' && item.trustLevel === 'app-enforced')
    ).toBe(true)
    expect(
      items.some((item) => item.source === 'runtime-tool' && item.trustLevel === 'runtime-reported')
    ).toBe(true)
    expect(items.some((item) => item.status === 'failed' && item.exitCode === 3)).toBe(true)
    expect(items.some((item) => item.status === 'timed-out' && item.timedOut)).toBe(true)
    expect(items.some((item) => item.status === 'cancelled')).toBe(true)
    expect(items.some((item) => item.status === 'title-only')).toBe(true)
    expect(items.some((item) => item.outputFileNotIngested === true && item.truncated)).toBe(true)
    expect(JSON.stringify(listed)).not.toContain(PLANTED_XAI_API_KEY)
    expect(JSON.stringify(listed)).not.toContain(FAKE_GROK_KEY)
    expect(JSON.stringify(listed)).not.toContain('/tmp/should-not-leak.log')
    expect(JSON.stringify(listed)).not.toContain(fixture.store.rootDir)

    const successQuery = await fixture.invoke<CommandExecutionEvidence>(
      TASK_INVOKE_CHANNELS.getCommandEvidence,
      { taskId: 'task-1', commandId: success.evidence.commandId }
    )
    expect(successQuery).toMatchObject({
      ok: true,
      value: { source: 'app-runner', trustLevel: 'app-enforced', status: 'succeeded', exitCode: 0 }
    })

    const transcript = await fixture.invoke<{ chunks: Array<{ text: string }> }>(
      TASK_INVOKE_CHANNELS.getCommandTranscript,
      { taskId: 'task-1', commandId: success.evidence.commandId }
    )
    expect(transcript.ok).toBe(true)
    if (!transcript.ok) throw new Error('expected transcript')
    expect(JSON.stringify(transcript)).toContain('"ok":true')
    expect(JSON.stringify(transcript)).not.toContain(PLANTED_XAI_API_KEY)
    expect(JSON.stringify(transcript)).not.toContain('path')

    const appEvidence = items.filter(
      (item) => item.source === 'app-runner' && item.turnId === 'turn-1'
    )
    const runtimeEvidence = items.filter((item) => item.source === 'runtime-tool')
    expect(deriveValidationResult(appEvidence, 'val-app')?.outcome).toBe('fail')
    expect(deriveValidationResult(runtimeEvidence, 'val-runtime')?.outcome).toBe('fail')
    expect(
      deriveValidationResult(
        runtimeEvidence.filter((item) => item.status === 'title-only'),
        'val-title'
      )?.outcome
    ).toBe('unknown')
  }, 30_000)
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

function sleepSpec(pidFile: string, overrides: Partial<CommandSpec> = {}): CommandSpec {
  return validSpec({
    args: [
      '-e',
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1 << 30)`
    ],
    ...overrides
  })
}

function grokFacts(input: {
  toolCallId: string
  title?: string
  rawInput: unknown
  rawOutput: unknown
}): Parameters<typeof mapGrokCommandEvidence>[0] {
  const facts = accumulateGrokCommandToolFacts(
    undefined,
    {
      toolCallId: input.toolCallId,
      kind: 'execute',
      title: input.title ?? 'Run tests',
      status: 'completed',
      rawInput: input.rawInput,
      rawOutput: input.rawOutput
    },
    {
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'env-1',
      nowIso: TIMESTAMP
    }
  )
  facts.endedAt = TIMESTAMP
  return facts
}

function redactFake(text: string): string {
  return text.replaceAll(FAKE_GROK_KEY, '[REDACTED]')
}

async function persistGrokMapping(
  store: CommandEvidenceStore,
  mapping: GrokCommandEvidenceMapping | null
): Promise<void> {
  expect(mapping).not.toBeNull()
  if (!mapping) throw new Error('expected grok mapping')
  const transcriptRef = await store.writeTranscript({
    transcriptId: mapping.evidence.transcriptRef.transcriptId,
    commandId: mapping.evidence.commandId,
    taskId: mapping.evidence.taskId,
    chunks: mapping.chunks,
    totalBytes:
      mapping.evidence.transcriptRef.totalBytes ?? mapping.evidence.transcriptRef.availableBytes,
    truncated: mapping.evidence.truncated
  })
  await store.writeEvidence({
    ...mapping.evidence,
    transcriptRef,
    truncated: mapping.evidence.truncated || transcriptRef.truncated
  })
}

async function createQueryFixture(): Promise<{
  runner: AppCommandRunner
  store: CommandEvidenceStore
  identity: {
    taskId: string
    turnId: string
    projectId: string
    environmentId: string
    executionRoot: string
  }
  invoke: <T>(channel: string, request: unknown) => Promise<DesktopIpcResult<T>>
}> {
  const executionRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-command-root-')))
  const storeRoot = await realpath(await mkdtemp(join(tmpdir(), 'agent-studio-query-')))
  temporaryDirectories.push(executionRoot, storeRoot)
  const identity = {
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    executionRoot,
    environmentId: createLocalEnvironmentId('project-1', executionRoot)
  }
  const store = new CommandEvidenceStore({ rootDir: storeRoot })
  const broker = new PermissionBroker({
    auditStore: { append: async () => undefined } as unknown as PermissionAuditStore,
    onApproval: (request: AgentPermissionRequest) => {
      queueMicrotask(() => {
        void broker.respond({
          approvalId: request.approvalId,
          taskId: request.taskId,
          turnId: request.turnId,
          decision: 'allow-once'
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
  const handlers = new Map<string, DesktopIpcHandler>()
  const history = {
    getTaskDetail: vi.fn(() => ({
      taskId: 'task-1',
      projectId: 'project-1',
      runtimeId: 'grok' as const,
      title: '走查',
      state: 'completed' as const,
      turnCount: 1,
      resumable: true,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      revision: 1,
      environment: { kind: 'local' as const, projectId: 'project-1' },
      permissionPolicy: { kind: 'legacy-runtime' as const }
    }))
  } as unknown as TaskHistoryIpcRuntime
  registerTaskIpcHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    assertTrustedSender: () => undefined,
    getHistory: () => history,
    getCommandEvidenceStore: () => store,
    sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
  })
  return {
    runner: new AppCommandRunner({ store, broker }),
    store,
    identity,
    invoke: async <T>(channel: string, request: unknown): Promise<DesktopIpcResult<T>> => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`缺少 Handler: ${channel}`)
      return (await handler(event, request)) as DesktopIpcResult<T>
    }
  }
}

function restoreEnvVar(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = original
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
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new Error(`等待文件超时: ${path}`)
}

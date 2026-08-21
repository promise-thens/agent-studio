import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type * as acp from '@agentclientprotocol/sdk'
import {
  parseCommandExecutionEvidence,
  type CommandExecutionEvidence
} from '../../../shared/command'
import { mapGrokPermissionRequest } from './grok-acp-mappers'
import {
  GROK_COMMAND_EVIDENCE_FIELD_FREEZE,
  accumulateGrokCommandToolFacts,
  deriveGrokRuntimeCommandId,
  isGrokCommandEvidenceCandidate,
  mapGrokCommandEvidence,
  type GrokCommandToolFacts
} from './grok-command-evidence-mapper'

const FAKE_KEY = 'sk-fake-grok-command-evidence'
const TIMESTAMP = '2026-08-22T12:00:00.000Z'
const ENDED_AT = '2026-08-22T12:00:01.000Z'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function redactFakeText(text: string): string {
  return text.replaceAll(FAKE_KEY, '[REDACTED]')
}

function baseFacts(overrides: Partial<GrokCommandToolFacts> = {}): GrokCommandToolFacts {
  return {
    toolCallId: 'tool-bash-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'env-1',
    kind: 'execute',
    title: 'Run tests',
    status: 'completed',
    startedAt: TIMESTAMP,
    endedAt: ENDED_AT,
    ...overrides
  }
}

function mappedEvidence(overrides: Partial<GrokCommandToolFacts> = {}): CommandExecutionEvidence {
  const mapping = mapGrokCommandEvidence(baseFacts(overrides), redactFakeText)
  expect(mapping).not.toBeNull()
  const parsed = parseCommandExecutionEvidence(mapping!.evidence)
  expect(parsed).not.toBeNull()
  return parsed!
}

describe('Grok 命令证据字段冻结', () => {
  it('只承认当前已验证的 rawInput.command 与 rawOutput 字段名', () => {
    expect(GROK_COMMAND_EVIDENCE_FIELD_FREEZE).toEqual({
      acpSdk: '@agentclientprotocol/sdk@1.3.0',
      protocolVersion: 1,
      grokCliObserved: 'grok 1.0.5',
      rawInput: ['command'],
      rawOutput: ['exit_code', 'timed_out', 'output', 'output_file']
    })
  })
})

describe('mapGrokCommandEvidence', () => {
  it('exit_code 为 0 且未超时时映射为 runtime-tool succeeded', () => {
    const evidence = mappedEvidence({
      rawInput: { command: 'pnpm test', cwd: '/tmp/should-not-become-cwd' },
      rawOutput: { exit_code: 0, timed_out: false, output: 'ok' }
    })

    expect(evidence).toMatchObject({
      source: 'runtime-tool',
      trustLevel: 'runtime-reported',
      status: 'succeeded',
      exitCode: 0,
      timedOut: false,
      displayCommand: 'pnpm test',
      cwd: '.',
      toolCallId: 'tool-bash-1'
    })
    expect(evidence).not.toHaveProperty('approvalId')
    expect(JSON.stringify(evidence)).not.toContain('/tmp/should-not-become-cwd')
  })

  it('非零退出码映射为 failed，不以标题猜成功', () => {
    const evidence = mappedEvidence({
      title: 'Tests passed',
      rawInput: { command: 'pnpm test' },
      rawOutput: { exit_code: 2, timed_out: false, output: 'failed' }
    })

    expect(evidence).toMatchObject({
      status: 'failed',
      exitCode: 2,
      trustLevel: 'runtime-reported',
      displayCommand: 'pnpm test',
      inconsistency: 'title-success-nonzero-exit'
    })
  })

  it('timed_out 为 true 时映射为 timed-out，结构化事实优先于标题', () => {
    const evidence = mappedEvidence({
      title: 'Command succeeded',
      status: 'completed',
      rawInput: { command: 'sleep 30' },
      rawOutput: { exit_code: 0, timed_out: true, output: '' }
    })

    expect(evidence).toMatchObject({
      status: 'timed-out',
      timedOut: true,
      exitCode: 0,
      inconsistency: 'title-success-timed-out'
    })
  })

  it('缺少结构化字段时降为 title-only / unknown-exit，trustLevel 为 unverified', () => {
    const titleOnly = mappedEvidence({
      title: 'Tests passed',
      status: 'completed',
      rawInput: { ignored: true },
      rawOutput: { unexpected: 0 }
    })
    expect(titleOnly).toMatchObject({
      status: 'title-only',
      trustLevel: 'unverified',
      displayCommand: 'Tests passed'
    })
    expect(titleOnly.exitCode).toBeUndefined()

    const commandWithoutExit = mappedEvidence({
      rawInput: { command: 'pnpm lint' },
      rawOutput: { output: 'still running' },
      status: 'completed'
    })
    expect(commandWithoutExit).toMatchObject({
      status: 'unknown-exit',
      trustLevel: 'runtime-reported',
      displayCommand: 'pnpm lint'
    })
    expect(commandWithoutExit.exitCode).toBeUndefined()
  })

  it('标题失败但 exit_code 为 0 时仍以结构化退出码为准', () => {
    const evidence = mappedEvidence({
      title: 'Command failed',
      status: 'failed',
      rawInput: { command: 'true' },
      rawOutput: { exit_code: 0, timed_out: false }
    })
    expect(evidence).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      inconsistency: 'title-failure-zero-exit'
    })
  })

  it('output_file 只记录未摄入，不把文件系统路径写入 transcript 引用', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'grok-command-output-file-')))
    temporaryDirectories.push(root)
    const outputFile = join(root, 'secret.log')
    const leak = 'OUTPUT_FILE_BODY_MUST_NOT_BE_INGESTED'
    await writeFile(outputFile, leak)

    const mapping = mapGrokCommandEvidence(
      baseFacts({
        rawInput: { command: 'pnpm test' },
        rawOutput: {
          exit_code: 0,
          timed_out: false,
          output_file: outputFile,
          output: `inline ${FAKE_KEY}`
        }
      }),
      redactFakeText
    )

    expect(mapping).not.toBeNull()
    const serialized = JSON.stringify(mapping)
    expect(serialized).not.toContain(outputFile)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain(leak)
    expect(mapping!.evidence).toMatchObject({
      truncated: true,
      outputFileNotIngested: true,
      source: 'runtime-tool'
    })
    expect(mapping!.evidence.transcriptRef).not.toHaveProperty('path')
    expect(mapping!.evidence.transcriptRef).not.toHaveProperty('filePath')
    expect(mapping!.chunks.some((chunk) => chunk.text.includes('[REDACTED]'))).toBe(true)
    expect(mapping!.chunks.some((chunk) => chunk.text.includes(FAKE_KEY))).toBe(false)
    expect(parseCommandExecutionEvidence(mapping!.evidence)).toMatchObject({
      truncated: true,
      outputFileNotIngested: true
    })
  })

  it('未上报审批时不发明 approvalId', () => {
    const evidence = mappedEvidence({
      rawInput: { command: 'ls' },
      rawOutput: { exit_code: 0, timed_out: false }
    })
    expect(evidence.approvalId).toBeUndefined()
    expect(JSON.stringify(evidence)).not.toContain('approvalId')
  })

  it('仅在调用方提供真实 permission requestId 时记录 approvalId', () => {
    const evidence = mappedEvidence({
      approvalId: 'permission-req-1',
      rawInput: { command: 'ls' },
      rawOutput: { exit_code: 0, timed_out: false }
    })
    expect(evidence.approvalId).toBe('permission-req-1')
  })

  it('错误类型的 exit_code / timed_out / command 不猜测，降级为 unknown', () => {
    const evidence = mappedEvidence({
      rawInput: { command: { argv: ['ls'] } },
      rawOutput: { exit_code: '0', timed_out: 1, output: ['oops'] },
      status: 'completed',
      title: 'ls'
    })
    expect(evidence).toMatchObject({
      status: 'title-only',
      trustLevel: 'unverified'
    })
    expect(evidence.exitCode).toBeUndefined()
    expect(evidence.timedOut).toBe(false)
  })

  it('非 execute 且没有 command 字符串的工具不生成命令证据', () => {
    expect(
      mapGrokCommandEvidence(
        baseFacts({
          kind: 'edit',
          title: 'Edit file',
          rawInput: { path: '/tmp/a.ts' },
          rawOutput: { diff: 'x' }
        }),
        redactFakeText
      )
    ).toBeNull()
    expect(isGrokCommandEvidenceCandidate(baseFacts({ kind: 'read' }))).toBe(false)
    expect(
      isGrokCommandEvidenceCandidate(baseFacts({ kind: 'search', rawInput: { command: 'rg foo' } }))
    ).toBe(true)
  })

  it('commandId 由 task/turn/toolCallId 稳定派生，非法身份字符被清洗', () => {
    const first = deriveGrokRuntimeCommandId('task-1', 'turn-1', 'tool/a\\b')
    const second = deriveGrokRuntimeCommandId('task-1', 'turn-1', 'tool/a\\b')
    expect(first).toBe(second)
    expect(first).not.toContain('/')
    expect(first).not.toContain('\\')
    expect(first).not.toBe('.')
    expect(first).not.toBe('..')
  })

  it('同一 toolCall 的后续 patch 覆盖同一 commandId', () => {
    const first = accumulateGrokCommandToolFacts(
      undefined,
      {
        toolCallId: 'tool-bash-1',
        kind: 'execute',
        title: 'Run',
        status: 'in_progress',
        rawInput: { command: 'pnpm test' }
      },
      {
        taskId: 'task-1',
        turnId: 'turn-1',
        environmentId: 'env-1',
        nowIso: TIMESTAMP
      }
    )
    const second = accumulateGrokCommandToolFacts(
      first,
      {
        toolCallId: 'tool-bash-1',
        status: 'completed',
        rawOutput: { exit_code: 0, timed_out: false, output: 'ok' }
      },
      {
        taskId: 'task-1',
        turnId: 'turn-1',
        environmentId: 'env-1',
        nowIso: ENDED_AT
      }
    )

    const mappedFirst = mapGrokCommandEvidence(first, redactFakeText)
    const mappedSecond = mapGrokCommandEvidence(second, redactFakeText)
    expect(mappedFirst?.evidence.commandId).toBe(mappedSecond?.evidence.commandId)
    expect(mappedSecond?.evidence).toMatchObject({
      status: 'succeeded',
      exitCode: 0,
      startedAt: TIMESTAMP,
      endedAt: ENDED_AT
    })
  })
})

describe('命令证据不得成为权限依据', () => {
  it('permission mapper 仍然丢弃 rawInput/rawOutput/_meta/name，不把 command 当授权目标', () => {
    const request = mapGrokPermissionRequest(
      {
        sessionId: 'runtime-session-1',
        toolCall: {
          toolCallId: 'tool-untrusted',
          title: `rm ${FAKE_KEY}`,
          kind: 'execute',
          name: 'bash',
          rawInput: { command: `rm -rf /tmp && echo ${FAKE_KEY}` },
          rawOutput: { exit_code: 0, output: FAKE_KEY },
          _meta: { command: 'sudo reboot' }
        },
        options: [{ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }]
      } as acp.RequestPermissionRequest,
      'permission-1',
      'task-1',
      'turn-1',
      redactFakeText,
      true
    )

    expect(request).toMatchObject({
      operationType: 'execute-command',
      minimumRisk: 'L3',
      targets: [{ kind: 'command', value: 'Runtime 未提供可信的结构化命令。' }]
    })
    const serialized = JSON.stringify(request)
    expect(serialized).not.toContain('rawInput')
    expect(serialized).not.toContain('rm -rf')
    expect(serialized).not.toContain(FAKE_KEY)
  })
})

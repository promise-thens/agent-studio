import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  COMMAND_EXECUTION_SOURCES,
  COMMAND_EXECUTION_STATUSES,
  COMMAND_TRANSCRIPT_ENCODINGS,
  COMMAND_TRANSCRIPT_RETENTION_POLICIES,
  COMMAND_TRANSCRIPT_RETENTION_STATES,
  COMMAND_TRUST_LEVELS,
  deriveValidationResult,
  parseCommandExecutionEvidence,
  parseCommandTranscriptRef,
  parseValidationResult,
  VALIDATION_OUTCOMES,
  type CommandExecutionEvidence,
  type CommandExecutionSource,
  type CommandTranscriptRef,
  type CommandTrustLevel
} from './command'

/** 构造刚好超过 4 KiB 的 ASCII 串，用于字段字节上限断言。 */
function oversizeAscii(prefix = 'x'): string {
  return prefix.repeat(4 * 1024 + 1)
}

const timestamp = '2026-08-21T10:00:00.000Z'

function validTranscriptRef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transcriptId: 'transcript-1',
    availableBytes: 128,
    totalBytes: 128,
    truncated: false,
    encoding: 'utf-8',
    retentionPolicy: 'bounded',
    retentionState: 'retained',
    ...overrides
  }
}

function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: 'cmd-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'env-1',
    source: 'app-runner',
    displayCommand: 'pnpm test',
    cwd: '.',
    startedAt: timestamp,
    endedAt: '2026-08-21T10:00:02.000Z',
    exitCode: 0,
    timedOut: false,
    status: 'succeeded',
    transcriptRef: validTranscriptRef(),
    truncated: false,
    trustLevel: 'app-enforced',
    ...overrides
  }
}

describe('命令执行证据契约', () => {
  it('导出中性来源、状态和信任等级，不含 Grok 专属前缀', () => {
    expect(COMMAND_EXECUTION_SOURCES).toEqual(['app-runner', 'runtime-tool', 'user-terminal'])
    expect(COMMAND_TRUST_LEVELS).toEqual(['app-enforced', 'runtime-reported', 'unverified'])
    expect(COMMAND_EXECUTION_STATUSES).toEqual([
      'running',
      'succeeded',
      'failed',
      'timed-out',
      'cancelled',
      'start-failed',
      'unknown-exit',
      'title-only'
    ])
    expect(COMMAND_TRANSCRIPT_RETENTION_STATES).toEqual(['retained', 'expired', 'missing'])
    expect(COMMAND_TRANSCRIPT_RETENTION_POLICIES).toEqual(['bounded', 'ephemeral'])
    expect(COMMAND_TRANSCRIPT_ENCODINGS).toEqual(['utf-8'])
    expect(VALIDATION_OUTCOMES).toEqual(['pass', 'fail', 'unknown'])

    expectTypeOf<CommandExecutionSource>().extract<'user-terminal'>().not.toBeNever()
    expectTypeOf<CommandTrustLevel>().extract<'app-enforced'>().not.toBeNever()
    expectTypeOf<CommandExecutionEvidence>().toHaveProperty('cwd')
    expectTypeOf<CommandTranscriptRef>().not.toHaveProperty('path')
    expectTypeOf<CommandTranscriptRef>().not.toHaveProperty('filePath')
  })

  it('解析完整证据并丢弃路径类与未知字段', () => {
    const parsed = parseCommandExecutionEvidence({
      ...validEvidence(),
      extra: true,
      _meta: { vendor: 'grok' },
      executable: '/usr/bin/pnpm',
      transcriptRef: {
        ...validTranscriptRef(),
        path: '/tmp/secret.log',
        filePath: '/Users/me/output.txt',
        absolutePath: 'C:\\\\logs\\\\out.txt'
      }
    })

    expect(parsed).toEqual({
      commandId: 'cmd-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      environmentId: 'env-1',
      source: 'app-runner',
      displayCommand: 'pnpm test',
      cwd: '.',
      startedAt: timestamp,
      endedAt: '2026-08-21T10:00:02.000Z',
      exitCode: 0,
      timedOut: false,
      status: 'succeeded',
      transcriptRef: {
        transcriptId: 'transcript-1',
        availableBytes: 128,
        totalBytes: 128,
        truncated: false,
        encoding: 'utf-8',
        retentionPolicy: 'bounded',
        retentionState: 'retained'
      },
      truncated: false,
      trustLevel: 'app-enforced'
    })
    expect(JSON.stringify(parsed)).not.toContain('/tmp/')
    expect(JSON.stringify(parsed)).not.toContain('/Users/')
    expect(structuredClone(parsed)).toEqual(parsed)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed)
  })

  it('cwd 必须是相对路径，拒绝绝对执行根与逃逸片段', () => {
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: 'src/tests' }))).not.toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: '/tmp/project' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: 'C:\\\\repo' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: 'C:/repo' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: '\\\\share\\repo' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: '../outside' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: 'src/../../etc' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ cwd: '' }))).toBeNull()
  })

  it('Runtime 证据不能伪装成 App 沙箱强制执行', () => {
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'runtime-tool',
          trustLevel: 'app-enforced'
        })
      )
    ).toBeNull()
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'user-terminal',
          trustLevel: 'app-enforced'
        })
      )
    ).toBeNull()
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'runtime-tool',
          trustLevel: 'runtime-reported',
          status: 'failed',
          exitCode: 1
        })
      )
    ).toMatchObject({ source: 'runtime-tool', trustLevel: 'runtime-reported' })
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'user-terminal',
          trustLevel: 'unverified',
          status: 'unknown-exit',
          exitCode: undefined
        })
      )
    ).toMatchObject({ source: 'user-terminal', trustLevel: 'unverified' })
  })

  it('退出码未知、仅标题、超时、取消和启动失败都有显式状态', () => {
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'runtime-tool',
          trustLevel: 'unverified',
          status: 'title-only',
          displayCommand: 'Tests passed',
          exitCode: undefined,
          endedAt: undefined
        })
      )
    ).toMatchObject({ status: 'title-only' })
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          status: 'unknown-exit',
          trustLevel: 'unverified',
          source: 'runtime-tool',
          exitCode: null
        })
      )
    ).toMatchObject({ status: 'unknown-exit' })
    expect(
      parseCommandExecutionEvidence(
        validEvidence({ status: 'timed-out', timedOut: true, exitCode: null })
      )
    ).toMatchObject({ status: 'timed-out', timedOut: true })
    expect(
      parseCommandExecutionEvidence(
        validEvidence({ status: 'cancelled', signal: 'SIGTERM', exitCode: null })
      )
    ).toMatchObject({ status: 'cancelled', signal: 'SIGTERM' })
    expect(
      parseCommandExecutionEvidence(
        validEvidence({ status: 'start-failed', exitCode: null, endedAt: timestamp })
      )
    ).toMatchObject({ status: 'start-failed' })
    expect(parseCommandExecutionEvidence(validEvidence({ status: 'success' }))).toBeNull()
  })

  it('status 必须与退出码和超时事实一致，禁止把未知退出标成 succeeded', () => {
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          status: 'succeeded',
          exitCode: undefined,
          trustLevel: 'unverified',
          source: 'runtime-tool'
        })
      )
    ).toBeNull()
    expect(
      parseCommandExecutionEvidence(validEvidence({ status: 'succeeded', timedOut: true }))
    ).toBeNull()
    expect(
      parseCommandExecutionEvidence(validEvidence({ status: 'succeeded', exitCode: 1 }))
    ).toBeNull()
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'runtime-tool',
          trustLevel: 'unverified',
          status: 'unknown-exit',
          exitCode: 0
        })
      )
    ).toBeNull()
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'runtime-tool',
          trustLevel: 'unverified',
          status: 'title-only',
          displayCommand: 'Tests passed',
          exitCode: 0
        })
      )
    ).toBeNull()
    expect(
      parseCommandExecutionEvidence(
        validEvidence({ status: 'timed-out', timedOut: false, exitCode: null })
      )
    ).toBeNull()
  })

  it('非法身份、超长字段或非对象返回 null', () => {
    expect(parseCommandExecutionEvidence(null)).toBeNull()
    expect(parseCommandExecutionEvidence('cmd')).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ commandId: '' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ commandId: 'a/b' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ commandId: 'a\\b' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ commandId: 'bad\0id' }))).toBeNull()
    expect(
      parseCommandExecutionEvidence(validEvidence({ displayCommand: oversizeAscii() }))
    ).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ timedOut: 'false' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ truncated: 1 }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ exitCode: 1.5 }))).toBeNull()
  })

  it('白名单保留可选 toolCallId/approvalId/inconsistency，拒绝路径身份', () => {
    expect(
      parseCommandExecutionEvidence(
        validEvidence({
          source: 'runtime-tool',
          trustLevel: 'runtime-reported',
          status: 'failed',
          exitCode: 1,
          toolCallId: 'tool-1',
          approvalId: 'permission-1',
          inconsistency: 'title-success-nonzero-exit',
          outputFileNotIngested: true
        })
      )
    ).toMatchObject({
      toolCallId: 'tool-1',
      approvalId: 'permission-1',
      inconsistency: 'title-success-nonzero-exit',
      outputFileNotIngested: true
    })
    expect(parseCommandExecutionEvidence(validEvidence({ toolCallId: '/tmp/tool' }))).toBeNull()
    expect(parseCommandExecutionEvidence(validEvidence({ approvalId: '..' }))).toBeNull()
    expect(
      parseCommandExecutionEvidence(validEvidence({ inconsistency: 'looks-successful-from-title' }))
    ).toBeNull()
  })

  it('transcript 引用区分 retained/expired/missing，且不接受文件路径当身份', () => {
    expect(parseCommandTranscriptRef(validTranscriptRef({ retentionState: 'expired' }))).toEqual({
      transcriptId: 'transcript-1',
      availableBytes: 128,
      totalBytes: 128,
      truncated: false,
      encoding: 'utf-8',
      retentionPolicy: 'bounded',
      retentionState: 'expired'
    })
    expect(
      parseCommandTranscriptRef(
        validTranscriptRef({
          truncated: true,
          availableBytes: 64,
          totalBytes: 1024,
          retentionState: 'missing',
          retentionPolicy: 'ephemeral'
        })
      )
    ).toMatchObject({
      truncated: true,
      availableBytes: 64,
      totalBytes: 1024,
      retentionState: 'missing',
      retentionPolicy: 'ephemeral'
    })
    expect(
      parseCommandTranscriptRef(validTranscriptRef({ transcriptId: '/tmp/out.log' }))
    ).toBeNull()
    expect(parseCommandTranscriptRef(validTranscriptRef({ availableBytes: -1 }))).toBeNull()
    expect(parseCommandTranscriptRef(validTranscriptRef({ encoding: 'latin1' }))).toBeNull()
  })
})

describe('ValidationResult 只能由命令证据推导', () => {
  it('全部已知成功终态且 exit 0 未超时则为 pass，截断不单独阻断', () => {
    const first = parseCommandExecutionEvidence(
      validEvidence({ truncated: true, transcriptRef: validTranscriptRef({ truncated: true }) })
    )
    const second = parseCommandExecutionEvidence(validEvidence({ commandId: 'cmd-2', cwd: 'src' }))
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    expect(deriveValidationResult([first!, second!], 'val-1')).toEqual({
      validationId: 'val-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      commandIds: ['cmd-1', 'cmd-2'],
      outcome: 'pass'
    })
  })

  it('工具标题写通过但缺少退出码时只能是 unknown，不能当 pass', () => {
    const evidence = parseCommandExecutionEvidence(
      validEvidence({
        source: 'runtime-tool',
        trustLevel: 'unverified',
        status: 'title-only',
        displayCommand: 'Tests passed',
        exitCode: undefined,
        truncated: false
      })
    )
    expect(evidence).not.toBeNull()
    expect(deriveValidationResult([evidence!], 'val-title')).toMatchObject({
      validationId: 'val-title',
      commandIds: ['cmd-1'],
      outcome: 'unknown'
    })
  })

  it('任一非零退出、超时或失败/取消终态则为 fail，且 fail 优先于 unknown', () => {
    const passed = parseCommandExecutionEvidence(validEvidence({ commandId: 'cmd-ok' }))
    const unknown = parseCommandExecutionEvidence(
      validEvidence({
        commandId: 'cmd-unknown',
        source: 'runtime-tool',
        trustLevel: 'unverified',
        status: 'unknown-exit',
        exitCode: undefined
      })
    )
    const failed = parseCommandExecutionEvidence(
      validEvidence({
        commandId: 'cmd-fail',
        status: 'failed',
        exitCode: 2
      })
    )
    expect(deriveValidationResult([passed!, unknown!, failed!], 'val-fail')).toMatchObject({
      outcome: 'fail',
      commandIds: ['cmd-ok', 'cmd-unknown', 'cmd-fail']
    })
    expect(
      deriveValidationResult(
        [
          parseCommandExecutionEvidence(
            validEvidence({ status: 'timed-out', timedOut: true, exitCode: 0 })
          )!
        ],
        'val-timeout'
      )
    ).toMatchObject({ outcome: 'fail', reason: 'timed-out' })
    expect(
      deriveValidationResult(
        [parseCommandExecutionEvidence(validEvidence({ status: 'cancelled', exitCode: 0 }))!],
        'val-cancel'
      )
    ).toMatchObject({ outcome: 'fail', reason: 'cancelled' })
    expect(
      deriveValidationResult(
        [parseCommandExecutionEvidence(validEvidence({ status: 'start-failed', exitCode: null }))!],
        'val-start'
      )
    ).toMatchObject({ outcome: 'fail', reason: 'start-failed' })
  })

  it('缺退出码或非成功终态为 unknown；空列表、跨 Turn 或非法 validationId 返回 null', () => {
    const missingExit = parseCommandExecutionEvidence(
      validEvidence({
        status: 'unknown-exit',
        exitCode: undefined,
        trustLevel: 'unverified',
        source: 'runtime-tool'
      })
    )
    expect(missingExit).not.toBeNull()
    expect(deriveValidationResult([missingExit!], 'val-unknown')).toMatchObject({
      outcome: 'unknown',
      reason: 'missing-exit-code'
    })
    expect(deriveValidationResult([], 'val-1')).toBeNull()
    expect(deriveValidationResult([parseCommandExecutionEvidence(validEvidence())!], '')).toBeNull()
    expect(
      deriveValidationResult(
        [
          parseCommandExecutionEvidence(validEvidence())!,
          parseCommandExecutionEvidence(validEvidence({ commandId: 'cmd-2', turnId: 'turn-2' }))!
        ],
        'val-1'
      )
    ).toBeNull()
  })

  it('解析 ValidationResult 时拒绝空 commandIds，并丢弃聊天文案字段', () => {
    expect(
      parseValidationResult({
        validationId: 'val-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        commandIds: ['cmd-1'],
        outcome: 'pass',
        chatText: 'all tests passed',
        title: 'Tests passed'
      })
    ).toEqual({
      validationId: 'val-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      commandIds: ['cmd-1'],
      outcome: 'pass'
    })
    expect(
      parseValidationResult({
        validationId: 'val-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        commandIds: [],
        outcome: 'pass'
      })
    ).toBeNull()
    expect(
      parseValidationResult({
        validationId: 'val-1',
        taskId: 'task-1',
        turnId: 'turn-1',
        commandIds: ['cmd-1'],
        outcome: 'pass',
        reason: 'all tests passed in chat'
      })
    ).toEqual({
      validationId: 'val-1',
      taskId: 'task-1',
      turnId: 'turn-1',
      commandIds: ['cmd-1'],
      outcome: 'pass'
    })
  })
})

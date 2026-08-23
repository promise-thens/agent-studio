import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CommandExecutionEvidence } from '../../shared/command'
import {
  commandCwdLabel,
  commandInconsistencyLabel,
  commandSourceLabel,
  commandTrustLabel,
  presentCommandEvidenceSummary,
  toCommandEvidenceView
} from './command-evidence-presentation'

function evidence(overrides: Partial<CommandExecutionEvidence> = {}): CommandExecutionEvidence {
  return {
    commandId: 'cmd-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    environmentId: 'env-1',
    source: 'app-runner',
    displayCommand: 'pnpm test',
    cwd: '.',
    startedAt: '2026-08-22T10:00:00.000Z',
    endedAt: '2026-08-22T10:00:01.200Z',
    exitCode: 0,
    timedOut: false,
    status: 'succeeded',
    transcriptRef: {
      transcriptId: 'transcript-1',
      availableBytes: 2,
      truncated: false,
      encoding: 'utf-8',
      retentionPolicy: 'bounded',
      retentionState: 'retained'
    },
    truncated: false,
    trustLevel: 'app-enforced',
    ...overrides
  }
}

describe('命令证据展示文案', () => {
  it('区分 App 自有命令与 Runtime 上报，且 Runtime 文案不含沙箱或 Broker 强制', () => {
    expect(commandSourceLabel('app-runner')).toBe('App 自有命令')
    expect(commandSourceLabel('runtime-tool')).toBe('Runtime 上报命令')
    expect(commandTrustLabel('app-enforced')).toBe('App 强制边界')
    expect(commandTrustLabel('runtime-reported')).toBe('Runtime 上报事实')
    expect(commandSourceLabel('runtime-tool')).not.toMatch(/沙箱|Broker/)
    expect(commandTrustLabel('runtime-reported')).not.toMatch(/沙箱|Broker 强制|App 强制/)
    expect(commandCwdLabel('runtime-tool', '.')).toBe(
      'Runtime 未冻结工作目录（相对路径 .，并非 App 沙箱）'
    )
    expect(commandCwdLabel('app-runner', '.')).toBe('执行根目录（相对路径 .）')
    expect(commandCwdLabel('runtime-tool', '.')).not.toMatch(/App 沙箱执行|Broker/)
  })

  it('截断或非 retained 时明确说明日志不完整', () => {
    const truncated = toCommandEvidenceView(
      evidence({
        source: 'runtime-tool',
        trustLevel: 'runtime-reported',
        truncated: true,
        transcriptRef: {
          transcriptId: 'transcript-1',
          availableBytes: 2,
          truncated: true,
          encoding: 'utf-8',
          retentionPolicy: 'bounded',
          retentionState: 'retained'
        }
      })
    )
    const missing = toCommandEvidenceView(
      evidence({
        transcriptRef: {
          transcriptId: 'transcript-1',
          availableBytes: 0,
          truncated: false,
          encoding: 'utf-8',
          retentionPolicy: 'bounded',
          retentionState: 'missing'
        }
      })
    )
    expect(truncated.logIncomplete).toBe(true)
    expect(truncated.logIncompleteReason).toBe('输出已截断，日志不完整')
    expect(missing.logIncompleteReason).toBe('日志缺失，不完整')
    expect(presentCommandEvidenceSummary(truncated)).toContain('日志不完整')
    expect(presentCommandEvidenceSummary(truncated)).not.toContain('stdout')
  })

  it('对话暂不挂载结果审阅卡片', () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const conversation = readFileSync(join(root, 'components/TaskConversation.vue'), 'utf8')
    expect(conversation).not.toContain('TaskResultReview')
    expect(conversation).not.toContain('结果审阅')
  })

  it('结果审阅展示命令事实，不把 Runtime 命令写成 App 沙箱', () => {
    const root = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(join(root, 'components/TaskResultReview.vue'), 'utf8')
    expect(source).toContain('command.displayCommand')
    expect(source).toContain('command.sourceLabel')
    expect(source).toContain('command.cwdLabel')
    expect(source).toContain('command.trustLabel')
    expect(source).toContain('exitCodeLabel(command)')
    expect(source).toContain('durationLabel(command)')
    expect(source).toContain('command.timedOut')
    expect(source).toContain('command.truncated')
    expect(source).toContain('command.logIncomplete')
    expect(source).toContain('command.inconsistency')
    expect(source).not.toContain('继续任务')
  })

  it('标题与退出事实冲突时摘要和审阅都要写出不一致', () => {
    const view = toCommandEvidenceView(
      evidence({
        source: 'runtime-tool',
        trustLevel: 'runtime-reported',
        status: 'failed',
        exitCode: 2,
        inconsistency: 'title-success-nonzero-exit'
      })
    )
    expect(view.inconsistency).toBe('title-success-nonzero-exit')
    expect(commandInconsistencyLabel('title-success-nonzero-exit')).toMatch(/不一致|退出/)
    expect(presentCommandEvidenceSummary(view)).toMatch(/不一致|退出码 2/)
  })
})

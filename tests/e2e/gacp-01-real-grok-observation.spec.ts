import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { renderGacp01ObservationMarkdown } from '../../src/main/runtime/grok/gacp01-observation-report'
import {
  allowPendingPermissions,
  capabilitySupport,
  connectFirstProject,
  hashGrokConfig,
  isGacp01ObserveEnabled,
  launchGacp01ObserveApp,
  readProtocolRecords,
  resumeTask,
  runTurn,
  saveProviderFromEnv
} from './gacp-01-observe-electron'

const repositoryRoot = resolve(process.cwd())
const observationDoc = join(
  repositoryRoot,
  'docs/superpowers/plans/grokACP计划/observations/grok-acp-observation.md'
)
const observationJson = join(
  repositoryRoot,
  'docs/superpowers/plans/grokACP计划/observations/grok-acp-observation.last-run.json'
)

test.describe('GACP-01 真机 Grok 正式产品路径观察', () => {
  test.skip(!isGacp01ObserveEnabled(), '设置 GACP01_REAL_GROK=1 且不要在 CI 运行')

  test('connect → Task A 两轮 → Task B → 回 A → 权限/取消', async () => {
    const hashBefore = hashGrokConfig()
    const context = await launchGacp01ObserveApp()
    try {
      await saveProviderFromEnv(context.page)
      const { projectId, status } = await connectFirstProject(context.page)
      expect(status.state).toBe('ready')

      const first = await runTurn(
        context.page,
        projectId,
        undefined,
        '阅读 README.md，列出三条要点。先给出计划，再给出结论；不要修改文件。',
        context
      )
      const second = await runTurn(
        context.page,
        projectId,
        first.taskId,
        '基于刚才的结论，用两句话说明下一步建议；不要修改文件。',
        context
      )
      expect(second.taskId).toBe(first.taskId)

      const taskB = await runTurn(
        context.page,
        projectId,
        undefined,
        '只回答：当前项目有几个 markdown 文件？不要修改文件。',
        context
      )
      const resumed = await resumeTask(context.page, first.taskId)

      await runTurn(
        context.page,
        projectId,
        undefined,
        '在 scratch/gacp01-observe.txt 写入一行 GACP01_OK，操作前必须请求确认。',
        context
      )
      if (context.permissions.length > 0) {
        await allowPendingPermissions(context.page, context.permissions.splice(0))
      }

      const cancelTask = await context.page.evaluate(async (id) => {
        const created = await window.agent.createTask(id)
        if (!created.ok) throw new Error(created.error?.message ?? '创建取消 Task 失败')
        return created.value.taskId
      }, projectId)
      const admitted = await context.page.evaluate(
        async ([taskId]) =>
          window.agent.startTurn(taskId, '请先慢慢分析 README.md，分十步说明，不要修改文件。'),
        [cancelTask] as const
      )
      expect(admitted.ok).toBe(true)
      const snapshot = await context.page.evaluate(async () => window.agent.getExecutionSnapshot())
      if (snapshot.ok && snapshot.value.execution) {
        await context.page.evaluate(async (request) => window.agent.cancelTurn(request), {
          executionId: snapshot.value.execution.executionId,
          taskId: snapshot.value.execution.taskId,
          turnId: snapshot.value.execution.turnId
        })
      }

      const records = await readProtocolRecords(context.layout)
      const hashAfter = hashGrokConfig()
      const report = {
        product: {
          commit: readCommit(),
          grokCliVersion: readGrokVersion(),
          nodeVersion: process.version,
          pnpmVersion: readPnpmVersion(),
          electronVersion: readElectronVersion(),
          sdkVersion: readSdkVersion(),
          protocolVersionConstant: '1',
          connectState: status.state,
          connectMessage: status.message,
          runtimeVersion: status.capabilitySnapshot?.runtimeVersion,
          protocolVersion: status.capabilitySnapshot?.protocolVersion,
          sessionCreate: capabilitySupport(status, 'session.create'),
          sessionResume: capabilitySupport(status, 'session.resume'),
          sessionLoad: capabilitySupport(status, 'session.load'),
          taskATurn1State: first.snapshot.execution?.state,
          taskATurn2State: second.snapshot.execution?.state,
          taskBState: taskB.snapshot.execution?.state,
          resumeMethod: resumed.method,
          publicEventKinds: [...new Set(context.events.map((event) => event.kind))],
          permissionDecisions:
            context.permissions.length > 0 ? ['pending-left'] : ['allow-once-or-none'],
          grokConfigHashBefore: hashBefore,
          grokConfigHashAfter: hashAfter
        },
        records
      }
      const serialized = JSON.stringify(report, null, 2)
      expect(serialized).not.toMatch(/sk-[A-Za-z0-9]+/)
      expect(serialized).not.toContain('Bearer ')
      await writeFile(observationJson, `${serialized}\n`, 'utf8')
      await writeFile(observationDoc, renderGacp01ObservationMarkdown(report), 'utf8')
      expect(first.snapshot.execution?.state).toBeTruthy()
      expect(
        records.some((record) => record.kind === 'initialize' || record.kind === 'session-op')
      ).toBe(true)
    } finally {
      await context.close()
    }
  })
})

function readCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function readGrokVersion(): string {
  try {
    return execFileSync('grok', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return 'grok-not-found'
  }
}

function readPnpmVersion(): string {
  try {
    return execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function readElectronVersion(): string {
  try {
    return execFileSync(
      'node',
      ['-e', "console.log(require('./node_modules/electron/package.json').version)"],
      { encoding: 'utf8', cwd: repositoryRoot }
    ).trim()
  } catch {
    return 'unknown'
  }
}

function readSdkVersion(): string {
  try {
    return execFileSync(
      'node',
      [
        '-e',
        "console.log(require('./node_modules/@agentclientprotocol/sdk/package.json').version)"
      ],
      { encoding: 'utf8', cwd: repositoryRoot }
    ).trim()
  } catch {
    return 'unknown'
  }
}

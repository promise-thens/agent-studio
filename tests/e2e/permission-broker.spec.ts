import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CONTROLLED_ACP_E2E_ADAPTER_TRACE_FILE,
  CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE
} from '../../src/main/runtime/grok/controlled-acp-fixture'
import {
  expectControlledMarker as expectMarker,
  launchControlledScenario as launchScenario,
  prepareControlledWorkbench as prepareWorkbench,
  startControlledPrompt as startScenarioPrompt,
  waitForExecutionTerminal,
  writeControlledBarrier,
  type ControlledElectronScenarioContext as ScenarioContext,
  type ControlledLayout,
  type TraceRecord
} from './controlled-electron-fixture'

const rawInputSentinel = 'E2E_RAW_INPUT_MUST_NOT_DISPLAY'

type CapturedPermission = {
  approvalId: string
  taskId: string
  turnId: string
  title: string
}

test.describe('受控 ACP Runtime Electron E2E', () => {
  test('FIFO：两项请求先到达，UI 按 A→B 决策且审计顺序正确', async () => {
    const context = await launchScenario('E2E:FIFO')
    try {
      await prepareWorkbench(context)
      await startScenarioPrompt(context.page, '受控 FIFO 场景')

      await waitForFixtureEvents(context.layout, (records) =>
        hasFixtureEvents(records, ['permission-dispatched:A', 'permission-dispatched:B'])
      )
      await waitForAdapterEvents(context.layout, ['fifo-A', 'fifo-B'], 'adapter-permission-pending')

      const dialog = context.page.getByRole('dialog', { name: '需要你的确认' })
      await expect(dialog).toContainText('写入受控 marker A')
      await dialog.getByRole('button', { name: '仅允许这一次' }).click()
      await expect(dialog).toContainText('写入受控 marker B')
      await dialog.getByRole('button', { name: '拒绝', exact: true }).click()
      await expect(dialog).toHaveCount(0)

      await waitForFixtureEvents(context.layout, (records) =>
        hasFixtureEvents(records, [
          'permission-resolved:A:selected:allow-fifo-A',
          'permission-resolved:B:selected:reject-fifo-B'
        ])
      )
      await expectMarker(context.layout, 'A\n')

      const fixtureTrace = await readTrace(context.layout, CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE)
      const dispatchedA = findFixtureEvent(fixtureTrace, 'permission-dispatched', 'A')
      const dispatchedB = findFixtureEvent(fixtureTrace, 'permission-dispatched', 'B')
      const resolvedA = findFixtureEvent(fixtureTrace, 'permission-resolved', 'A')
      expect(dispatchedA.sequence).toBeLessThan(resolvedA.sequence)
      expect(dispatchedB.sequence).toBeLessThan(resolvedA.sequence)

      const taskId = await waitForTaskId(context.page)
      const audits = await waitForAudits(
        context.page,
        taskId,
        (items) => items.filter((item) => item.operationType === 'write-file').length === 2
      )
      const writeAudits = audits.filter((item) => item.operationType === 'write-file')
      expect(writeAudits.map((item) => item.reason)).toEqual(
        expect.arrayContaining(['user-allowed', 'user-denied'])
      )
      expect(writeAudits.every((item) => item.risk === 'L1')).toBe(true)
      expect(writeAudits.find((item) => item.reason === 'user-allowed')?.scope).toBe('once')
      await waitForExecutionTerminal(context.page)
    } finally {
      await context.close()
    }
  })

  test('ToolCall 取消：仅撤销 A，B 保留，A 的晚到响应不可复活', async () => {
    const context = await launchScenario('E2E:TOOLCALL_CANCEL')
    try {
      await prepareWorkbench(context)
      await capturePermissionRequests(context.page)
      await startScenarioPrompt(context.page, '受控 ToolCall 精确取消场景')

      await waitForAdapterEvents(
        context.layout,
        ['toolcall-A', 'toolcall-B'],
        'adapter-permission-pending'
      )
      const requestA = await waitForCapturedPermission(context.page, '写入受控 marker A')
      const dialog = context.page.getByRole('dialog', { name: '需要你的确认' })
      await expect(dialog).toContainText('写入受控 marker A')

      // 仅向隔离的 fixture barrier 写入固定文件，不解析或执行任何用户输入。
      await writeControlledBarrier(context.layout, 'toolcall-cancel-A')
      await waitForAdapterEvents(context.layout, ['toolcall-A'], 'adapter-permission-cancelled')
      await expect(dialog).toContainText('写入受控 marker B')

      const lateResponse = await context.page.evaluate(
        async (request) => window.agent.respondPermission({ ...request, decision: 'allow-once' }),
        requestA
      )
      expect(lateResponse).toEqual({ ok: true, value: null })
      await expect(dialog).toContainText('写入受控 marker B')
      await dialog.getByRole('button', { name: '仅允许这一次' }).click()
      await expect(dialog).toHaveCount(0)

      await waitForFixtureEvents(context.layout, (records) =>
        hasFixtureEvents(records, [
          'permission-resolved:A:cancelled',
          'permission-resolved:B:selected:allow-toolcall-B'
        ])
      )
      await expectMarker(context.layout, 'B\n')

      const taskId = await waitForTaskId(context.page)
      const audits = await waitForAudits(
        context.page,
        taskId,
        (items) => items.filter((item) => item.operationType === 'write-file').length === 2
      )
      const writeAudits = audits.filter((item) => item.operationType === 'write-file')
      expect(writeAudits.map((item) => item.reason)).toEqual(
        expect.arrayContaining(['cancelled', 'user-allowed'])
      )
      expect(writeAudits.find((item) => item.reason === 'cancelled')?.scope).toBeUndefined()
      await waitForExecutionTerminal(context.page)
    } finally {
      await context.close()
    }
  })

  test('Timeline：持久化 Tool、权限审计与完成态在历史回放中投影正确', async () => {
    const context = await launchScenario('E2E:TOOLCALL_CANCEL')
    try {
      await prepareWorkbench(context)
      const prompt = '受控 Timeline ToolCall 场景'
      await startScenarioPrompt(context.page, prompt)

      await waitForAdapterEvents(
        context.layout,
        ['toolcall-A', 'toolcall-B'],
        'adapter-permission-pending'
      )
      const dialog = context.page.getByRole('dialog', { name: '需要你的确认' })
      await expect(dialog).toContainText('写入受控 marker A')
      await writeControlledBarrier(context.layout, 'toolcall-cancel-A')
      await waitForAdapterEvents(context.layout, ['toolcall-A'], 'adapter-permission-cancelled')
      await expect(dialog).toContainText('写入受控 marker B')
      await dialog.getByRole('button', { name: '仅允许这一次' }).click()

      await waitForFixtureEvents(context.layout, (records) =>
        hasFixtureEvents(records, [
          'permission-resolved:A:cancelled',
          'permission-resolved:B:selected:allow-toolcall-B'
        ])
      )
      await expectMarker(context.layout, 'B\n')
      const terminal = await waitForExecutionTerminal(context.page)
      expect(terminal.execution?.state).toBe('completed')

      const taskId = await waitForTaskId(context.page)
      const audits = await waitForAudits(
        context.page,
        taskId,
        (items) => items.filter((item) => item.operationType === 'write-file').length === 2
      )
      expect(audits.map((item) => item.reason)).toEqual(
        expect.arrayContaining(['cancelled', 'user-allowed'])
      )

      const projectId = await projectIdForTask(context.page, taskId)
      await selectSidebarTaskById(context.page, projectId, taskId)
      await expect(context.page.getByRole('button', { name: '继续任务', exact: true })).toHaveCount(0)

      const timeline = context.page.getByRole('region', { name: '执行时间线' })
      const turn = timeline
        .locator('article.timeline-turn[data-status="completed"]')
        .filter({ hasText: prompt })
      await expect(turn).toHaveCount(1)
      await expect(turn.locator('.timeline-prompt')).toHaveText(prompt)
      await expect(turn.locator('.timeline-node[data-kind="tool"]')).toContainText('toolcall-A')
      await expect(turn.locator('.timeline-node[data-kind="tool"]')).toContainText('completed')
      await expect(turn.locator('.timeline-node[data-kind="permission-audit"]')).toHaveCount(2)
      await expect(turn.locator('.timeline-node[data-kind="turn-complete"]')).toContainText(
        'completed'
      )
      await expect(context.page.getByRole('region', { name: '结果审阅' })).toContainText(
        'completed'
      )

      // 切到没有 Task 的 Project 时，旧 Task 的 Timeline 与结果审阅不得继续显示。
      const secondaryProject = context.page
        .locator('section[aria-label="项目"]')
        .getByTitle(context.layout.secondaryWorkspace, { exact: true })
      await secondaryProject.click()
      await expect(secondaryProject).toHaveClass(/active/)
      await expect(context.page.getByRole('region', { name: '执行时间线' })).toHaveCount(0)
      await expect(context.page.getByRole('region', { name: '结果审阅' })).toHaveCount(0)

      const primaryProject = context.page
        .locator('section[aria-label="项目"]')
        .getByTitle(context.layout.workspace, { exact: true })
      await primaryProject.click()
      await expect(primaryProject).toHaveClass(/active/)
      await selectSidebarTaskById(context.page, projectId, taskId)
      await expect(context.page.getByRole('region', { name: '执行时间线' })).toBeVisible()
      await expect(context.page.getByRole('region', { name: '结果审阅' })).toBeVisible()

      // 新 Task 没有 Timeline facts，不能沿用刚才历史 Task 的可见内容。
      await context.page.getByRole('button', { name: '创建新 Task', exact: true }).click()
      await expect(context.page.getByRole('region', { name: '执行时间线' })).toHaveCount(0)
      await expect(context.page.getByRole('region', { name: '结果审阅' })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })
  test('Turn 取消：真实停止操作清空队列、发送同 session cancel 且不写 marker', async () => {
    const context = await launchScenario('E2E:TURN_CANCEL')
    try {
      await prepareWorkbench(context)
      await startScenarioPrompt(context.page, '受控 Turn 精确取消场景')

      await waitForFixtureEvents(context.layout, (records) =>
        hasFixtureEvents(records, ['permission-dispatched:execute'])
      )
      await waitForAdapterEvents(
        context.layout,
        ['turn-cancel-execute'],
        'adapter-permission-pending'
      )
      const dialog = context.page.getByRole('dialog', { name: '需要你的确认' })
      await expect(dialog).toContainText('执行命令')
      await dialog.getByRole('button', { name: '停止', exact: true }).click()

      await waitForFixtureEvents(context.layout, (records) =>
        records.some(
          (record) =>
            record.event === 'session-cancelled' && record.sessionId === 'controlled-acp-session'
        )
      )
      await expect(dialog).toHaveCount(0)
      await expectMarker(context.layout, 'unchanged\n')

      const taskId = await waitForTaskId(context.page)
      const audits = await waitForAudits(context.page, taskId, (items) =>
        items.some(
          (item) =>
            item.operationType === 'execute-command' &&
            item.risk === 'L3' &&
            item.reason === 'cancelled'
        )
      )
      expect(
        audits.some(
          (item) => item.operationType === 'execute-command' && item.reason === 'user-allowed'
        )
      ).toBe(false)
      await waitForExecutionTerminal(context.page)
    } finally {
      await context.close()
    }
  })

  test('Execute/unsupported：合法 L3 仅允许一次，畸形 options 不弹窗且审计 unsupported', async () => {
    const context = await launchScenario('E2E:EXECUTE_UNSUPPORTED')
    try {
      await prepareWorkbench(context)
      await capturePermissionRequests(context.page)
      await startScenarioPrompt(context.page, '受控 execute 与 unsupported 场景')

      const dialog = context.page.getByRole('dialog', { name: '需要你的确认' })
      await expect(dialog).toContainText('执行命令')
      await expect(dialog).toContainText('L3 高风险')
      await expect(dialog).toContainText('只能允许本次')
      await expect(dialog).not.toContainText(rawInputSentinel)
      await expect(dialog.getByRole('button', { name: '允许当前 Task' })).toHaveCount(0)
      await dialog.getByRole('button', { name: '仅允许这一次' }).click()
      await expect(dialog).toHaveCount(0)

      await waitForFixtureEvents(context.layout, (records) =>
        hasFixtureEvents(records, [
          'permission-resolved:legal-execute:selected:allow-execute-legal',
          'permission-resolved:missing-allow-once:cancelled',
          'permission-resolved:duplicate-allow-once:cancelled'
        ])
      )
      await expect(context.page.getByRole('dialog', { name: '需要你的确认' })).toHaveCount(0)
      expect(await capturedPermissionTitles(context.page)).toEqual(['执行受控命令'])
      await expectMarker(context.layout, 'unchanged\n')

      const taskId = await waitForTaskId(context.page)
      const audits = await waitForAudits(
        context.page,
        taskId,
        (items) =>
          items.filter(
            (item) => item.operationType === 'execute-command' && item.reason === 'unsupported'
          ).length === 2
      )
      const executeAudits = audits.filter((item) => item.operationType === 'execute-command')
      expect(executeAudits.every((item) => item.risk === 'L3')).toBe(true)
      expect(executeAudits.filter((item) => item.reason === 'unsupported')).toHaveLength(2)
      expect(executeAudits.find((item) => item.reason === 'user-allowed')?.scope).toBe('once')
      await waitForExecutionTerminal(context.page)
    } finally {
      await context.close()
    }
  })
})

/** 根据公开历史查询 Task 所属 Project，侧栏回放仍只走正式 UI 路径。 */
async function projectIdForTask(page: ScenarioContext['page'], taskId: string): Promise<string> {
  const projectId = await page.evaluate(async (currentTaskId) => {
    const projects = await window.app.listProjects()
    if (!projects.ok) return undefined
    for (const project of projects.value) {
      const tasks = await window.task.list(project.projectId, undefined, 50)
      if (tasks.ok && tasks.value.items.some((task) => task.taskId === currentTaskId)) {
        return project.projectId
      }
    }
    return undefined
  }, taskId)
  if (!projectId) throw new Error('未找到受控 Task 所属 Project。')
  return projectId
}

/** 使用持久化顺序定位当前 Task，避免随机 taskId 成为 DOM 选择器。 */
async function selectSidebarTaskById(
  page: ScenarioContext['page'],
  projectId: string,
  taskId: string
): Promise<void> {
  const index = await page.evaluate(
    async ({ currentProjectId, currentTaskId }) => {
      const result = await window.task.list(currentProjectId, undefined, 50)
      if (!result.ok) return -1
      return result.value.items.findIndex((task) => task.taskId === currentTaskId)
    },
    { currentProjectId: projectId, currentTaskId: taskId }
  )
  if (index < 0) throw new Error('侧栏中未找到受控 Task。')
  const item = page.locator('section[aria-label="任务"] .session-item').nth(index)
  await expect(item).toBeVisible()
  await item.click()
  await expect(item).toHaveClass(/active/)
}

async function capturePermissionRequests(page: ScenarioContext['page']): Promise<void> {
  await page.evaluate(() => {
    const target = window as typeof window & {
      __controlledPermissionRequests?: CapturedPermission[]
    }
    target.__controlledPermissionRequests = []
    window.agent.onPermission((request) => {
      target.__controlledPermissionRequests?.push({
        approvalId: request.approvalId,
        taskId: request.taskId,
        turnId: request.turnId,
        title: request.title
      })
    })
  })
}

async function waitForCapturedPermission(
  page: ScenarioContext['page'],
  title: string
): Promise<CapturedPermission> {
  let captured: CapturedPermission | undefined
  await expect
    .poll(async () => {
      captured = await page.evaluate((expectedTitle) => {
        const target = window as typeof window & {
          __controlledPermissionRequests?: CapturedPermission[]
        }
        return target.__controlledPermissionRequests?.find(
          (request) => request.title === expectedTitle
        )
      }, title)
      return captured?.approvalId ?? null
    })
    .not.toBeNull()
  return captured!
}

async function capturedPermissionTitles(page: ScenarioContext['page']): Promise<string[]> {
  return page.evaluate(() => {
    const target = window as typeof window & {
      __controlledPermissionRequests?: CapturedPermission[]
    }
    return target.__controlledPermissionRequests?.map((request) => request.title) ?? []
  })
}

/** 只通过既有 window.app/window.task 读取 Project、Task 和已持久化审计，不新增测试调试接口。 */
async function waitForTaskId(page: ScenarioContext['page']): Promise<string> {
  let taskId: string | undefined
  await expect
    .poll(async () => {
      taskId = await page.evaluate(async () => {
        const projects = await window.app.listProjects()
        if (!projects.ok) return undefined

        // 受控启动会注册多个 Project；逐个查询，返回实际持有本次 Task 的 Project。
        for (const project of projects.value) {
          const tasks = await window.task.list(project.projectId)
          if (tasks.ok && tasks.value.items[0]) return tasks.value.items[0].taskId
        }
        return undefined
      })
      return taskId ?? null
    })
    .not.toBeNull()
  return taskId!
}

async function waitForAudits(
  page: ScenarioContext['page'],
  taskId: string,
  predicate: (
    items: Array<{ operationType: string; reason: string; risk: string; scope?: string }>
  ) => boolean
): Promise<Array<{ operationType: string; reason: string; risk: string; scope?: string }>> {
  let audits: Array<{ operationType: string; reason: string; risk: string; scope?: string }> = []
  await expect
    .poll(async () => {
      const result = await page.evaluate(
        async (currentTaskId) => window.task.listPermissionAudits(currentTaskId),
        taskId
      )
      audits = result.ok ? result.value.items : []
      return predicate(audits)
    })
    .toBe(true)
  return audits
}

async function waitForAdapterEvents(
  layout: ControlledLayout,
  toolCallIds: string[],
  event: string
): Promise<void> {
  await expect
    .poll(async () => {
      const records = await readTrace(layout, CONTROLLED_ACP_E2E_ADAPTER_TRACE_FILE)
      return toolCallIds.every((toolCallId) =>
        records.some((record) => record.event === event && record.toolCallId === toolCallId)
      )
    })
    .toBe(true)
}

async function waitForFixtureEvents(
  layout: ControlledLayout,
  predicate: (records: TraceRecord[]) => boolean
): Promise<void> {
  await expect
    .poll(async () => predicate(await readTrace(layout, CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE)))
    .toBe(true)
}

/** fixture trace 使用单进程串行序号；只比较固定事件，绝不读取或记录 Prompt、环境和 Provider 数据。 */
function hasFixtureEvents(records: TraceRecord[], expected: string[]): boolean {
  return expected.every((entry) => {
    const firstSeparator = entry.indexOf(':')
    const secondSeparator = entry.indexOf(':', firstSeparator + 1)
    const event = entry.slice(0, firstSeparator)
    const request =
      secondSeparator < 0
        ? entry.slice(firstSeparator + 1)
        : entry.slice(firstSeparator + 1, secondSeparator)
    const outcome = secondSeparator < 0 ? undefined : entry.slice(secondSeparator + 1)
    return records.some(
      (record) =>
        record.event === event &&
        record.request === request &&
        (outcome === undefined || record.outcome === outcome)
    )
  })
}

function findFixtureEvent(
  records: TraceRecord[],
  event: string,
  request: string
): TraceRecord & { sequence: number } {
  const record = records.find((item) => item.event === event && item.request === request)
  if (!record || typeof record.sequence !== 'number') {
    throw new Error(`缺少受控 fixture trace：${event}:${request}`)
  }
  return record as TraceRecord & { sequence: number }
}

async function readTrace(layout: ControlledLayout, file: string): Promise<TraceRecord[]> {
  try {
    const text = await readFile(join(layout.traceDirectory, file), 'utf8')
    return text.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        const record = JSON.parse(line)
        return record && typeof record === 'object' && !Array.isArray(record)
          ? [record as TraceRecord]
          : []
      } catch {
        // 读取恰好落在 append 中间时只忽略这一次轮询，下一次会取得完整 JSONL 行。
        return []
      }
    })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

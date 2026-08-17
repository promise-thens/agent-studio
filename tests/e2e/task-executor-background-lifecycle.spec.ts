import { expect, test, type Page } from '@playwright/test'
import { basename } from 'node:path'
import type { TaskExecutionSnapshot } from '../../src/shared/task-execution'
import {
  expectControlledMarker,
  launchControlledScenario,
  prepareControlledWorkbench,
  readControlledTrace,
  startControlledPrompt,
  waitForExecutionState,
  waitForExecutionTerminal,
  waitForFixtureTrace,
  writeControlledBarrier,
  type ControlledElectronScenarioContext,
  type ControlledLayout,
  type TraceRecord
} from './controlled-electron-fixture'

interface ControlledProjects {
  primaryProjectId: string
  secondaryProjectId: string
}

interface PreparedTaskPair extends ControlledProjects {
  taskAId: string
  taskBId: string
}

interface SessionTraceSummary {
  created: number
  resumed: number
  loaded: number
  cancelled: number
}

test.describe('P0-08 Task Executor 后台生命周期 Electron E2E', () => {
  test('空闲退出：清理完成后 Main 进程必须真正结束', async () => {
    const context = await launchControlledScenario('E2E:LONG_RUNNING')
    try {
      await expect.poll(() => context.provider.requestCount).toBe(1)
      const child = context.app.process()
      const quitting = context.app.evaluate(({ app }) => app.quit()).catch(() => undefined)
      await expect.poll(() => child.exitCode, { timeout: 15_000 }).not.toBeNull()
      await quitting
    } finally {
      await context.close()
    }
  })

  test('长任务：浏览其他 Task/Project 与 reload 不改变执行身份，barrier 后可信完成', async () => {
    const context = await launchControlledScenario('E2E:LONG_RUNNING')
    try {
      const pair = await prepareTaskPairAndResumeA(context)
      const prompt = '生命周期长任务 A'
      await startControlledPrompt(context.page, prompt)
      await waitForFixtureEvent(context.layout, 'long-running-waiting')

      const running = await waitForExecutionState(
        context.page,
        (snapshot) => snapshot.execution?.state === 'running'
      )
      expect(running.execution).toMatchObject({ taskId: pair.taskAId, state: 'running' })
      const baseline = summarizeSessionTrace(await readControlledTrace(context.layout))
      expect(baseline).toEqual({ created: 2, resumed: 1, loaded: 0, cancelled: 0 })

      await expectExecutionMutationsDisabled(context.page)
      await selectSidebarTaskByTitle(context.page, '新任务')
      await expect(context.page.getByText('只读历史', { exact: true })).toBeVisible()
      await expect(context.page.getByTitle(`停止 Task ${pair.taskAId}`)).toBeVisible()
      await expectSameExecution(context.page, running)

      await selectSidebarProject(context.page, context.layout.secondaryWorkspace)
      await expect(context.page.locator('.status-chip')).toContainText('后台执行中')
      await expectSameExecution(context.page, running)
      expect(summarizeSessionTrace(await readControlledTrace(context.layout))).toEqual(baseline)

      // reload 只重建 Renderer 消费者；活动 execution 仍由 Main snapshot 恢复，不触发 session 恢复。
      await context.page.reload({ waitUntil: 'domcontentloaded' })
      await expect(context.page.locator('.status-chip')).toContainText('后台执行中')
      await expect(context.page.getByTitle(`停止 Task ${pair.taskAId}`)).toBeVisible()
      await expectSameExecution(context.page, running)

      await selectSidebarProject(context.page, context.layout.workspace)
      await selectSidebarTaskByTitle(context.page, prompt)
      await expect(context.page.getByText('只读历史', { exact: true })).toHaveCount(0)
      await expect(context.page.locator('.status-chip')).toContainText('执行中')
      expect(summarizeSessionTrace(await readControlledTrace(context.layout))).toEqual(baseline)

      await writeControlledBarrier(context.layout, 'long-running-release')
      const terminal = await waitForExecutionTerminal(context.page)
      expect(terminal.execution).toMatchObject({ taskId: pair.taskAId, state: 'completed' })
      await expect(context.page.locator('.status-chip[data-state="ready"]')).toContainText('已连接')
      expect(summarizeSessionTrace(await readControlledTrace(context.layout))).toEqual(baseline)
    } finally {
      await context.close()
    }
  })

  test('等待审批：查看 B 与其他 Project 时审批仍绑定 A，允许后写 marker 并完成', async () => {
    const context = await launchControlledScenario('E2E:PERMISSION_WAIT')
    try {
      const pair = await prepareTaskPairWithLiveA(context)
      const prompt = '生命周期审批任务 A'
      await startControlledPrompt(context.page, prompt)

      const waiting = await waitForExecutionState(
        context.page,
        (snapshot) =>
          snapshot.execution?.state === 'waiting-permission' &&
          snapshot.execution.pendingPermissionCount === 1
      )
      expect(waiting.execution).toMatchObject({ taskId: pair.taskAId, state: 'waiting-permission' })
      const baseline = summarizeSessionTrace(await readControlledTrace(context.layout))
      expect(baseline).toEqual({ created: 2, resumed: 0, loaded: 0, cancelled: 0 })

      const dialog = context.page.getByRole('dialog', { name: '需要你的确认' })
      await expect(dialog).toContainText('写入生命周期 marker')
      await expect(dialog.locator('.permission-summary')).toContainText(prompt)
      await expectControlledMarker(context.layout, 'unchanged\n')

      // 审批弹窗是模态层；force 只用于触发底层历史导航，验证查看身份变化不会改写审批身份。
      await selectSidebarTaskByTitle(context.page, '新任务', true)
      await expect(context.page.getByText('只读历史', { exact: true })).toBeVisible()
      await expect(dialog.locator('.permission-summary')).toContainText(prompt)
      await expectSameExecution(context.page, waiting)

      await selectSidebarProject(context.page, context.layout.secondaryWorkspace, true)
      await expect(context.page.locator('.status-chip')).toContainText('后台执行中')
      await expect(dialog.locator('.permission-summary')).toContainText(prompt)
      await expectSameExecution(context.page, waiting)

      await selectSidebarProject(context.page, context.layout.workspace, true)
      await selectSidebarTaskByTitle(context.page, prompt, true)
      await expect(dialog.locator('.permission-summary')).toContainText(prompt)
      expect(summarizeSessionTrace(await readControlledTrace(context.layout))).toEqual(baseline)

      // 当前产品没有 pending-permission 查询，本场景不宣称 reload 后能重建审批弹窗。
      await dialog.getByRole('button', { name: '仅允许这一次' }).click()
      await waitForFixtureTrace(context.layout, (records) =>
        records.some(
          (record) =>
            record.event === 'permission-resolved' &&
            record.request === 'lifecycle' &&
            record.outcome === 'selected:allow-lifecycle-permission'
        )
      )
      await expectControlledMarker(context.layout, 'P\n')
      const terminal = await waitForExecutionTerminal(context.page)
      expect(terminal.execution).toMatchObject({ taskId: pair.taskAId, state: 'completed' })
      expect(summarizeSessionTrace(await readControlledTrace(context.layout))).toEqual(baseline)
    } finally {
      await context.close()
    }
  })

  test('忽略取消：双 Stop 只发送一次 cancel，deadline 后 interrupted 并释放 Gate', async () => {
    const context = await launchControlledScenario('E2E:IGNORE_CANCEL')
    try {
      const projects = await preparePrimaryWorkbench(context)
      await startControlledPrompt(context.page, '生命周期忽略取消')
      await waitForFixtureEvent(context.layout, 'ignore-cancel-waiting')

      const running = await waitForExecutionState(
        context.page,
        (snapshot) => snapshot.execution?.state === 'running'
      )
      const execution = requireExecution(running)
      const stopButton = context.page.getByTitle(`停止 Task ${execution.taskId}`)
      await stopButton.dblclick()

      const terminal = await waitForExecutionTerminal(context.page, 15_000)
      expect(terminal.execution).toMatchObject({
        executionId: execution.executionId,
        taskId: execution.taskId,
        turnId: execution.turnId,
        state: 'interrupted',
        reason: 'cancel-timeout'
      })
      await expect.poll(async () => countFixtureEvents(context.layout, 'session-cancelled')).toBe(1)
      await expect(context.page.locator('.status-chip[data-state="idle"]')).toContainText('未连接')

      await expectGateReleasedForNewTask(context.page, projects.primaryProjectId)
      await expect(context.page.locator('.status-chip[data-state="ready"]')).toContainText('已连接')
      expect(await countFixtureEvents(context.layout, 'session-cancelled')).toBe(1)
    } finally {
      await context.close()
    }
  })

  test('Runtime 崩溃：exit 17 映射 failed/runtime-error，状态 error 且执行槽可复用', async () => {
    const context = await launchControlledScenario('E2E:RUNTIME_CRASH')
    try {
      const projects = await preparePrimaryWorkbench(context)
      await startControlledPrompt(context.page, '生命周期 Runtime 崩溃')
      await waitForFixtureEvent(context.layout, 'runtime-crash-waiting')

      const running = await waitForExecutionState(
        context.page,
        (snapshot) => snapshot.execution?.state === 'running'
      )
      const execution = requireExecution(running)
      await writeControlledBarrier(context.layout, 'runtime-crash')
      await waitForFixtureTrace(context.layout, (records) =>
        records.some((record) => record.event === 'runtime-crash-exit' && record.code === 17)
      )

      const terminal = await waitForExecutionTerminal(context.page)
      expect(terminal.execution).toMatchObject({
        executionId: execution.executionId,
        taskId: execution.taskId,
        turnId: execution.turnId,
        state: 'failed',
        reason: 'runtime-error'
      })
      await expect(context.page.locator('.status-chip[data-state="error"]')).toContainText(
        '连接异常'
      )
      await expect(context.page.locator('.chat-header p')).toContainText('代码 17')

      await expectGateReleasedForNewTask(context.page, projects.primaryProjectId)
      await expect(context.page.locator('.status-chip[data-state="ready"]')).toContainText('已连接')
    } finally {
      await context.close()
    }
  })
})

/** 固定选择主工作区并显式连接，避免 Project 注册时间影响场景起点。 */
async function preparePrimaryWorkbench(
  context: ControlledElectronScenarioContext
): Promise<ControlledProjects> {
  await prepareControlledWorkbench(context)
  const projects = await context.page.evaluate(
    async ({ primaryWorkspace, secondaryWorkspace }) => {
      const result = await window.app.listProjects()
      if (!result.ok) throw new Error('无法读取受控 Project。')
      const primary = result.value.find((project) => project.canonicalRoot === primaryWorkspace)
      const secondary = result.value.find((project) => project.canonicalRoot === secondaryWorkspace)
      if (!primary || !secondary) throw new Error('受控双 Project 布局不完整。')
      return {
        primaryProjectId: primary.projectId,
        secondaryProjectId: secondary.projectId
      }
    },
    {
      primaryWorkspace: context.layout.workspace,
      secondaryWorkspace: context.layout.secondaryWorkspace
    }
  )
  await expect
    .poll(async () => {
      const result = await context.page.evaluate(async () => window.agent.getStatus())
      return result.ok ? `${result.value.state}:${result.value.workspace ?? ''}` : 'error'
    })
    .toBe(`ready:${context.layout.workspace}`)
  await selectSidebarProject(context.page, context.layout.workspace)
  await expect(context.page.getByPlaceholder('描述你想修改、排查或验证的内容…')).toBeEnabled()
  return projects
}

/** 预建 A/B 后从本地历史显式恢复 A，确保后续 start 不依赖隐式 Task 切换。 */
async function prepareTaskPairAndResumeA(
  context: ControlledElectronScenarioContext
): Promise<PreparedTaskPair> {
  const projects = await preparePrimaryWorkbench(context)
  const tasks = await context.page.evaluate(async (projectId) => {
    const taskA = await window.agent.createTask(projectId)
    if (!taskA.ok) throw new Error('无法创建受控 Task A。')
    const taskB = await window.agent.createTask(projectId)
    if (!taskB.ok) throw new Error('无法创建受控 Task B。')
    return { taskAId: taskA.value.taskId, taskBId: taskB.value.taskId }
  }, projects.primaryProjectId)

  // Project 往返只刷新 Renderer 本地历史，不连接、断开或恢复 Runtime。
  await selectSidebarProject(context.page, context.layout.secondaryWorkspace)
  await selectSidebarProject(context.page, context.layout.workspace)
  await selectSidebarTaskById(context.page, projects.primaryProjectId, tasks.taskAId)
  await expect(context.page.getByText('只读历史', { exact: true })).toBeVisible()
  await context.page.getByRole('button', { name: '继续任务', exact: true }).click()
  await expect(context.page.getByText('只读历史', { exact: true })).toHaveCount(0)
  await expect(context.page.getByPlaceholder('描述你想修改、排查或验证的内容…')).toBeEnabled()
  await waitForFixtureTrace(context.layout, (records) =>
    records.some((record) => record.event === 'session-resumed')
  )
  return { ...projects, ...tasks }
}

/** Permission 场景让 A 由 Renderer 创建，确保审批可展示 A 的独立本地标题。 */
async function prepareTaskPairWithLiveA(
  context: ControlledElectronScenarioContext
): Promise<PreparedTaskPair> {
  const projects = await preparePrimaryWorkbench(context)
  const taskBId = await context.page.evaluate(async (projectId) => {
    const task = await window.agent.createTask(projectId)
    if (!task.ok) throw new Error('无法创建受控 Task B。')
    return task.value.taskId
  }, projects.primaryProjectId)

  await context.page.getByRole('button', { name: '新对话', exact: true }).click()
  let taskAId: string | undefined
  await expect
    .poll(async () => {
      taskAId = await context.page.evaluate(
        async ({ projectId, excludedTaskId }) => {
          const result = await window.task.list(projectId, undefined, 50)
          if (!result.ok) return undefined
          return result.value.items.find((task) => task.taskId !== excludedTaskId)?.taskId
        },
        { projectId: projects.primaryProjectId, excludedTaskId: taskBId }
      )
      return taskAId ?? null
    })
    .not.toBeNull()
  await expect(context.page.getByPlaceholder('描述你想修改、排查或验证的内容…')).toBeEnabled()
  return { ...projects, taskAId: taskAId!, taskBId }
}

/** 用持久化 Task 顺序定位同名“新对话”，避免测试依赖随机 taskId 出现在 DOM。 */
async function selectSidebarTaskById(
  page: Page,
  projectId: string,
  taskId: string,
  force = false
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
  const item = page.locator('section[aria-label="最近"] .session-item').nth(index)
  await expect(item).toBeVisible()
  if (force) await item.evaluate((element) => (element as HTMLButtonElement).click())
  else await item.click()
  await expect(item).toHaveClass(/active/)
}

async function selectSidebarTaskByTitle(page: Page, title: string, force = false): Promise<void> {
  const item = page.locator('section[aria-label="最近"] .session-item').filter({ hasText: title })
  await expect(item).toHaveCount(1)
  if (force) await item.evaluate((element) => (element as HTMLButtonElement).click())
  else await item.click()
  await expect(item).toHaveClass(/active/)
}

async function selectSidebarProject(page: Page, workspace: string, force = false): Promise<void> {
  const item = page.locator('section[aria-label="项目"]').getByTitle(workspace, { exact: true })
  await expect(item).toBeVisible()
  if (force) await item.evaluate((element) => (element as HTMLButtonElement).click())
  else await item.click()
  await expect(item).toHaveClass(/active/)
  await expect(page.locator('.chat-header h1')).toHaveText(basename(workspace))
}

/** 后台执行只禁用 mutation；Project/Task 历史入口和绑定 execution 的 Stop 必须保留。 */
async function expectExecutionMutationsDisabled(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: '新对话' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '打开项目' })).toBeDisabled()
  await expect(page.locator('section[aria-label="项目"] .sidebar-item-main').first()).toBeEnabled()
  await expect(page.locator('section[aria-label="最近"] .session-item').first()).toBeEnabled()
  await expect(
    page.locator('section[aria-label="最近"] .sidebar-row-action').first()
  ).toBeDisabled()
}

async function expectSameExecution(page: Page, expected: TaskExecutionSnapshot): Promise<void> {
  const execution = requireExecution(expected)
  const current = await page.evaluate(async () => window.agent.getExecutionSnapshot())
  expect(current.ok).toBe(true)
  if (!current.ok) return
  expect(current.value.execution).toMatchObject({
    executionId: execution.executionId,
    taskId: execution.taskId,
    turnId: execution.turnId
  })
  expect(['queued', 'running', 'waiting-permission', 'cancelling']).toContain(
    current.value.execution?.state
  )
}

/** 终态提交释放 Gate 后，原 Project 必须能重新 connect 并创建新的 Runtime session。 */
async function expectGateReleasedForNewTask(page: Page, projectId: string): Promise<void> {
  const result = await page.evaluate(async (currentProjectId) => {
    const connected = await window.agent.connect(currentProjectId)
    if (!connected.ok) return { connected: false, created: false }
    const task = await window.agent.createTask(currentProjectId)
    return { connected: true, created: task.ok }
  }, projectId)
  expect(result).toEqual({ connected: true, created: true })
}

function requireExecution(
  snapshot: TaskExecutionSnapshot
): NonNullable<TaskExecutionSnapshot['execution']> {
  if (!snapshot.execution) throw new Error('缺少受控 execution。')
  return snapshot.execution
}

function summarizeSessionTrace(records: TraceRecord[]): SessionTraceSummary {
  return {
    created: records.filter((record) => record.event === 'session-created').length,
    resumed: records.filter((record) => record.event === 'session-resumed').length,
    loaded: records.filter((record) => record.event === 'session-loaded').length,
    cancelled: records.filter((record) => record.event === 'session-cancelled').length
  }
}

async function waitForFixtureEvent(layout: ControlledLayout, event: string): Promise<void> {
  await waitForFixtureTrace(layout, (records) => records.some((record) => record.event === event))
}

async function countFixtureEvents(layout: ControlledLayout, event: string): Promise<number> {
  return (await readControlledTrace(layout)).filter((record) => record.event === event).length
}

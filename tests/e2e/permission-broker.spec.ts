import { expect, test, _electron as electron } from '@playwright/test'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  CONTROLLED_ACP_E2E_ADAPTER_TRACE_FILE,
  CONTROLLED_ACP_E2E_DIRECTORIES,
  CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE,
  CONTROLLED_ACP_E2E_MARKER_FILE,
  type ControlledAcpFixtureScenario
} from '../../src/main/runtime/grok/controlled-acp-fixture'

const repositoryRoot = resolve(process.cwd())
const mainEntry = join(repositoryRoot, 'out/main/index.js')
const e2eArgumentPrefix = '--agent-studio-controlled-acp-e2e'
const rawInputSentinel = 'E2E_RAW_INPUT_MUST_NOT_DISPLAY'

type TraceRecord = Record<string, unknown>
type CapturedPermission = {
  approvalId: string
  taskId: string
  turnId: string
  title: string
}

interface ControlledLayout {
  root: string
  workspace: string
  traceDirectory: string
  barrierDirectory: string
  runtimeHomeDirectory: string
  markerPath: string
}

interface MockProvider {
  port: number
  requestCount: number
  authorizationHeaders: Array<string | undefined>
  close(): Promise<void>
}

interface ScenarioContext {
  app: Awaited<ReturnType<typeof electron.launch>>
  page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
  layout: ControlledLayout
  provider: MockProvider
  close(): Promise<void>
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
      await writeFile(join(context.layout.barrierDirectory, 'toolcall-cancel-A.ready'), 'ready\n', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
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
    } finally {
      await context.close()
    }
  })
})

/** 创建完全隔离的临时 profile、workspace 与 Mock Provider，再通过真实 Electron Main/Preload/Renderer 链路启动。 */
async function launchScenario(scenario: ControlledAcpFixtureScenario): Promise<ScenarioContext> {
  const layout = await createControlledLayout()
  const provider = await startMockProvider()
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined
  try {
    app = await electron.launch({
      args: [
        mainEntry,
        `${e2eArgumentPrefix}-scenario=${scenario}`,
        `${e2eArgumentPrefix}-user-data=${layout.root}`,
        `${e2eArgumentPrefix}-provider-port=${provider.port}`
      ],
      cwd: repositoryRoot,
      env: createIsolatedElectronEnvironment(layout.runtimeHomeDirectory, dirname(layout.root))
    })
    const page = await app.firstWindow()
    return {
      app,
      page,
      layout,
      provider,
      close: async () => {
        await Promise.allSettled([app?.close(), provider.close()])
        await rm(layout.root, { recursive: true, force: true })
      }
    }
  } catch (error) {
    await Promise.allSettled([app?.close(), provider.close()])
    await rm(layout.root, { recursive: true, force: true })
    throw error
  }
}

/** 受控 Electron 进程不继承宿主 HOME 或 Provider 环境，只得到桌面运行所需的极小变量集合。 */
function createIsolatedElectronEnvironment(
  runtimeHomeDirectory: string,
  temporaryDirectory: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: runtimeHomeDirectory,
    USERPROFILE: runtimeHomeDirectory,
    // bootstrap 用 tmpdir() 复核 userData 的直接父目录；这个值来自本次临时根而非宿主环境。
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory
  }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY']) {
    if (process.env[key]) environment[key] = process.env[key]
  }
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR
    if (systemRoot) {
      environment.SystemRoot = systemRoot
      environment.WINDIR = systemRoot
    }
  }
  return environment
}

/** 临时目录布局与 Main bootstrap 的固定目录契约完全一致，避免系统目录或真实 profile 参与测试。 */
async function createControlledLayout(): Promise<ControlledLayout> {
  const temporaryDirectory = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryDirectory, 'agent-studio-controlled-acp-e2e-'))
  await chmod(root, 0o700)
  const directories = await Promise.all(
    Object.values(CONTROLLED_ACP_E2E_DIRECTORIES).map(async (name) => {
      const directory = join(root, name)
      await mkdir(directory, { mode: 0o700 })
      await chmod(directory, 0o700)
      return directory
    })
  )
  const workspace = directories[0]
  const markerPath = join(workspace, CONTROLLED_ACP_E2E_MARKER_FILE)
  await writeFile(markerPath, 'unchanged\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(markerPath, 0o600)
  return {
    root,
    workspace,
    traceDirectory: join(root, CONTROLLED_ACP_E2E_DIRECTORIES.trace),
    barrierDirectory: join(root, CONTROLLED_ACP_E2E_DIRECTORIES.barriers),
    runtimeHomeDirectory: join(root, CONTROLLED_ACP_E2E_DIRECTORIES.runtimeHome),
    markerPath
  }
}

/** 本地 Mock 只接受 bootstrap 的无认证 Chat Completions 探针，任何其他请求均显式失败。 */
async function startMockProvider(): Promise<MockProvider> {
  let requestCount = 0
  const authorizationHeaders: Array<string | undefined> = []
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      requestCount += 1
      authorizationHeaders.push(request.headers.authorization)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }))
      return
    }
    response.writeHead(404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'not found' } }))
  })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    get requestCount() {
      return requestCount
    },
    get authorizationHeaders() {
      return [...authorizationHeaders]
    },
    close: () => closeServer(server)
  }
}

/** 等待启动期 Mock 探针和真实工作台连接完成，明确验证无认证请求没有 Authorization Header。 */
async function prepareWorkbench(context: ScenarioContext): Promise<void> {
  await expect.poll(() => context.provider.requestCount).toBe(1)
  expect(context.provider.authorizationHeaders).toEqual([undefined])
  await expect(context.page.locator('.status-chip[data-state="ready"]')).toBeVisible()
  await expect(context.page.getByPlaceholder('描述你想修改、排查或验证的内容…')).toBeEnabled()
}

/** 用正常 Composer 交互创建 Task/Turn；fixture 从不读取这段 Prompt。 */
async function startScenarioPrompt(page: ScenarioContext['page'], prompt: string): Promise<void> {
  const composer = page.getByPlaceholder('描述你想修改、排查或验证的内容…')
  await composer.fill(prompt)
  await composer.press('Enter')
}

/** 仅订阅既有 Renderer 可见权限 DTO，供晚到响应回归使用；不会暴露 Runtime requestId 或测试 IPC。 */
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
        if (!projects.ok || projects.value.length !== 1) return undefined
        const tasks = await window.task.list(projects.value[0].projectId)
        return tasks.ok ? tasks.value.items[0]?.taskId : undefined
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

async function expectMarker(layout: ControlledLayout, expected: string): Promise<void> {
  await expect.poll(async () => readFile(layout.markerPath, 'utf8')).toBe(expected)
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()))
  })
}

import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { TaskExecutionSnapshot } from '../../src/shared/task-execution'
import {
  CONTROLLED_ACP_E2E_DIRECTORIES,
  CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE,
  CONTROLLED_ACP_E2E_MARKER_FILE,
  type ControlledAcpFixtureScenario
} from '../../src/main/runtime/grok/controlled-acp-fixture'

const repositoryRoot = resolve(process.cwd())
const mainEntry = join(repositoryRoot, 'out/main/index.js')
const e2eArgumentPrefix = '--agent-studio-controlled-acp-e2e'
type TaskExecutionState = NonNullable<TaskExecutionSnapshot['execution']>['state']

const TERMINAL_EXECUTION_STATES = new Set<TaskExecutionState>([
  'completed',
  'failed',
  'cancelled',
  'interrupted'
])
const EXECUTION_SETTLE_TIMEOUT_MS = 5_000
const GRACEFUL_CLOSE_TIMEOUT_MS = 8_000
const FORCE_KILL_TIMEOUT_MS = 3_000

export type TraceRecord = Record<string, unknown>

export interface ControlledLayout {
  root: string
  workspace: string
  secondaryWorkspace: string
  traceDirectory: string
  barrierDirectory: string
  runtimeHomeDirectory: string
  markerPath: string
}

export interface MockProvider {
  port: number
  requestCount: number
  authorizationHeaders: Array<string | undefined>
  close(): Promise<void>
}

export interface ControlledElectronScenarioContext {
  app: ElectronApplication
  page: Page
  layout: ControlledLayout
  provider: MockProvider
  close(): Promise<void>
}

/** 创建隔离 Electron、固定双 Project 布局与无认证 Mock Provider。 */
export async function launchControlledScenario(
  scenario: ControlledAcpFixtureScenario
): Promise<ControlledElectronScenarioContext> {
  const layout = await createControlledLayout()
  const provider = await startMockProvider()
  let launchedProcess: ChildProcess | undefined
  try {
    const launchedApp = await electron.launch({
      args: [
        mainEntry,
        `${e2eArgumentPrefix}-scenario=${scenario}`,
        `${e2eArgumentPrefix}-user-data=${layout.root}`,
        `${e2eArgumentPrefix}-provider-port=${provider.port}`
      ],
      cwd: repositoryRoot,
      env: createIsolatedElectronEnvironment(layout.runtimeHomeDirectory, dirname(layout.root))
    })
    launchedProcess = launchedApp.process()
    const page = await launchedApp.firstWindow()
    let closed = false
    return {
      app: launchedApp,
      page,
      layout,
      provider,
      close: async () => {
        if (closed) return
        closed = true
        const child = launchedProcess
        const executionSettled = await waitForExecutionSettled(
          page,
          EXECUTION_SETTLE_TIMEOUT_MS
        ).then(
          () => true,
          () => false
        )
        let stopped = !isProcessRunning(child)
        let gracefulClose: Promise<void> | null = null
        if (!stopped && executionSettled) {
          // close 失败或超时都只代表优雅退出未完成，仍必须以真实子进程状态决定是否强杀。
          gracefulClose = launchedApp.close().catch(() => undefined)
          await settlesWithin(gracefulClose, GRACEFUL_CLOSE_TIMEOUT_MS)
          stopped = !isProcessRunning(child)
        }
        if (!stopped) {
          const forceStop = forceStopProcess(child)
          const closeAfterKill = gracefulClose
            ? settlesWithin(gracefulClose, FORCE_KILL_TIMEOUT_MS)
            : Promise.resolve(false)
          const [forceStopped] = await Promise.all([forceStop, closeAfterKill])
          stopped = forceStopped || !isProcessRunning(child)
        }
        await provider.close().catch(() => undefined)
        // 进程仍存活时保留隔离 profile 供诊断，绝不边运行边删除其 userData。
        if (stopped && !isProcessRunning(child)) {
          await rm(layout.root, { recursive: true, force: true }).catch(() => undefined)
        }
      }
    }
  } catch (error) {
    const child = launchedProcess
    const stopped = child ? await forceStopProcess(child) : true
    await provider.close().catch(() => undefined)
    // 启动中途失败也不能删除仍被 Electron 使用的 profile，且清理错误不得覆盖原始启动异常。
    if (stopped && (!child || !isProcessRunning(child))) {
      await rm(layout.root, { recursive: true, force: true }).catch(() => undefined)
    }
    throw error
  }
}

/** 健康场景必须在业务断言内显式等到可信终态，teardown 只负责兜底。 */
export async function waitForExecutionTerminal(
  page: Page,
  timeout = 10_000
): Promise<TaskExecutionSnapshot> {
  return waitForMatchingExecutionSnapshot(
    page,
    (snapshot) =>
      snapshot.execution != null && TERMINAL_EXECUTION_STATES.has(snapshot.execution.state),
    timeout
  )
}

export async function waitForExecutionState(
  page: Page,
  predicate: (snapshot: TaskExecutionSnapshot) => boolean,
  timeout = 10_000
): Promise<TaskExecutionSnapshot> {
  return waitForMatchingExecutionSnapshot(page, predicate, timeout)
}

/** teardown 允许尚未创建 execution；一旦存在 execution，则必须确认它已经进入终态。 */
async function waitForExecutionSettled(
  page: Page,
  timeout: number
): Promise<TaskExecutionSnapshot> {
  return waitForMatchingExecutionSnapshot(
    page,
    (snapshot) =>
      snapshot.execution == null || TERMINAL_EXECUTION_STATES.has(snapshot.execution.state),
    timeout
  )
}

/** 用可变容器保留命中的快照，避免闭包赋值让 TypeScript 丢失终态后的类型收窄。 */
async function waitForMatchingExecutionSnapshot(
  page: Page,
  predicate: (snapshot: TaskExecutionSnapshot) => boolean,
  timeout: number
): Promise<TaskExecutionSnapshot> {
  const matched: { snapshot?: TaskExecutionSnapshot } = {}
  await expect
    .poll(
      async () => {
        const result = await page.evaluate(async () => window.agent.getExecutionSnapshot())
        if (!result.ok || !predicate(result.value)) return false
        matched.snapshot = result.value
        return true
      },
      { timeout }
    )
    .toBe(true)
  const snapshot = matched.snapshot
  if (!snapshot) throw new Error('未取得 execution snapshot。')
  return snapshot
}

export function runtimeStatusLocator(
  page: Page,
  runtimeState?: string
): ReturnType<Page['locator']> {
  return runtimeState
    ? page.locator(`.task-header-status[data-runtime-state="${runtimeState}"]`)
    : page.locator('.task-header-status')
}

export function executionStatusLocator(
  page: Page,
  scope: 'foreign' | 'selected' | 'none'
): ReturnType<Page['locator']> {
  return page.locator(
    `.task-header[data-execution="${scope}"], .task-header-status[data-execution="${scope}"]`
  )
}

/** 通过项目下拉只切换查看身份与本地历史，不重建 Runtime；不再点「连接 Grok」。 */
export async function selectWorkbenchProject(
  page: Page,
  workspace: string,
  force = false
): Promise<void> {
  const current = page.locator('.project-current')
  const name = basename(workspace)
  const alreadySelected = (await current.locator('strong').textContent())?.trim() === name
  if (!alreadySelected) {
    if (force) await current.evaluate((element) => (element as HTMLButtonElement).click())
    else await current.click()
    const option = page.locator('.project-menu [role="option"]').filter({ hasText: name }).first()
    await expect(option).toBeVisible()
    if (force) await option.evaluate((element) => (element as HTMLButtonElement).click())
    else await option.click()
  }
  await expect(current.locator('strong')).toHaveText(name)
}

export async function selectWorkbenchTaskByTitle(
  page: Page,
  title: string,
  force = false
): Promise<void> {
  const row = page.locator('.task-row').filter({ hasText: title }).first()
  const button = row.locator('.task-main')
  await expect(button).toBeVisible()
  if (force) await button.evaluate((element) => (element as HTMLButtonElement).click())
  else await button.click()
  await expect(row).toHaveClass(/selected/)
}

export async function selectWorkbenchTaskById(
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
  const row = page.locator('.task-row').nth(index)
  const button = row.locator('.task-main')
  await expect(button).toBeVisible()
  if (force) await button.evaluate((element) => (element as HTMLButtonElement).click())
  else await button.click()
  await expect(row).toHaveClass(/selected/)
}

/** 等待启动探针与工作台连接完成，并确认受控 Provider 未收到 Authorization。 */
export async function prepareControlledWorkbench(
  context: ControlledElectronScenarioContext
): Promise<void> {
  await expect.poll(() => context.provider.requestCount).toBe(1)
  expect(context.provider.authorizationHeaders).toEqual([undefined])
  await selectWorkbenchProject(context.page, context.layout.workspace)
  const ready = runtimeStatusLocator(context.page, 'ready')
  const retry = context.page.getByRole('button', { name: '重新连接 Runtime' })
  if ((await ready.count()) === 0 && (await retry.count()) > 0) {
    await retry.click()
  }
  await expect(ready).toBeVisible()
  await expect(context.page.getByPlaceholder('描述你想修改、排查或验证的内容…')).toBeEnabled()
}

/** 通过真实 Composer 创建 Task/Turn；fixture 不读取 Prompt 正文。 */
export async function startControlledPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByPlaceholder('描述你想修改、排查或验证的内容…')
  await composer.fill(prompt)
  await composer.press('Enter')
}

/** barrier 名只允许测试源码中的短 ASCII 标识，避免形成任意路径写入口。 */
export async function writeControlledBarrier(
  layout: ControlledLayout,
  name: string
): Promise<void> {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(name)) throw new Error('受控 barrier 名称无效。')
  await writeFile(join(layout.barrierDirectory, `${name}.ready`), 'ready\n', {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
}

export async function waitForFixtureTrace(
  layout: ControlledLayout,
  predicate: (records: TraceRecord[]) => boolean
): Promise<void> {
  await expect
    .poll(async () =>
      predicate(await readControlledTrace(layout, CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE))
    )
    .toBe(true)
}

export async function readControlledTrace(
  layout: ControlledLayout,
  file = CONTROLLED_ACP_E2E_FIXTURE_TRACE_FILE
): Promise<TraceRecord[]> {
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
        return []
      }
    })
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
}

export async function expectControlledMarker(
  layout: ControlledLayout,
  expected: string
): Promise<void> {
  await expect.poll(async () => readFile(layout.markerPath, 'utf8')).toBe(expected)
}

/** 临时目录布局与 Main bootstrap 固定契约一致，额外注册第二 Project 供纯历史导航验证。 */
async function createControlledLayout(): Promise<ControlledLayout> {
  const temporaryDirectory = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryDirectory, 'agent-studio-controlled-acp-e2e-'))
  await chmod(root, 0o700)
  await Promise.all(
    Object.values(CONTROLLED_ACP_E2E_DIRECTORIES).map(async (name) => {
      const directory = join(root, name)
      await mkdir(directory, { mode: 0o700 })
      await chmod(directory, 0o700)
    })
  )
  const workspace = join(root, CONTROLLED_ACP_E2E_DIRECTORIES.workspace)
  const markerPath = join(workspace, CONTROLLED_ACP_E2E_MARKER_FILE)
  await writeFile(markerPath, 'unchanged\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(markerPath, 0o600)
  return {
    root,
    workspace,
    secondaryWorkspace: join(root, CONTROLLED_ACP_E2E_DIRECTORIES.secondaryWorkspace),
    traceDirectory: join(root, CONTROLLED_ACP_E2E_DIRECTORIES.trace),
    barrierDirectory: join(root, CONTROLLED_ACP_E2E_DIRECTORIES.barriers),
    runtimeHomeDirectory: join(root, CONTROLLED_ACP_E2E_DIRECTORIES.runtimeHome),
    markerPath
  }
}

/** 受控 Electron 不继承宿主 HOME 或 Provider 环境，只保留桌面启动必要变量。 */
function createIsolatedElectronEnvironment(
  runtimeHomeDirectory: string,
  temporaryDirectory: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: runtimeHomeDirectory,
    USERPROFILE: runtimeHomeDirectory,
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

/** Mock 只接受无认证 Chat Completions 探针。 */
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

async function forceStopProcess(child: ChildProcess): Promise<boolean> {
  if (!isProcessRunning(child)) return true
  // 先订阅退出事件再发信号，避免极快退出发生在监听器注册之前。
  const processExit = waitForProcessExit(child)
  try {
    child.kill('SIGKILL')
  } catch {
    return !isProcessRunning(child)
  }
  await settlesWithin(processExit, FORCE_KILL_TIMEOUT_MS)
  return !isProcessRunning(child)
}

function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (!isProcessRunning(child)) return Promise.resolve()
  return new Promise<void>((resolveExit) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      child.off('exit', finish)
      child.off('close', finish)
      resolveExit()
    }
    child.once('exit', finish)
    child.once('close', finish)
    // 注册监听器后复核一次，覆盖进程恰好在前一行之前退出的竞态。
    if (!isProcessRunning(child)) finish()
  })
}

function isProcessRunning(child: ChildProcess): boolean {
  return child.exitCode == null && child.signalCode == null
}

function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveSettle) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolveSettle(false)
    }, timeoutMs)
    void operation.then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveSettle(true)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveSettle(true)
      }
    )
  })
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.()
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

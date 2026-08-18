import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentPermissionRequest, AgentRuntimeStatus } from '../../src/shared/agent'
import type { PublicAgentEvent } from '../../src/shared/agent-event'
import {
  GACP01_OBSERVE_DIRECTORIES,
  GACP01_OBSERVE_PROTOCOL_FILE
} from '../../src/main/e2e/gacp01-observe-bootstrap'
import type { GrokAcpObservationRecord } from '../../src/main/runtime/grok/grok-acp-protocol-observer'
import type { TaskExecutionSnapshot } from '../../src/shared/task-execution'

const repositoryRoot = resolve(process.cwd())
const mainEntry = join(repositoryRoot, 'out/main/index.js')
const USER_DATA_PREFIX = 'agent-studio-gacp01-observe-'
const ARGUMENT_PREFIX = '--agent-studio-gacp01-observe-user-data'

export interface Gacp01ObserveLayout {
  root: string
  workspace: string
  observationFile: string
}

export interface Gacp01ObserveContext {
  app: ElectronApplication
  page: Page
  layout: Gacp01ObserveLayout
  events: PublicAgentEvent[]
  permissions: AgentPermissionRequest[]
  close(): Promise<void>
}

/** 创建隔离 Electron userData，但保留宿主 HOME，以便找到真实 grok。 */
export async function launchGacp01ObserveApp(): Promise<Gacp01ObserveContext> {
  const layout = await createObserveLayout()
  const launchedApp = await electron.launch({
    args: [mainEntry, `${ARGUMENT_PREFIX}=${layout.root}`],
    cwd: repositoryRoot,
    env: {
      ...createHostGrokEnvironment(dirname(layout.root)),
      NODE_ENV: 'development'
    }
  })
  const page = await launchedApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  const events: PublicAgentEvent[] = []
  const permissions: AgentPermissionRequest[] = []
  await installAgentCollectors(page)
  return {
    app: launchedApp,
    page,
    layout,
    events,
    permissions,
    close: async () => {
      await launchedApp.close().catch(() => undefined)
      await rm(layout.root, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

export async function saveProviderFromEnv(page: Page): Promise<void> {
  const baseUrl = requiredEnv('GACP01_PROVIDER_BASE_URL')
  const apiKey = requiredEnv('GACP01_PROVIDER_API_KEY')
  const modelId = process.env.GACP01_MODEL_ID?.trim() || 'grok-4.5'
  const result = await page.evaluate(async (input) => window.provider.save(input), {
    baseUrl,
    authMode: 'bearer' as const,
    apiKey,
    modelId
  })
  if (!hasConfiguredProvider(result)) {
    throw new Error('保存 Provider 失败。')
  }
}

export async function connectFirstProject(page: Page): Promise<{
  projectId: string
  status: AgentRuntimeStatus
}> {
  const listed = await page.evaluate(async () => window.app.listProjects())
  if (!listed.ok || listed.value.length === 0) throw new Error('观察 workspace 未注册。')
  const projectId = listed.value[0].projectId
  const connected = await page.evaluate(async (id) => window.agent.connect(id), projectId)
  if (!connected.ok) throw new Error(connected.error?.message ?? '连接失败')
  return { projectId, status: connected.value }
}

export async function drainAgentCollectors(
  page: Page,
  events: PublicAgentEvent[],
  permissions: AgentPermissionRequest[]
): Promise<void> {
  const drained = await page.evaluate(() => {
    const holder = window as unknown as {
      __gacp01Events?: PublicAgentEvent[]
      __gacp01Permissions?: AgentPermissionRequest[]
    }
    const nextEvents = holder.__gacp01Events ?? []
    const nextPermissions = holder.__gacp01Permissions ?? []
    holder.__gacp01Events = []
    holder.__gacp01Permissions = []
    return { nextEvents, nextPermissions }
  })
  events.push(...drained.nextEvents)
  permissions.push(...drained.nextPermissions)
}

export async function runTurn(
  page: Page,
  projectId: string,
  taskId: string | undefined,
  prompt: string,
  collectors: { events: PublicAgentEvent[]; permissions: AgentPermissionRequest[] },
  timeout = 180_000
): Promise<{ taskId: string; snapshot: TaskExecutionSnapshot }> {
  const resolvedTaskId =
    taskId ??
    (await page.evaluate(async (id) => {
      const created = await window.agent.createTask(id)
      if (!created.ok) throw new Error(created.error?.message ?? '创建 Task 失败')
      return created.value.taskId
    }, projectId))
  const started = await page.evaluate(async ([id, text]) => window.agent.startTurn(id, text), [
    resolvedTaskId,
    prompt
  ] as const)
  if (!started.ok) throw new Error(started.error?.message ?? 'startTurn 失败')
  const snapshot = await waitForExecutionTerminal(page, collectors, timeout)
  return { taskId: resolvedTaskId, snapshot }
}

export async function resumeTask(
  page: Page,
  taskId: string
): Promise<{ method?: string; message: string }> {
  const result = await page.evaluate(async (id) => window.task.resume(id), taskId)
  if (!result.ok) throw new Error(result.error?.message ?? 'resume 失败')
  return { method: result.value.method, message: result.value.message }
}

export async function allowPendingPermissions(
  page: Page,
  permissions: AgentPermissionRequest[]
): Promise<string[]> {
  const decisions: string[] = []
  for (const request of permissions) {
    const result = await page.evaluate(
      async (payload) =>
        window.agent.respondPermission({
          approvalId: payload.approvalId,
          taskId: payload.taskId,
          turnId: payload.turnId,
          decision: 'allow-once'
        }),
      request
    )
    decisions.push(result.ok ? 'allow-once' : 'respond-failed')
  }
  return decisions
}

export async function readProtocolRecords(
  layout: Gacp01ObserveLayout
): Promise<GrokAcpObservationRecord[]> {
  try {
    const text = await readFile(layout.observationFile, 'utf8')
    return text.split('\n').flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line) as GrokAcpObservationRecord]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function hashGrokConfig(): string | undefined {
  try {
    const text = execFileSync(
      process.platform === 'win32' ? 'powershell' : 'sh',
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', `Get-Content -Raw "$env:USERPROFILE\\.grok\\config.toml"`]
        : ['-c', 'cat "$HOME/.grok/config.toml"'],
      { encoding: 'utf8' }
    )
    return createHash('sha256').update(text).digest('hex')
  } catch {
    return undefined
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少 ${name}`)
  return value
}

export function isGacp01ObserveEnabled(): boolean {
  return process.env.GACP01_REAL_GROK === '1' && process.env.CI !== 'true'
}

async function installAgentCollectors(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = window as unknown as {
      __gacp01Events?: PublicAgentEvent[]
      __gacp01Permissions?: AgentPermissionRequest[]
    }
    holder.__gacp01Events = []
    holder.__gacp01Permissions = []
    window.agent.onEvent((event) => {
      holder.__gacp01Events?.push(event)
    })
    window.agent.onPermission((request) => {
      holder.__gacp01Permissions?.push(request)
    })
  })
}

async function waitForExecutionTerminal(
  page: Page,
  collectors: { events: PublicAgentEvent[]; permissions: AgentPermissionRequest[] },
  timeout: number
): Promise<TaskExecutionSnapshot> {
  const matched: { snapshot?: TaskExecutionSnapshot } = {}
  await expect
    .poll(
      async () => {
        await drainAgentCollectors(page, collectors.events, collectors.permissions)
        if (collectors.permissions.length > 0) {
          await allowPendingPermissions(page, collectors.permissions.splice(0))
        }
        const result = await page.evaluate(async () => window.agent.getExecutionSnapshot())
        if (
          !result.ok ||
          !result.value.execution ||
          !['completed', 'failed', 'cancelled', 'interrupted'].includes(
            result.value.execution.state
          )
        ) {
          return false
        }
        matched.snapshot = result.value
        return true
      },
      { timeout }
    )
    .toBe(true)
  if (!matched.snapshot) throw new Error('未等到 Turn 终态。')
  return matched.snapshot
}

async function createObserveLayout(): Promise<Gacp01ObserveLayout> {
  const temporaryDirectory = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryDirectory, USER_DATA_PREFIX))
  await chmod(root, 0o700)
  const workspace = join(root, GACP01_OBSERVE_DIRECTORIES.workspace)
  const observation = join(root, GACP01_OBSERVE_DIRECTORIES.observation)
  await mkdir(workspace, { mode: 0o700 })
  await mkdir(observation, { mode: 0o700 })
  await writeFile(join(workspace, 'README.md'), 'GACP-01 observe fixture\n', {
    encoding: 'utf8',
    mode: 0o600
  })
  await writeFile(join(workspace, 'notes.txt'), 'safe notes\n', { encoding: 'utf8', mode: 0o600 })
  return {
    root,
    workspace,
    observationFile: join(observation, GACP01_OBSERVE_PROTOCOL_FILE)
  }
}

function createHostGrokEnvironment(temporaryDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory
  }
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'SystemRoot',
    'WINDIR'
  ]) {
    if (process.env[key]) environment[key] = process.env[key]
  }
  return environment
}

function hasConfiguredProvider(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  return 'configured' in result && (result as { configured?: boolean }).configured === true
}

export function capabilitySupport(
  status: AgentRuntimeStatus,
  capabilityId: 'session.create' | 'session.resume' | 'session.load'
): string {
  const capability = status.capabilitySnapshot?.capabilities[capabilityId]
  if (!capability) return 'absent'
  return `${capability.support}/${capability.verification}`
}

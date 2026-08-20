import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeStatus } from '../shared/agent'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderTestResult
} from '../shared/provider'
import type { OperationLease } from './agent/operation-gate'
import type { ProviderIpcOperations } from './provider/ipc'
import type { ProviderRuntimeConfig } from './provider/provider-config-store'

type AppDeletionDependencies = {
  removeProject(projectId: string): Promise<void>
  deleteProjectHistory(projectId: string, token: string): Promise<void>
}

type TaskDeletionRuntime = {
  deleteTask(taskId: string, token: string): Promise<void>
}

type DeletionPreparation = {
  commit: ReturnType<typeof vi.fn<() => Promise<void>>>
  rollback: ReturnType<typeof vi.fn<() => boolean>>
}

type TaskDeletionDependencies = {
  getHistory(): TaskDeletionRuntime | null
}

type DeletionLease = {
  commit: ReturnType<typeof vi.fn<() => void>>
  rollback: ReturnType<typeof vi.fn<() => void>>
}

const mocks = vi.hoisted(() => {
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const providerState: { runtimeConfig: ProviderRuntimeConfig } = {
    runtimeConfig: {
      baseUrl: 'https://provider.test/v1',
      authMode: 'none' as const,
      modelId: 'model-1',
      testedAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z'
    }
  }
  const toProviderSummary = (): ProviderConfigSummary => ({
    configured: true,
    baseUrl: providerState.runtimeConfig.baseUrl,
    authMode: providerState.runtimeConfig.authMode,
    modelId: providerState.runtimeConfig.modelId,
    hasApiKey: false,
    credentialStorage: 'secure',
    testedAt: providerState.runtimeConfig.testedAt,
    updatedAt: providerState.runtimeConfig.updatedAt
  })

  return {
    ready,
    resolveReady,
    appDeletionDependencies: undefined as AppDeletionDependencies | undefined,
    taskDeletionDependencies: undefined as TaskDeletionDependencies | undefined,
    providerOperations: undefined as ProviderIpcOperations | undefined,
    providerState,
    providerStore: {
      initialize: vi.fn(async () => undefined),
      getSummary: vi.fn(() => toProviderSummary()),
      getRuntimeConfig: vi.fn(() => ({ ...providerState.runtimeConfig })),
      save: vi.fn(async (input: ProviderConfigInput) => {
        providerState.runtimeConfig = {
          ...input,
          testedAt: '2026-08-17T00:00:01.000Z',
          updatedAt: '2026-08-17T00:00:01.000Z'
        }
        return toProviderSummary()
      }),
      clear: vi.fn(async (): Promise<ProviderConfigSummary> => ({
        configured: false,
        hasApiKey: false,
        credentialStorage: 'secure'
      }))
    },
    providerTester: {
      testInference: vi.fn(async (): Promise<ProviderTestResult> => ({
        ok: true,
        stage: 'inference',
        message: 'ok'
      })),
      listModels: vi.fn()
    },
    agentService: {
      getStatus: vi.fn<() => AgentRuntimeStatus>(() => ({
        runtimeId: 'grok',
        state: 'idle',
        message: 'idle'
      })),
      connect: vi.fn<
        (workspace: string, inheritedLease?: OperationLease) => Promise<AgentRuntimeStatus>
      >(async (workspace) => ({
        runtimeId: 'grok',
        state: 'ready',
        message: 'ready',
        workspace
      })),
      disconnect: vi.fn<(inheritedLease?: OperationLease) => Promise<AgentRuntimeStatus>>(
        async () => ({ runtimeId: 'grok', state: 'idle', message: 'idle' })
      )
    },
    runtimeAdapter: {
      disconnect: vi.fn(async () => undefined),
      getCapabilitySnapshot: vi.fn(() => ({
        runtimeId: 'grok',
        observedAt: '2026-08-17T00:00:00.000Z',
        capabilities: {}
      }))
    },
    projectRegistry: {
      initialize: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      register: vi.fn(async () => null),
      remove: vi.fn<(_projectId: string) => Promise<void>>(async () => undefined)
    },
    taskStore: {
      initialize: vi.fn(async () => undefined),
      ensureAdditionalHistoryCapacity: vi.fn(async () => undefined),
      beginTaskHistoryMutation: vi.fn(() => ({ release: vi.fn() })),
      getTaskRecord: vi.fn(() => ({
        taskId: 'task-1',
        projectId: 'project-1',
        runtimeId: 'grok',
        environment: { kind: 'local', rootSnapshot: '/tmp/project-1' },
        activeTurnId: 'turn-1',
        state: 'running'
      })),
      deleteProjectHistory: vi.fn<(_projectId: string, _token: string) => Promise<void>>(
        async () => undefined
      ),
      deleteTask: vi.fn<(_taskId: string, _token: string) => Promise<void>>(async () => undefined),
      prepareTaskDeletion: vi.fn(),
      prepareProjectHistoryDeletion: vi.fn()
    },
    taskDeletionPreparation: createDeletionPreparationMock(),
    projectDeletionPreparation: createDeletionPreparationMock(),
    taskDeletionLease: createDeletionLeaseMock(),
    projectDeletionLease: createDeletionLeaseMock(),
    permissionBroker: {
      beginProjectDeletion: vi.fn(),
      beginTaskDeletion: vi.fn(),
      invalidateProject: vi.fn(async () => undefined),
      invalidateTask: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined)
    }
  }
})

vi.mock('electron', () => {
  class BrowserWindowMock {
    static getAllWindows(): BrowserWindowMock[] {
      return []
    }

    readonly webContents = {
      setWindowOpenHandler: vi.fn()
    }

    constructor(options: unknown) {
      void options
    }

    on(event: string, listener: (...args: unknown[]) => void): void {
      void event
      void listener
    }
    show(): void {
      return undefined
    }
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    loadFile(): Promise<void> {
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return false
    }
    isMinimized(): boolean {
      return false
    }
    restore(): void {
      return undefined
    }
    focus(): void {
      return undefined
    }
    setBackgroundColor(color: string): void {
      void color
    }
  }

  return {
    app: {
      requestSingleInstanceLock: vi.fn(() => true),
      whenReady: vi.fn(() => mocks.ready),
      on: vi.fn(),
      getPath: vi.fn(() => '/tmp/agent-studio-index-test'),
      quit: vi.fn()
    },
    BrowserWindow: BrowserWindowMock,
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showErrorBox: vi.fn()
    },
    ipcMain: { handle: vi.fn() },
    nativeTheme: {
      shouldUseDarkColors: true,
      themeSource: 'system',
      on: vi.fn(),
      off: vi.fn()
    },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(value)),
      decryptString: vi.fn((value: Buffer) => value.toString()),
      getSelectedStorageBackend: vi.fn(() => 'keychain')
    },
    shell: { openExternal: vi.fn(async () => undefined) }
  }
})

vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  is: { dev: false },
  optimizer: { watchWindowShortcuts: vi.fn() }
}))

vi.mock('../../resources/icon.png?asset', () => ({ default: '/tmp/icon.png' }))

vi.mock('./agent/ipc', () => ({ registerAgentIpcHandlers: vi.fn() }))
vi.mock('./provider/ipc', () => ({
  registerProviderIpcHandlers: vi.fn((dependencies: { operations: ProviderIpcOperations }) => {
    mocks.providerOperations = dependencies.operations
  })
}))
vi.mock('./app-ipc', () => ({
  registerAppIpcHandlers: vi.fn((dependencies: AppDeletionDependencies) => {
    mocks.appDeletionDependencies = dependencies
  })
}))
vi.mock('./agent/task-ipc', () => ({
  registerTaskIpcHandlers: vi.fn((dependencies: TaskDeletionDependencies) => {
    mocks.taskDeletionDependencies = dependencies
  })
}))
vi.mock('./app-shutdown', () => ({
  createAppShutdownGate: vi.fn(() => ({ handleBeforeQuit: vi.fn() }))
}))

vi.mock('./provider/provider-config-store', () => ({
  ProviderConfigStore: class {
    constructor() {
      return mocks.providerStore
    }
  }
}))
vi.mock('./project/project-registry', () => ({
  ProjectRegistry: class {
    constructor() {
      return mocks.projectRegistry
    }
  }
}))
vi.mock('./agent/task-store', () => ({
  TaskStore: class {
    constructor() {
      return mocks.taskStore
    }
  }
}))
vi.mock('./security/permission-audit-store', () => ({
  PermissionAuditStore: class {}
}))
vi.mock('./security/permission-broker', () => ({
  PermissionBroker: class {
    constructor() {
      return mocks.permissionBroker
    }
  }
}))
vi.mock('./provider/provider-connection-tester', () => ({
  ProviderConnectionTester: class {
    constructor() {
      return mocks.providerTester
    }
  }
}))
vi.mock('./runtime/grok/grok-home-config-controller', () => ({
  GrokHomeConfigController: class {
    async read(): Promise<string> {
      return ''
    }
    async apply(): Promise<Record<string, never>> {
      return {}
    }
    async writeText(): Promise<void> {
      return undefined
    }
    async readMemoryEnabled(): Promise<boolean> {
      return true
    }
    async readPluginEnablement(): Promise<Record<string, never>> {
      return {}
    }
  }
}))
vi.mock('./runtime/grok/grok-memory-store', () => ({
  GrokMemoryStore: class {
    async ensureShare(): Promise<string> {
      return 'linked'
    }
    async getEnabledState(): Promise<{ enabled: boolean; shareStatus: string }> {
      return { enabled: true, shareStatus: 'linked' }
    }
    async list(): Promise<unknown[]> {
      return []
    }
  }
}))
vi.mock('./mcp/mcp-server-store', () => ({
  McpServerStore: class {
    async initialize(): Promise<void> {
      return undefined
    }
    async listEnabledResolved(): Promise<unknown[]> {
      return []
    }
    list(): unknown[] {
      return []
    }
    listKnownSecrets(): string[] {
      return []
    }
  }
}))
vi.mock('./mcp/grok-user-mcp-sync', () => ({
  getUserGrokConfigPath: () => '/tmp/agent-studio-index-test/.grok/config.toml',
  syncUserMcpFromHome: vi.fn(async () => undefined),
  listProjectMcpServers: vi.fn(async () => []),
  writeUserMcpServer: vi.fn(async () => undefined),
  removeUserMcpServer: vi.fn(async () => undefined)
}))
vi.mock('./mcp/mcp-server-to-acp', () => ({
  toAgentRuntimeMcpServers: () => []
}))
vi.mock('./runtime/grok/grok-acp-adapter', () => ({
  GrokAcpAdapter: class {
    constructor() {
      return mocks.runtimeAdapter
    }
  }
}))
vi.mock('./agent/agent-service', () => ({
  AgentService: class {
    constructor() {
      return mocks.agentService
    }
  },
  AgentServiceError: class extends Error {}
}))
vi.mock('./agent/task-execution-controller', () => ({
  TaskExecutionController: class {}
}))
vi.mock('./provider/grok-provider-config', () => ({
  clearGrokProviderConfig: vi.fn(async () => undefined),
  getManagedGrokHome: (userDataPath: string) => `${userDataPath}/grok-home`
}))

describe('Main 删除与权限失效编排', () => {
  beforeAll(async () => {
    await import('./index')
    mocks.resolveReady()
    await vi.waitFor(() => {
      expect(mocks.appDeletionDependencies).toBeDefined()
      expect(mocks.taskDeletionDependencies).toBeDefined()
    })
  })

  beforeEach(() => {
    mocks.taskDeletionLease = createDeletionLeaseMock()
    mocks.projectDeletionLease = createDeletionLeaseMock()
    mocks.taskDeletionPreparation = createDeletionPreparationMock()
    mocks.projectDeletionPreparation = createDeletionPreparationMock()
    mocks.taskStore.prepareTaskDeletion.mockImplementation(() => mocks.taskDeletionPreparation)
    mocks.taskStore.prepareProjectHistoryDeletion.mockImplementation(
      () => mocks.projectDeletionPreparation
    )
    mocks.projectRegistry.remove.mockClear()
    mocks.taskStore.deleteProjectHistory.mockClear()
    mocks.taskStore.deleteTask.mockClear()
    mocks.taskStore.prepareTaskDeletion.mockClear()
    mocks.taskStore.prepareProjectHistoryDeletion.mockClear()
    mocks.permissionBroker.beginTaskDeletion.mockClear()
    mocks.permissionBroker.beginProjectDeletion.mockClear()
    mocks.permissionBroker.beginTaskDeletion.mockReset()
    mocks.permissionBroker.beginTaskDeletion.mockImplementation(async () => mocks.taskDeletionLease)
    mocks.permissionBroker.beginProjectDeletion.mockReset()
    mocks.permissionBroker.beginProjectDeletion.mockImplementation(
      async () => mocks.projectDeletionLease
    )
    mocks.permissionBroker.invalidateProject.mockClear()
    mocks.permissionBroker.invalidateTask.mockClear()
    mocks.providerState.runtimeConfig = {
      baseUrl: 'https://provider.test/v1',
      authMode: 'none',
      modelId: 'model-1',
      testedAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z'
    }
    mocks.providerTester.testInference.mockReset()
    mocks.providerTester.testInference.mockResolvedValue({
      ok: true,
      stage: 'inference',
      message: 'ok'
    })
    mocks.providerStore.save.mockClear()
    mocks.providerStore.clear.mockClear()
    mocks.agentService.getStatus.mockReset()
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'idle',
      message: 'idle'
    })
    mocks.agentService.connect.mockReset()
    mocks.agentService.connect.mockResolvedValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready'
    })
    mocks.agentService.disconnect.mockReset()
    mocks.agentService.disconnect.mockResolvedValue({
      runtimeId: 'grok',
      state: 'idle',
      message: 'idle'
    })
  })

  it('Task 删除成功后才失效授权，token 校验失败时保持原授权', async () => {
    const history = mocks.taskDeletionDependencies?.getHistory()
    expect(history).not.toBeNull()
    const deletion = deferred<void>()
    mocks.taskDeletionPreparation.commit.mockImplementationOnce(() => deletion.promise)

    const pending = history!.deleteTask('task-1', 'token-1')
    await vi.waitFor(() =>
      expect(mocks.permissionBroker.beginTaskDeletion).toHaveBeenCalledWith('task-1')
    )
    expect(mocks.taskStore.prepareTaskDeletion).toHaveBeenCalledWith('task-1', 'token-1')
    expect(mocks.taskDeletionLease.commit).not.toHaveBeenCalled()

    deletion.resolve()
    await expect(pending).resolves.toBeUndefined()
    expect(mocks.taskDeletionLease.commit).toHaveBeenCalledOnce()
    expect(mocks.taskDeletionLease.rollback).not.toHaveBeenCalled()

    mocks.taskDeletionLease = createDeletionLeaseMock()
    mocks.permissionBroker.beginTaskDeletion.mockImplementationOnce(
      async () => mocks.taskDeletionLease
    )
    mocks.taskStore.prepareTaskDeletion.mockImplementationOnce(() => {
      throw new Error('删除 token 已失效。')
    })
    await expect(history!.deleteTask('task-1', 'expired-token')).rejects.toThrow(
      '删除 token 已失效。'
    )
    expect(mocks.permissionBroker.beginTaskDeletion).toHaveBeenCalledTimes(1)
    expect(mocks.taskDeletionLease.commit).not.toHaveBeenCalled()
    expect(mocks.taskDeletionLease.rollback).not.toHaveBeenCalled()
  })

  it('Project 历史删除成功后才失效授权，删除失败时不提前失效', async () => {
    const dependencies = mocks.appDeletionDependencies!
    const deletion = deferred<void>()
    mocks.projectDeletionPreparation.commit.mockImplementationOnce(() => deletion.promise)

    const pending = dependencies.deleteProjectHistory('project-1', 'token-1')
    await vi.waitFor(() =>
      expect(mocks.permissionBroker.beginProjectDeletion).toHaveBeenCalledWith('project-1')
    )
    expect(mocks.taskStore.prepareProjectHistoryDeletion).toHaveBeenCalledWith(
      'project-1',
      'token-1'
    )
    expect(mocks.projectDeletionLease.commit).not.toHaveBeenCalled()

    deletion.resolve()
    await expect(pending).resolves.toBeUndefined()
    expect(mocks.projectDeletionLease.commit).toHaveBeenCalledOnce()
    expect(mocks.projectDeletionLease.rollback).not.toHaveBeenCalled()

    mocks.projectDeletionLease = createDeletionLeaseMock()
    mocks.permissionBroker.beginProjectDeletion.mockImplementationOnce(
      async () => mocks.projectDeletionLease
    )
    mocks.taskStore.prepareProjectHistoryDeletion.mockImplementationOnce(() => {
      throw new Error('历史删除失败。')
    })
    await expect(dependencies.deleteProjectHistory('project-1', 'expired-token')).rejects.toThrow(
      '历史删除失败。'
    )
    expect(mocks.permissionBroker.beginProjectDeletion).toHaveBeenCalledTimes(1)
    expect(mocks.projectDeletionLease.commit).not.toHaveBeenCalled()
    expect(mocks.projectDeletionLease.rollback).not.toHaveBeenCalled()
  })

  it('移除 Project 成功后才失效授权，Registry 拒绝时保留授权', async () => {
    const dependencies = mocks.appDeletionDependencies!
    const deletion = deferred<void>()
    mocks.projectRegistry.remove.mockImplementationOnce(() => deletion.promise)

    const pending = dependencies.removeProject('project-1')
    await vi.waitFor(() =>
      expect(mocks.permissionBroker.beginProjectDeletion).toHaveBeenCalledWith('project-1')
    )
    expect(mocks.projectDeletionLease.commit).not.toHaveBeenCalled()

    deletion.resolve()
    await expect(pending).resolves.toBeUndefined()
    expect(mocks.projectDeletionLease.commit).toHaveBeenCalledOnce()
    expect(mocks.projectDeletionLease.rollback).not.toHaveBeenCalled()

    mocks.projectDeletionLease = createDeletionLeaseMock()
    mocks.permissionBroker.beginProjectDeletion.mockImplementationOnce(
      async () => mocks.projectDeletionLease
    )
    mocks.projectRegistry.remove.mockRejectedValueOnce(new Error('Project 仍被活动 Task 使用。'))
    await expect(dependencies.removeProject('project-1')).rejects.toThrow(
      'Project 仍被活动 Task 使用。'
    )
    expect(mocks.projectDeletionLease.commit).not.toHaveBeenCalled()
    expect(mocks.projectDeletionLease.rollback).toHaveBeenCalledOnce()
  })

  it('Broker 冻结失败时恢复删除准备，不执行物理提交', async () => {
    const history = mocks.taskDeletionDependencies?.getHistory()
    mocks.permissionBroker.beginTaskDeletion.mockRejectedValueOnce(new Error('冻结失败。'))

    await expect(history!.deleteTask('task-1', 'token-1')).rejects.toThrow('冻结失败。')
    expect(mocks.taskDeletionPreparation.commit).not.toHaveBeenCalled()
    expect(mocks.taskDeletionPreparation.rollback).toHaveBeenCalledOnce()
  })

  it('物理提交结果未知时不回滚 Broker，并转为失败关闭清理授权', async () => {
    const history = mocks.taskDeletionDependencies?.getHistory()
    mocks.taskDeletionPreparation.commit.mockRejectedValueOnce(new Error('目录同步失败。'))
    mocks.taskDeletionPreparation.rollback.mockReturnValueOnce(false)

    await expect(history!.deleteTask('task-1', 'token-1')).rejects.toThrow('目录同步失败。')
    expect(mocks.taskDeletionLease.rollback).not.toHaveBeenCalled()
    expect(mocks.taskDeletionLease.commit).toHaveBeenCalledOnce()
  })

  it('Broker commit 异常发生在不可逆点后，不再回滚 Store 或授权冻结', async () => {
    const history = mocks.taskDeletionDependencies?.getHistory()
    mocks.taskDeletionLease.commit.mockImplementationOnce(() => {
      throw new Error('内存授权清理失败。')
    })

    await expect(history!.deleteTask('task-1', 'token-1')).rejects.toThrow('内存授权清理失败。')
    expect(mocks.taskDeletionPreparation.commit).toHaveBeenCalledOnce()
    expect(mocks.taskDeletionPreparation.rollback).not.toHaveBeenCalled()
    expect(mocks.taskDeletionLease.rollback).not.toHaveBeenCalled()
  })

  it('Provider save 在首个网络 await 前占用 Gate，并拒绝并发 select/clear', async () => {
    const operations = mocks.providerOperations!
    const inference = deferred<ProviderTestResult>()
    mocks.providerTester.testInference.mockReturnValueOnce(inference.promise)

    const saving = operations.save(providerInput('model-2'))
    await vi.waitFor(() => expect(mocks.providerTester.testInference).toHaveBeenCalledOnce())
    await expect(operations.selectModel({ modelId: 'model-3' })).rejects.toThrow(
      '已有主进程操作正在进行'
    )
    await expect(operations.clear()).rejects.toThrow('已有主进程操作正在进行')
    expect(mocks.providerTester.testInference).toHaveBeenCalledOnce()
    expect(mocks.providerStore.save).not.toHaveBeenCalled()
    expect(mocks.agentService.disconnect).not.toHaveBeenCalled()

    inference.resolve({ ok: true, stage: 'inference', message: 'ok' })
    await expect(saving).resolves.toMatchObject({ configured: true, modelId: 'model-2' })
    expect(mocks.providerStore.save).toHaveBeenCalledOnce()
  })

  it('Provider 失败会释放 Gate，后续 clear 复用同一 lease 并可正常完成', async () => {
    const operations = mocks.providerOperations!
    mocks.providerTester.testInference.mockResolvedValueOnce({
      ok: false,
      stage: 'inference',
      message: '模拟测试失败'
    })

    await expect(operations.save(providerInput('model-failed'))).rejects.toThrow('模拟测试失败')
    mocks.agentService.disconnect.mockImplementationOnce(async (lease) => {
      const currentLease = requireOperationLease(lease)
      expect(currentLease).toMatchObject({ kind: 'provider-mutation' })
      expect(currentLease.isCurrent()).toBe(true)
      return { runtimeId: 'grok', state: 'idle', message: 'idle' }
    })
    await expect(operations.clear()).resolves.toMatchObject({ configured: false })
    expect(mocks.agentService.disconnect).toHaveBeenCalledOnce()
    expect(mocks.providerStore.clear).toHaveBeenCalledOnce()
  })

  it('已连接 Runtime 的 Provider 保存用同一 inherited lease 完成断开与重连', async () => {
    const operations = mocks.providerOperations!
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready',
      workspace: '/tmp/project-1'
    })
    let inheritedLease: OperationLease | null = null
    mocks.agentService.disconnect.mockImplementationOnce(async (lease) => {
      const currentLease = requireOperationLease(lease)
      inheritedLease = currentLease
      expect(currentLease.isCurrent()).toBe(true)
      return { runtimeId: 'grok', state: 'idle', message: 'idle' }
    })
    mocks.agentService.connect.mockImplementationOnce(async (workspace, lease) => {
      const currentLease = requireOperationLease(lease)
      expect(workspace).toBe('/tmp/project-1')
      expect(currentLease).toBe(inheritedLease)
      expect(currentLease.isCurrent()).toBe(true)
      return { runtimeId: 'grok', state: 'ready', message: 'ready', workspace }
    })

    await expect(operations.save(providerInput('model-2'))).resolves.toMatchObject({
      modelId: 'model-2'
    })
    expect(mocks.agentService.disconnect).toHaveBeenCalledOnce()
    expect(mocks.agentService.connect).toHaveBeenCalledOnce()
  })
})

function providerInput(modelId: string): ProviderConfigInput {
  return {
    baseUrl: 'https://provider.test/v1',
    authMode: 'none',
    modelId
  }
}

/** Provider 事务测试必须显式收到 inherited lease，避免可选参数掩盖接线回归。 */
function requireOperationLease(lease: OperationLease | undefined): OperationLease {
  if (!lease) throw new Error('测试预期 Provider 操作传入 inherited lease。')
  return lease
}

/** 构造可控 Promise，用来证明异步删除尚未完成时不会提前失效授权。 */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value?: T | PromiseLike<T>) => void
} {
  let resolve!: (value?: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void
  })
  return { promise, resolve }
}

function createDeletionLeaseMock(): DeletionLease {
  return {
    commit: vi.fn(),
    rollback: vi.fn()
  }
}

function createDeletionPreparationMock(): DeletionPreparation {
  return {
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(() => true)
  }
}

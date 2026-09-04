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
import { DesktopIpcFailure, toDesktopIpcError } from './security/ipc-sender-validation'

type AppDeletionDependencies = {
  removeProject(projectId: string): Promise<void>
  deleteProjectHistory(projectId: string, token: string): Promise<void>
  installPlugin(input: { name: string; trust: boolean }): Promise<null>
  uninstallPlugin(input: { pluginId: string }): Promise<null>
  addMarketplaceSource(input: { gitUrl: string }): Promise<null>
  saveGrokConfig?(text: string): Promise<void>
  getGrokSandbox?(): Promise<{ profile: 'off' | 'workspace' | 'read-only' | 'strict' }>
  setGrokSandbox?(profile: 'off' | 'workspace' | 'read-only' | 'strict'): Promise<{
    profile: 'off' | 'workspace' | 'read-only' | 'strict'
    applied: boolean
  }>
}

type GrokPluginCliInput = {
  grokHome: string
  grokBinary: string
  args: string[]
  timeoutMs: number
}

type TaskDeletionRuntime = {
  deleteTask(taskId: string, token: string): Promise<void>
}

type RuntimeImageStoreInput = {
  taskId: string
  turnId: string
  originalName: string
  mimeType: string
  bytes: Buffer
}

type RuntimeAdapterOptions = {
  getClientVersion?: () => string
  storeRuntimeImage?: (input: RuntimeImageStoreInput) => Promise<{
    attachmentId: string
    attachmentKind: 'image'
    originalName: string
  }>
}

type DeletionPreparation = {
  commit: ReturnType<typeof vi.fn<() => Promise<void>>>
  rollback: ReturnType<typeof vi.fn<() => boolean>>
}

type TaskDeletionDependencies = {
  getHistory(): TaskDeletionRuntime | null
  getGitReview?: () => {
    getChangeSet(taskId: string): Promise<unknown>
    getFileDiff(taskId: string, path: string): Promise<unknown>
    listTurnCheckpoints(taskId: string): Promise<unknown>
    previewLatestTurnRestore?(taskId: string): Promise<unknown>
    restoreLatestTurn?(taskId: string): Promise<unknown>
  } | null
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
    grokHomeConfig: {
      read: vi.fn(async () => ''),
      apply: vi.fn(async () => ({})),
      writeText: vi.fn(async () => undefined),
      readMemoryEnabled: vi.fn(async () => true),
      readPluginEnablement: vi.fn(async () => ({})),
      readSandboxProfile: vi.fn(async () => 'off' as const)
    },
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
      ),
      getSelectedTaskId: vi.fn<() => string | null>(() => null),
      ensureTaskSessionForTurn: vi.fn<
        (taskId: string, inheritedLease?: OperationLease) => Promise<void>
      >(async () => undefined)
    },
    runtimeAdapter: {
      disconnect: vi.fn(async () => undefined),
      getCapabilitySnapshot: vi.fn(() => ({
        runtimeId: 'grok',
        observedAt: '2026-08-17T00:00:00.000Z',
        capabilities: {}
      }))
    },
    runtimeAdapterOptions: undefined as RuntimeAdapterOptions | undefined,
    taskAttachmentInbox: {
      importRuntimeBytes: vi.fn(async (input: RuntimeImageStoreInput) => ({
        attachmentId: 'runtime-attachment-1',
        taskId: input.taskId,
        originalName: input.originalName,
        storedName: input.originalName,
        kind: 'image' as const,
        mimeType: input.mimeType,
        byteSize: input.bytes.byteLength,
        contentHash: 'fake-hash',
        source: 'runtime' as const,
        binding: 'bound' as const,
        turnId: input.turnId,
        createdAt: '2026-08-25T00:00:00.000Z',
        availability: 'ready' as const
      }))
    },
    projectRegistry: {
      initialize: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      register: vi.fn(async () => null),
      remove: vi.fn<(_projectId: string) => Promise<void>>(async () => undefined),
      findActiveProjectIdByRoot: vi.fn<(workspace: string) => string | null>((workspace) =>
        workspace === '/tmp/project-1' ? 'project-1' : null
      )
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
    runGrokPlugin: vi.fn<
      (
        input: GrokPluginCliInput
      ) => Promise<{ ok: true; stdout: string } | { ok: false; message: string }>
    >(async () => ({
      ok: true,
      stdout: ''
    })),
    ensureGrokMarketplaceSource: vi.fn<
      (
        input: GrokPluginCliInput & { gitUrl: string }
      ) => Promise<{ ok: true; stdout: string } | { ok: false; message: string }>
    >(async () => ({
      ok: true,
      stdout: ''
    })),
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
      setWindowOpenHandler: vi.fn(),
      getZoomFactor: vi.fn(() => 1),
      setZoomFactor: vi.fn(),
      on: vi.fn()
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
      getVersion: vi.fn(() => '0.1.0'),
      isPackaged: false,
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
    shell: { openExternal: vi.fn(async () => undefined) },
    clipboard: {
      readImage: vi.fn(() => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })),
      read: vi.fn(() => '')
    },
    nativeImage: {
      createFromBuffer: vi.fn(() => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
        resize: vi.fn(),
        toJPEG: vi.fn(() => Buffer.alloc(0))
      }))
    },
    Menu: {
      buildFromTemplate: vi.fn((template: unknown) => template),
      setApplicationMenu: vi.fn()
    }
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
vi.mock('./agent/task-attachment-inbox', () => ({
  TaskAttachmentInbox: class {
    constructor() {
      return mocks.taskAttachmentInbox
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
    constructor() {
      return mocks.grokHomeConfig
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
    constructor(_sink: unknown, options: RuntimeAdapterOptions) {
      mocks.runtimeAdapterOptions = options
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
  AGENT_STUDIO_MODEL_API_KEY_ENV: 'AGENT_STUDIO_MODEL_API_KEY',
  clearGrokProviderConfig: vi.fn(async () => undefined),
  getManagedGrokHome: (userDataPath: string) => `${userDataPath}/grok-home`
}))
vi.mock('./runtime/grok/grok-plugin-cli', () => ({
  grokPluginLeaderSocket: (grokHome: string) => `${grokHome}/studio-plugin.sock`,
  GROK_PLUGIN_CLI_TIMEOUT_MS: 900_000,
  runGrokPlugin: mocks.runGrokPlugin,
  ensureGrokMarketplaceSource: mocks.ensureGrokMarketplaceSource
}))
vi.mock('./runtime/grok/grok-marketplace-inventory', () => ({
  listGrokMarketplacePlugins: vi.fn(async () => [])
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
    mocks.agentService.getSelectedTaskId.mockReset()
    mocks.agentService.getSelectedTaskId.mockReturnValue(null)
    mocks.agentService.ensureTaskSessionForTurn.mockReset()
    mocks.agentService.ensureTaskSessionForTurn.mockResolvedValue(undefined)
    mocks.taskAttachmentInbox.importRuntimeBytes.mockClear()
    mocks.projectRegistry.findActiveProjectIdByRoot.mockReset()
    mocks.projectRegistry.findActiveProjectIdByRoot.mockImplementation((workspace) =>
      workspace === '/tmp/project-1' ? 'project-1' : null
    )
    mocks.grokHomeConfig.apply.mockClear()
    mocks.grokHomeConfig.readSandboxProfile.mockReset()
    mocks.grokHomeConfig.readSandboxProfile.mockResolvedValue('off')
  })

  it('组装层把 GitReviewService 交给 task:* 只读审阅 IPC', () => {
    const review = mocks.taskDeletionDependencies?.getGitReview?.()
    expect(review).toBeTruthy()
    expect(typeof review?.getChangeSet).toBe('function')
    expect(typeof review?.getFileDiff).toBe('function')
    expect(typeof review?.listTurnCheckpoints).toBe('function')
    expect(typeof review?.previewLatestTurnRestore).toBe('function')
    expect(typeof review?.restoreLatestTurn).toBe('function')
  })

  it('组装层注入开发态 clientInfo.version，不把版本拼装交给 Renderer', () => {
    expect(mocks.runtimeAdapterOptions?.getClientVersion).toBeTypeOf('function')
    expect(mocks.runtimeAdapterOptions?.getClientVersion?.()).toBe('0.1.0-dev')
  })

  it('组装层把 Runtime 图片原子写入 Task 附件柜后只返回有限引用', async () => {
    const storeRuntimeImage = mocks.runtimeAdapterOptions?.storeRuntimeImage
    expect(storeRuntimeImage).toBeTypeOf('function')
    const input: RuntimeImageStoreInput = {
      taskId: 'task-1',
      turnId: 'turn-1',
      originalName: 'runtime-image.png',
      mimeType: 'image/png',
      bytes: Buffer.from('fake-image')
    }

    await expect(storeRuntimeImage!(input)).resolves.toEqual({
      attachmentId: 'runtime-attachment-1',
      attachmentKind: 'image',
      originalName: 'runtime-image.png'
    })
    expect(mocks.taskAttachmentInbox.importRuntimeBytes).toHaveBeenCalledWith(input)
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
    mocks.agentService.connect.mockImplementationOnce(async (projectId, lease) => {
      const currentLease = requireOperationLease(lease)
      expect(projectId).toBe('project-1')
      expect(currentLease).toBe(inheritedLease)
      expect(currentLease.isCurrent()).toBe(true)
      return { runtimeId: 'grok', state: 'ready', message: 'ready', workspace: '/tmp/project-1' }
    })

    await expect(operations.save(providerInput('model-2'))).resolves.toMatchObject({
      modelId: 'model-2'
    })
    expect(mocks.agentService.disconnect).toHaveBeenCalledOnce()
    expect(mocks.agentService.connect).toHaveBeenCalledWith('project-1', inheritedLease)
    expect(mocks.agentService.ensureTaskSessionForTurn).not.toHaveBeenCalled()
  })

  it('已连接并打开对话时，切换模型按 Project ID 重连并恢复当前 Task', async () => {
    const operations = mocks.providerOperations!
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready',
      workspace: '/tmp/project-1'
    })
    mocks.agentService.getSelectedTaskId.mockReturnValue('task-1')
    let inheritedLease: OperationLease | null = null
    mocks.agentService.disconnect.mockImplementationOnce(async (lease) => {
      inheritedLease = requireOperationLease(lease)
      return { runtimeId: 'grok', state: 'idle', message: 'idle' }
    })
    mocks.agentService.connect.mockImplementationOnce(async (projectId, lease) => {
      expect(projectId).toBe('project-1')
      expect(lease).toBe(inheritedLease)
      return { runtimeId: 'grok', state: 'ready', message: 'ready', workspace: '/tmp/project-1' }
    })
    mocks.agentService.ensureTaskSessionForTurn.mockImplementationOnce(async (taskId, lease) => {
      expect(taskId).toBe('task-1')
      expect(lease).toBe(inheritedLease)
    })

    await expect(operations.selectModel({ modelId: 'deepseek-chat' })).resolves.toMatchObject({
      modelId: 'deepseek-chat'
    })
    expect(mocks.agentService.connect).toHaveBeenCalledWith('project-1', inheritedLease)
    expect(mocks.agentService.ensureTaskSessionForTurn).toHaveBeenCalledWith(
      'task-1',
      inheritedLease
    )
  })

  it('已连接但反查不到 Project ID 时拒绝切换，避免把路径当身份重连', async () => {
    const operations = mocks.providerOperations!
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready',
      workspace: '/tmp/unknown-project'
    })
    mocks.projectRegistry.findActiveProjectIdByRoot.mockReturnValueOnce(null)

    await expect(operations.selectModel({ modelId: 'deepseek-chat' })).rejects.toThrow(
      '当前连接没有有效的 Project'
    )
    expect(mocks.providerStore.save).not.toHaveBeenCalled()
    expect(mocks.agentService.disconnect).not.toHaveBeenCalled()
    expect(mocks.agentService.connect).not.toHaveBeenCalled()
  })

  it('未连接时保存 Grok 配置只写文件，不重连 Runtime', async () => {
    await mocks.appDeletionDependencies!.saveGrokConfig!(
      '[model.agent-studio-default]\nmodel = "m"\ncontext_window = 500000\n'
    )
    expect(mocks.agentService.disconnect).not.toHaveBeenCalled()
    expect(mocks.agentService.connect).not.toHaveBeenCalled()
  })

  it('已连接空闲时保存 Grok 配置会断开并按 Project ID 重连', async () => {
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready',
      workspace: '/tmp/project-1'
    })
    mocks.agentService.getSelectedTaskId.mockReturnValue('task-1')

    await mocks.appDeletionDependencies!.saveGrokConfig!(
      '[model.agent-studio-default]\nmodel = "m"\ncontext_window = 500000\n'
    )

    expect(mocks.agentService.disconnect).toHaveBeenCalledOnce()
    expect(mocks.agentService.connect).toHaveBeenCalledWith('project-1', undefined)
    expect(mocks.agentService.ensureTaskSessionForTurn).toHaveBeenCalledWith('task-1', undefined)
  })

  it.each(['busy', 'connecting'] as const)(
    'Agent status 为 %s 时拒绝保存 Grok 配置，避免旧进程继续按旧窗口 compact',
    async (state) => {
      mocks.agentService.getStatus.mockReturnValue({
        runtimeId: 'grok',
        state,
        message: state,
        workspace: '/tmp/project-1'
      })
      await expect(
        mocks.appDeletionDependencies!.saveGrokConfig!(
          '[model.agent-studio-default]\nmodel = "m"\ncontext_window = 500000\n'
        )
      ).rejects.toThrow('任务执行中，结束后才能保存并重载 Grok 配置。')
      expect(mocks.agentService.disconnect).not.toHaveBeenCalled()
    }
  )

  it('未连接时设置 sandbox 只写盘并 applied true，不重连', async () => {
    expect(await mocks.appDeletionDependencies!.getGrokSandbox!()).toEqual({ profile: 'off' })
    expect(await mocks.appDeletionDependencies!.setGrokSandbox!('workspace')).toEqual({
      profile: 'workspace',
      applied: true
    })
    expect(mocks.grokHomeConfig.apply).toHaveBeenCalledWith({ sandboxProfile: 'workspace' })
    expect(mocks.agentService.disconnect).not.toHaveBeenCalled()
    expect(mocks.agentService.connect).not.toHaveBeenCalled()
  })

  it('已连接空闲时设置 sandbox 会写盘并按 Project ID 重连', async () => {
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready',
      workspace: '/tmp/project-1'
    })
    mocks.agentService.getSelectedTaskId.mockReturnValue('task-1')

    expect(await mocks.appDeletionDependencies!.setGrokSandbox!('strict')).toEqual({
      profile: 'strict',
      applied: true
    })
    expect(mocks.grokHomeConfig.apply).toHaveBeenCalledWith({ sandboxProfile: 'strict' })
    expect(mocks.agentService.disconnect).toHaveBeenCalledOnce()
    expect(mocks.agentService.connect).toHaveBeenCalledWith('project-1', undefined)
    expect(mocks.agentService.ensureTaskSessionForTurn).toHaveBeenCalledWith('task-1', undefined)
  })

  it.each(['busy', 'connecting'] as const)(
    'Agent status 为 %s 时拒绝改 sandbox，不写文件',
    async (state) => {
      mocks.agentService.getStatus.mockReturnValue({
        runtimeId: 'grok',
        state,
        message: state,
        workspace: '/tmp/project-1'
      })
      await expect(mocks.appDeletionDependencies!.setGrokSandbox!('workspace')).rejects.toThrow(
        '任务执行中，结束后才能保存并重载 Grok 配置。'
      )
      expect(mocks.grokHomeConfig.apply).not.toHaveBeenCalled()
      expect(mocks.agentService.disconnect).not.toHaveBeenCalled()
    }
  )

  it('文件已写但重载失败时不得返回 applied true，也不静默改回 off', async () => {
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready',
      workspace: '/tmp/project-1'
    })
    mocks.agentService.connect.mockRejectedValueOnce(new Error('session sandbox 与当前进程不一致'))

    await expect(mocks.appDeletionDependencies!.setGrokSandbox!('read-only')).rejects.toThrow(
      /sandbox/
    )
    expect(mocks.grokHomeConfig.apply).toHaveBeenCalledWith({ sandboxProfile: 'read-only' })
    expect(mocks.grokHomeConfig.apply).not.toHaveBeenCalledWith({ sandboxProfile: 'off' })
    expect(mocks.agentService.disconnect).toHaveBeenCalledOnce()
  })

  it.each(['busy', 'connecting'] as const)(
    'Agent status 为 %s 时 save/select 拒绝修改，且不 save、不断开',
    async (state) => {
      const operations = mocks.providerOperations!
      mocks.agentService.getStatus.mockReturnValue({
        runtimeId: 'grok',
        state,
        message: state,
        workspace: '/tmp/project-1'
      })

      await expect(operations.save(providerInput('model-busy'))).rejects.toThrow(
        '任务执行中，结束后才能修改模型配置。'
      )
      await expect(operations.selectModel({ modelId: 'model-busy-select' })).rejects.toThrow(
        '任务执行中，结束后才能修改模型配置。'
      )
      expect(mocks.providerStore.save).not.toHaveBeenCalled()
      expect(mocks.agentService.disconnect).not.toHaveBeenCalled()
      expect(mocks.agentService.connect).not.toHaveBeenCalled()
    }
  )

  it('ready 时重连失败会回滚到旧 Provider 配置', async () => {
    const operations = mocks.providerOperations!
    const previous = {
      baseUrl: 'https://provider.test/v1',
      authMode: 'none' as const,
      modelId: 'model-1',
      testedAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z'
    }
    mocks.providerState.runtimeConfig = { ...previous }
    mocks.agentService.getStatus.mockReturnValue({
      runtimeId: 'grok',
      state: 'ready',
      message: 'ready',
      workspace: '/tmp/project-1'
    })
    mocks.agentService.connect.mockRejectedValueOnce(new Error('模拟重连失败'))

    await expect(operations.save(providerInput('model-2'))).rejects.toThrow('模拟重连失败')

    expect(mocks.agentService.disconnect).toHaveBeenCalledOnce()
    expect(mocks.providerStore.save).toHaveBeenCalledTimes(2)
    expect(mocks.providerStore.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ modelId: 'model-2' }),
      expect.objectContaining({ testedAt: expect.any(String) })
    )
    expect(mocks.providerStore.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        baseUrl: previous.baseUrl,
        authMode: previous.authMode,
        modelId: previous.modelId
      }),
      { testedAt: previous.testedAt }
    )
  })

  it('插件安装 trust 非 true 时 CLI argv 不含 --trust，且不回传 stdout', async () => {
    mocks.runGrokPlugin.mockReset()
    mocks.runGrokPlugin.mockResolvedValue({
      ok: true,
      stdout: '/secret/grok-home/installed-plugins/chrome-devtools'
    })
    const dependencies = mocks.appDeletionDependencies!
    await expect(
      dependencies.installPlugin({ name: 'chrome-devtools', trust: false })
    ).resolves.toBeNull()
    expect(mocks.runGrokPlugin).toHaveBeenCalledWith({
      grokHome: '/tmp/agent-studio-index-test/grok-home',
      grokBinary: expect.any(String),
      args: ['plugin', 'install', 'chrome-devtools'],
      timeoutMs: 900_000
    })
    expect(mocks.runGrokPlugin.mock.calls[0]?.[0]?.args).not.toContain('--trust')
    expect(mocks.agentService.disconnect).not.toHaveBeenCalled()

    await expect(
      dependencies.installPlugin({ name: 'chrome-devtools', trust: true })
    ).resolves.toBeNull()
    expect(mocks.runGrokPlugin).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: ['plugin', 'install', 'chrome-devtools', '--trust'],
        timeoutMs: 900_000
      })
    )
  })

  it('卸载附加 --confirm 且不加 --keep-data；加源走幂等 ensure 而不是直接 add', async () => {
    mocks.runGrokPlugin.mockReset()
    mocks.runGrokPlugin.mockResolvedValue({ ok: true, stdout: '' })
    mocks.ensureGrokMarketplaceSource.mockReset()
    mocks.ensureGrokMarketplaceSource.mockResolvedValue({ ok: true, stdout: '' })
    const dependencies = mocks.appDeletionDependencies!
    const official = 'https://github.com/xai-org/plugin-marketplace.git'

    await expect(
      dependencies.uninstallPlugin({ pluginId: 'chrome-devtools-mcp' })
    ).resolves.toBeNull()
    expect(mocks.runGrokPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['plugin', 'uninstall', 'chrome-devtools-mcp', '--confirm'],
        timeoutMs: 900_000
      })
    )
    expect(mocks.runGrokPlugin.mock.calls[0]?.[0]?.args).not.toContain('--keep-data')

    await expect(dependencies.addMarketplaceSource({ gitUrl: official })).resolves.toBeNull()
    expect(mocks.ensureGrokMarketplaceSource).toHaveBeenCalledWith(
      expect.objectContaining({
        grokHome: '/tmp/agent-studio-index-test/grok-home',
        gitUrl: official,
        timeoutMs: 900_000
      })
    )
    expect(
      mocks.runGrokPlugin.mock.calls.some((call) => call[0]?.args?.includes('marketplace'))
    ).toBe(false)
  })

  it('CLI 失败抛普通 Error，IPC 脱敏后不含绝对路径与 URL', async () => {
    mocks.runGrokPlugin.mockReset()
    mocks.runGrokPlugin.mockResolvedValue({
      ok: false,
      message: 'clone failed /Users/secret/project/file.ts https://evil.example/repo.git'
    })
    const dependencies = mocks.appDeletionDependencies!
    let caught: unknown
    try {
      await dependencies.installPlugin({ name: 'chrome-devtools', trust: true })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(DesktopIpcFailure)

    const ipcError = toDesktopIpcError(caught, (value) =>
      value instanceof Error ? value.message : String(value)
    )
    expect(ipcError.code).toBe('operation-failed')
    expect(ipcError.message).not.toContain('/Users/secret')
    expect(ipcError.message).not.toContain('file.ts')
    expect(ipcError.message).not.toContain('evil.example')
    expect(ipcError.message).not.toContain('https://')
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

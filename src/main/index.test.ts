import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

  return {
    ready,
    resolveReady,
    appDeletionDependencies: undefined as AppDeletionDependencies | undefined,
    taskDeletionDependencies: undefined as TaskDeletionDependencies | undefined,
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
vi.mock('./provider/ipc', () => ({ registerProviderIpcHandlers: vi.fn() }))
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
    initialize(): Promise<void> {
      return Promise.resolve()
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
  ProviderConnectionTester: class {}
}))
vi.mock('./runtime/grok/grok-acp-adapter', () => ({
  GrokAcpAdapter: class {
    disconnect(): Promise<void> {
      return Promise.resolve()
    }
  }
}))
vi.mock('./agent/agent-service', () => ({
  AgentService: class {}
}))
vi.mock('./agent/task-execution-controller', () => ({
  TaskExecutionController: class {}
}))
vi.mock('./provider/grok-provider-config', () => ({
  clearGrokProviderConfig: vi.fn(async () => undefined)
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
})

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

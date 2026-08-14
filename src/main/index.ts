import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { AGENT_PUSH_CHANNELS } from '../shared/agent-ipc'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption
} from '../shared/provider'
import { AgentService } from './agent/agent-service'
import { registerAgentIpcHandlers } from './agent/ipc'
import { registerTaskIpcHandlers } from './agent/task-ipc'
import { TaskStore } from './agent/task-store'
import { TaskExecutionController } from './agent/task-execution-controller'
import { registerAppIpcHandlers } from './app-ipc'
import { createAppShutdownGate } from './app-shutdown'
import {
  resolveControlledAcpE2eBootstrap,
  type ControlledAcpE2eBootstrap
} from './e2e/controlled-acp-e2e-bootstrap'
import type { DesktopIpcMain } from './ipc-types'
import { ProviderConfigStore, type ProviderRuntimeConfig } from './provider/provider-config-store'
import { ProviderConnectionTester } from './provider/provider-connection-tester'
import { ProjectRegistry } from './project/project-registry'
import { clearGrokProviderConfig } from './provider/grok-provider-config'
import { registerProviderIpcHandlers } from './provider/ipc'
import { validateProviderConfigInput } from './provider/provider-validation'
import { GrokAcpAdapter } from './runtime/grok/grok-acp-adapter'
import { PermissionAuditStore } from './security/permission-audit-store'
import { PermissionBroker } from './security/permission-broker'
import { createLocalEnvironmentId } from './security/permission-policy'
import {
  assertTrustedIpcSender,
  sendToTrustedRenderer,
  toDesktopIpcError,
  type RendererTrustOptions
} from './security/ipc-sender-validation'
import { redactSensitiveError, redactSensitiveText } from './security/sensitive-redaction'

let mainWindow: BrowserWindow | null = null
let agentService: AgentService | null = null
let runtimeAdapter: GrokAcpAdapter | null = null
let providerStore: ProviderConfigStore | null = null
let providerTester: ProviderConnectionTester | null = null
let projectRegistry: ProjectRegistry | null = null
let taskStore: TaskStore | null = null
let permissionAuditStore: PermissionAuditStore | null = null
let permissionBroker: PermissionBroker | null = null

/** 创建应用主窗口，并限制渲染层直接访问系统能力。 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 17 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** safeStorage 只能在 app.whenReady() 后注入，避免模块加载阶段提前访问系统密钥库。 */
async function initializeServices(controlledE2e: ControlledAcpE2eBootstrap | null): Promise<void> {
  providerStore = new ProviderConfigStore({
    userDataPath: app.getPath('userData'),
    platform: process.platform,
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plainText) => safeStorage.encryptString(plainText),
      decryptString: (encryptedValue) => safeStorage.decryptString(encryptedValue),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend()
    }
  })
  await providerStore.initialize()
  providerTester = new ProviderConnectionTester({ redact: redactProviderText })
  if (controlledE2e) {
    // 受控 E2E 只验证 127.0.0.1 无认证 Mock Provider；失败时终止启动，绝不读取真实配置。
    const config = validateProviderConfigInput(controlledE2e.providerConfig)
    const result = await providerTester.testInference(config)
    if (!result.ok) throw new Error('受控 ACP Runtime E2E Mock Provider 验证失败。')
    await providerStore.save(config, { testedAt: new Date().toISOString() })
  }
  projectRegistry = new ProjectRegistry({ userDataPath: app.getPath('userData') })
  await projectRegistry.initialize()
  if (controlledE2e) {
    // Project 由 Main 注册，避免 E2E 借助 Renderer 或系统目录选择框传入工作区路径。
    await projectRegistry.register(controlledE2e.workspacePath)
  }
  taskStore = new TaskStore({ projectRegistry })
  await taskStore.initialize()
  permissionAuditStore = new PermissionAuditStore({
    projectRegistry,
    getTaskIdentity: (taskId) => {
      const task = requireTaskStore().getTaskRecord(taskId)
      return { taskId: task.taskId, projectId: task.projectId }
    },
    ensureHistoryCapacity: (taskId, additionalBytes) =>
      requireTaskStore().ensureAdditionalHistoryCapacity(taskId, additionalBytes),
    beginTaskHistoryMutation: (taskId) => requireTaskStore().beginTaskHistoryMutation(taskId)
  })
  permissionBroker = new PermissionBroker({
    auditStore: permissionAuditStore,
    onApproval: (request) =>
      sendToTrustedRenderer(createRendererTrustOptions(), AGENT_PUSH_CHANNELS.permission, request),
    onApprovalCancelled: (request) => {
      sendToTrustedRenderer(
        createRendererTrustOptions(),
        AGENT_PUSH_CHANNELS.permissionCancelled,
        request
      )
    },
    resolveIntentContext: (taskId, turnId) => {
      try {
        const task = requireTaskStore().getTaskRecord(taskId)
        if (task.environment.kind !== 'local') return null
        return {
          taskId: task.taskId,
          turnId: task.activeTurnId ?? '',
          projectId: task.projectId,
          executionRoot: task.environment.rootSnapshot,
          environmentId: createLocalEnvironmentId(task.projectId, task.environment.rootSnapshot),
          runtimeId: task.runtimeId,
          environmentKind: 'local',
          active:
            task.activeTurnId === turnId &&
            (task.state === 'running' || task.state === 'waiting-permission')
        }
      } catch {
        return null
      }
    },
    redactText: redactProviderText
  })

  const rendererTrust = createRendererTrustOptions()
  const adapter = new GrokAcpAdapter(
    {
      onStatus: (status) =>
        sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.status, status),
      onEvent: (event) => {
        // 先收束主进程状态，再向 Renderer 发布，避免 UI 先看到终态而执行槽尚未释放。
        agentService?.handleRuntimeEvent(event)
        sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.event, event)
      },
      onPermission: (request) => {
        const service = agentService
        if (!service) {
          runtimeAdapter?.respondPermission(request.requestId, 'cancelled')
          return
        }
        service.handlePermissionRequest(request)
      },
      onPermissionCancelled: (request) => {
        agentService?.handlePermissionCancellation(request)
      }
    },
    {
      userDataPath: app.getPath('userData'),
      getProviderConfig: () => requireProviderStore().getRuntimeConfig(),
      redactText: redactProviderText,
      ...(controlledE2e ? { controlledFixture: controlledE2e.fixture } : {})
    }
  )
  runtimeAdapter = adapter
  agentService = new AgentService(adapter, new TaskExecutionController(), {
    projectRegistry,
    taskStore,
    getTurnModel: () => {
      const config = requireProviderRuntimeConfig()
      return {
        modelId: config.modelId,
        ...(config.modelDisplayName ? { displayName: config.modelDisplayName } : {})
      }
    },
    redactText: redactProviderText,
    permissionBroker: requirePermissionBroker()
  })
}

/** 注册渲染层可调用的最小 IPC 接口。 */
function registerIpcHandlers(): void {
  const rendererTrust = createRendererTrustOptions()
  const desktopIpcMain: DesktopIpcMain = {
    handle: (channel, listener) => {
      ipcMain.handle(channel, (event, ...args) => listener(event, ...args))
    }
  }
  const assertTrustedSender = (event: Parameters<typeof assertTrustedIpcSender>[0]): void => {
    assertTrustedIpcSender(event, rendererTrust)
  }

  registerAgentIpcHandlers({
    ipcMain: desktopIpcMain,
    assertTrustedSender,
    getAgent: () => agentService,
    sanitizeError: (error) => redactSensitiveError(error, getKnownSecrets())
  })

  registerAppIpcHandlers({
    ipcMain: desktopIpcMain,
    assertTrustedSender,
    chooseProject: chooseProject,
    listProjects: () => requireProjectRegistry().list(),
    removeProject: async (projectId) => {
      const deletionLease = await requirePermissionBroker().beginProjectDeletion(projectId)
      try {
        await requireProjectRegistry().remove(projectId)
      } catch (error) {
        deletionLease.rollback()
        throw error
      }
      // Registry 已提交后禁止 rollback；Broker commit 只做同步内存清理并保持失败关闭。
      deletionLease.commit()
    },
    previewProjectHistoryDeletion: (projectId) =>
      requireTaskStore().previewProjectDeletion(projectId),
    deleteProjectHistory: async (projectId, token) => {
      const preparation = requireTaskStore().prepareProjectHistoryDeletion(projectId, token)
      let deletionLease: Awaited<ReturnType<PermissionBroker['beginProjectDeletion']>>
      try {
        deletionLease = await requirePermissionBroker().beginProjectDeletion(projectId)
      } catch (error) {
        preparation.rollback()
        throw error
      }
      try {
        await preparation.commit()
      } catch (error) {
        const rollbackSafe = preparation.rollback()
        if (rollbackSafe) deletionLease.rollback()
        else deletionLease.commit()
        throw error
      }
      // 历史目录已越过 rename 提交点，后续不得恢复 token 或旧授权。
      deletionLease.commit()
    },
    sanitizeError: (error) => redactSensitiveError(error, getKnownSecrets())
  })

  registerTaskIpcHandlers({
    ipcMain: desktopIpcMain,
    assertTrustedSender,
    getHistory: () => {
      const store = taskStore
      const service = agentService
      if (!store || !service) return null
      return {
        listTasks: (projectId, cursor, limit) => store.listTasks(projectId, cursor, limit),
        getTaskDetail: (taskId) => store.getTaskDetail(taskId),
        listTurns: (taskId, cursor, limit) => store.listTurns(taskId, cursor, limit),
        listEvents: (taskId, turnId, afterSequence, limit) =>
          store.listEvents(taskId, turnId, afterSequence, limit),
        listPermissionAudits: (taskId, cursor, limit) =>
          requirePermissionAuditStore().list(taskId, cursor, limit),
        resumeTask: (taskId) => service.resumeTask(taskId),
        previewTaskDeletion: (taskId) => store.previewTaskDeletion(taskId),
        deleteTask: async (taskId, token) => {
          const preparation = store.prepareTaskDeletion(taskId, token)
          let deletionLease: Awaited<ReturnType<PermissionBroker['beginTaskDeletion']>>
          try {
            deletionLease = await requirePermissionBroker().beginTaskDeletion(taskId)
          } catch (error) {
            preparation.rollback()
            throw error
          }
          try {
            await preparation.commit()
          } catch (error) {
            const rollbackSafe = preparation.rollback()
            if (rollbackSafe) deletionLease.rollback()
            else deletionLease.commit()
            throw error
          }
          // 物理删除完成后只允许提交内存授权清理，绝不再走 rollback。
          deletionLease.commit()
        }
      }
    },
    sanitizeError: (error) => redactSensitiveError(error, getKnownSecrets())
  })

  registerProviderIpcHandlers({
    ipcMain: desktopIpcMain,
    assertTrustedSender,
    operations: {
      getSummary: () => requireProviderStore().getSummary(),
      listModels: (input?: ProviderConnectionInput) =>
        runProviderOperation(async () => {
          const resolvedInput = input
            ? attachStoredCredential(input)
            : toConnectionInput(requireProviderRuntimeConfig())
          return requireProviderTester().listModels(resolvedInput)
        }),
      save: (input: ProviderConfigInput) =>
        runProviderOperation(async () => {
          const resolvedInput = validateProviderConfigInput(attachStoredCredential(input))
          const result = await requireProviderTester().testInference(resolvedInput)
          if (!result.ok) throw new Error(result.message)
          return persistProviderConfig(resolvedInput)
        }),
      selectModel: (model: ProviderModelOption) =>
        runProviderOperation(async () => {
          const current = requireProviderRuntimeConfig()
          if (!model || typeof model.modelId !== 'string') throw new Error('请选择有效模型。')

          const nextInput = validateProviderConfigInput({
            ...current,
            modelId: model.modelId,
            modelDisplayName: model.displayName
          })
          const result = await requireProviderTester().testInference(nextInput)
          if (!result.ok) throw new Error(result.message)
          return persistProviderConfig(nextInput)
        }),
      clear: () =>
        runProviderOperation(async () => {
          await requireAgentService().disconnect()
          const summary = await requireProviderStore().clear()
          await clearGrokProviderConfig(app.getPath('userData'))
          return summary
        })
    }
  })
}

/** 打开目录选择器；用户取消属于成功结果，不改变当前工作区。 */
async function openWorkspaceDialog(): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择 Agent Studio 工作目录',
    properties: ['openDirectory', 'createDirectory']
  }
  const currentWindow = mainWindow
  const result =
    currentWindow && !currentWindow.isDestroyed()
      ? await dialog.showOpenDialog(currentWindow, options)
      : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

/** Dialog 返回的路径只留在主进程，由 Registry 注册后再返回有限 Project 摘要。 */
async function chooseProject(): Promise<import('../shared/task-history').ProjectSummary | null> {
  const selected = await openWorkspaceDialog()
  return selected ? requireProjectRegistry().register(selected) : null
}

/** 来源验证与事件推送都动态读取当前窗口，兼容 macOS 关闭后重建窗口。 */
function createRendererTrustOptions(): RendererTrustOptions {
  return {
    getMainWindow: () => mainWindow,
    ...(is.dev && process.env.ELECTRON_RENDERER_URL
      ? { developmentUrl: process.env.ELECTRON_RENDERER_URL }
      : {}),
    productionFileUrl: pathToFileURL(join(__dirname, '../renderer/index.html')).href
  }
}

/** Provider 变更需要与已连接 Runtime 保持事务一致，失败时恢复旧配置。 */
async function persistProviderConfig(input: ProviderConfigInput): Promise<ProviderConfigSummary> {
  const currentAgent = requireAgentService()
  const store = requireProviderStore()
  const previous = store.getRuntimeConfig()
  const status = currentAgent.getStatus()

  if (
    currentAgent.hasInFlightOperation() ||
    status.state === 'busy' ||
    status.state === 'connecting'
  ) {
    throw new Error('任务执行中，结束后才能修改模型配置。')
  }

  const workspace = status.state === 'ready' ? status.workspace : undefined
  const nextSummary = await store.save(input, { testedAt: new Date().toISOString() })
  if (!workspace) return nextSummary

  await currentAgent.disconnect()
  try {
    await currentAgent.connect(workspace)
    return nextSummary
  } catch (error) {
    if (previous) {
      await store.save(previous, { testedAt: previous.testedAt })
      await currentAgent.connect(workspace).catch(() => undefined)
    }
    throw error
  }
}

/** Bearer 表单留空时仅允许复用相同 origin 下已安全保存的 Key。 */
function attachStoredCredential<T extends ProviderConnectionInput>(input: T): T {
  if (input.authMode !== 'bearer' || input.apiKey?.trim()) return input

  const current = requireProviderStore().getRuntimeConfig()
  if (!current?.apiKey || !hasSameOrigin(input.baseUrl, current.baseUrl)) return input
  return { ...input, apiKey: current.apiKey }
}

function hasSameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

function toConnectionInput(config: ProviderRuntimeConfig): ProviderConnectionInput {
  return {
    baseUrl: config.baseUrl,
    authMode: config.authMode,
    ...(config.apiKey ? { apiKey: config.apiKey } : {})
  }
}

function requireProviderRuntimeConfig(): ProviderRuntimeConfig {
  const config = requireProviderStore().getRuntimeConfig()
  if (!config) throw new Error('已保存的模型服务配置不可用，请重新配置。')
  return config
}

async function runProviderOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new Error(
      toDesktopIpcError(error, (value) => redactSensitiveError(value, getKnownSecrets())).message
    )
  }
}

function redactProviderText(text: string): string {
  return redactSensitiveText(text, getKnownSecrets())
}

function getKnownSecrets(): string[] {
  const apiKey = providerStore?.getRuntimeConfig()?.apiKey
  return apiKey ? [apiKey] : []
}

function requireAgentService(): AgentService {
  if (!agentService) throw new Error('Agent Runtime 尚未初始化。')
  return agentService
}

function requireProviderStore(): ProviderConfigStore {
  if (!providerStore) throw new Error('Provider 配置服务尚未初始化。')
  return providerStore
}

function requireProviderTester(): ProviderConnectionTester {
  if (!providerTester) throw new Error('Provider 连接测试服务尚未初始化。')
  return providerTester
}

function requireProjectRegistry(): ProjectRegistry {
  if (!projectRegistry) throw new Error('Project Registry 尚未初始化。')
  return projectRegistry
}

function requireTaskStore(): TaskStore {
  if (!taskStore) throw new Error('Task 历史服务尚未初始化。')
  return taskStore
}

function requirePermissionAuditStore(): PermissionAuditStore {
  if (!permissionAuditStore) throw new Error('权限审计服务尚未初始化。')
  return permissionAuditStore
}

function requirePermissionBroker(): PermissionBroker {
  if (!permissionBroker) throw new Error('权限 Broker 尚未初始化。')
  return permissionBroker
}

/**
 * 受控 E2E 必须在单实例锁和任何服务初始化前切换到已校验的临时 userData。
 * 参数残缺、非开发态或路径越界都会直接失败关闭，不能回退到用户真实 Profile。
 */
let controlledAcpE2e: ControlledAcpE2eBootstrap | null
try {
  controlledAcpE2e = resolveControlledAcpE2eBootstrap({
    development: is.dev,
    packaged: app.isPackaged,
    // 构建后的 Main 固定在 out/main；从模块位置反推仓库根，不能信任 Playwright loader 改写的 appPath 或可变 cwd。
    repositoryRoot: resolve(__dirname, '../..')
  })
  if (controlledAcpE2e) app.setPath('userData', controlledAcpE2e.userDataPath)
} catch {
  console.error('[Agent Studio] 受控 ACP Runtime E2E 配置无效。')
  app.exit(1)
  throw new Error('受控 ACP Runtime E2E 配置无效。')
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.focus()
})

if (hasSingleInstanceLock)
  app
    .whenReady()
    .then(async () => {
      electronApp.setAppUserModelId('com.promise-thens.agent-studio')
      app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
      await initializeServices(controlledAcpE2e)
      registerIpcHandlers()
      createWindow()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error) => {
      const message = redactSensitiveError(error)
      console.error(`[Agent Studio] 启动失败：${message}`)
      dialog.showErrorBox('Agent Studio 启动失败', message)
      app.quit()
    })

const appShutdownGate = createAppShutdownGate({
  shutdownPermissions: () => permissionBroker?.shutdown() ?? Promise.resolve(),
  disconnectRuntime: () => runtimeAdapter?.disconnect() ?? Promise.resolve(),
  quit: () => app.quit()
})

app.on('before-quit', appShutdownGate.handleBeforeQuit)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

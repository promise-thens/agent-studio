import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { appearanceWindowBackground, type AppAppearanceState } from '../shared/app-appearance'
import { AGENT_PUSH_CHANNELS } from '../shared/agent-ipc'
import { APP_PUSH_CHANNELS } from '../shared/app-ipc'
import { sanitizeExternalHref } from '../shared/external-href'
import { TAKEOVER_CONTROL_TURN_KIND } from '../shared/task-takeover'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption
} from '../shared/provider'
import { AgentService, AgentServiceError } from './agent/agent-service'
import { projectPublicAgentEvent } from './agent/agent-event-projection'
import { registerAgentIpcHandlers } from './agent/ipc'
import { registerTaskIpcHandlers } from './agent/task-ipc'
import { TaskStore } from './agent/task-store'
import { TaskAttachmentInbox } from './agent/task-attachment-inbox'
import { TaskChangeMediaPreviewService } from './agent/task-change-media-preview'
import { ArtifactRegistry } from './artifact/artifact-registry'
import { ArtifactContentService } from './artifact/artifact-content-service'
import { parseClipboardFilePaths } from './agent/clipboard-file-paths'
import { ATTACHMENT_LIMITS } from '../shared/task-attachment'
import type { TaskExecutionSnapshot } from '../shared/task-execution'
import { OperationGate, type OperationLease } from './agent/operation-gate'
import { TaskExecutor } from './agent/task-executor'
import { TaskExecutionController } from './agent/task-execution-controller'
import { AppearanceController, type NativeThemeAdapter } from './appearance/appearance-controller'
import { AppearanceStore } from './appearance/appearance-store'
import { registerAppIpcHandlers } from './app-ipc'
import {
  openMacosFilesPrivacySettings,
  probeMacosWorkspaceFolderAccess
} from './security/macos-folder-access'
import { createAppShutdownGate } from './app-shutdown'
import {
  resolveControlledAcpE2eBootstrap,
  type ControlledAcpE2eBootstrap
} from './e2e/controlled-acp-e2e-bootstrap'
import {
  resolveGacp01ObserveBootstrap,
  type Gacp01ObserveBootstrap
} from './e2e/gacp01-observe-bootstrap'
import { createGrokAcpFileObserver } from './runtime/grok/grok-acp-protocol-observer'
import { readGrokSubagentSessionActivity } from './runtime/grok/grok-subagent-session-activity'
import type { DesktopIpcMain } from './ipc-types'
import { ProviderConfigStore, type ProviderRuntimeConfig } from './provider/provider-config-store'
import { ProviderConnectionTester } from './provider/provider-connection-tester'
import { ProjectRegistry, ProjectRegistryError } from './project/project-registry'
import { GROK_CONFIG_STARTER_TOML } from '../shared/grok-config-hints'
import {
  nextZoomFactor,
  resolveWindowZoomAction,
  type WindowZoomAction
} from '../shared/window-zoom'
import { createStudioMenuTemplate, type StudioMenuItem } from './application-menu'
import { isRuntimePluginId, type RuntimePluginStatus } from '../shared/runtime-plugin'
import { clearGrokProviderConfig, getManagedGrokHome } from './provider/grok-provider-config'
import { GrokHomeConfigController } from './runtime/grok/grok-home-config-controller'
import { GrokMemoryStore } from './runtime/grok/grok-memory-store'
import { McpServerStore } from './mcp/mcp-server-store'
import { toAgentRuntimeMcpServers } from './mcp/mcp-server-to-acp'
import {
  getUserGrokConfigPath,
  listProjectMcpServers,
  removeUserMcpServer,
  syncUserMcpFromHome,
  writeUserMcpServer
} from './mcp/grok-user-mcp-sync'
import { registerProviderIpcHandlers } from './provider/ipc'
import { validateProviderConfigInput } from './provider/provider-validation'
import { CommandEvidenceStore } from './command/command-evidence-store'
import { createEnsureTaskChangeBaseline, TaskChangeBaselineStore } from './git/task-change-baseline'
import { createRecordTurnChangeCheckpoint, GitReviewService } from './git/git-review-service'
import { TurnChangeCheckpointStore } from './git/turn-change-checkpoint'
import { GrokAcpAdapter } from './runtime/grok/grok-acp-adapter'
import { listGrokMarketplacePlugins } from './runtime/grok/grok-marketplace-inventory'
import {
  ensureGrokMarketplaceSource,
  GROK_PLUGIN_CLI_TIMEOUT_MS,
  runGrokPlugin
} from './runtime/grok/grok-plugin-cli'
import { getGrokPlugin, listGrokPlugins } from './runtime/grok/grok-plugin-inventory'
import { PermissionAuditStore } from './security/permission-audit-store'
import { PermissionBroker } from './security/permission-broker'
import { resolvePermissionTurnIdentity } from './security/permission-intent-context'
import { createLocalEnvironmentId } from './security/permission-policy'
import {
  assertTrustedIpcSender,
  DesktopIpcFailure,
  sendToTrustedRenderer,
  toDesktopIpcError,
  type RendererTrustOptions
} from './security/ipc-sender-validation'
import { redactSensitiveError, redactSensitiveText } from './security/sensitive-redaction'

let mainWindow: BrowserWindow | null = null
let agentService: AgentService | null = null
let taskExecutor: TaskExecutor | null = null
let operationGate: OperationGate | null = null
let runtimeAdapter: GrokAcpAdapter | null = null
let providerStore: ProviderConfigStore | null = null
let providerTester: ProviderConnectionTester | null = null
let projectRegistry: ProjectRegistry | null = null
let taskStore: TaskStore | null = null
let taskAttachmentInbox: TaskAttachmentInbox | null = null
let taskChangeMediaPreviewService: TaskChangeMediaPreviewService | null = null
let permissionAuditStore: PermissionAuditStore | null = null
let permissionBroker: PermissionBroker | null = null
let appearanceController: AppearanceController | null = null
let grokHomeConfig: GrokHomeConfigController | null = null
let grokMemoryStore: GrokMemoryStore | null = null
let mcpServerStore: McpServerStore | null = null
let commandEvidenceStore: CommandEvidenceStore | null = null
/** 与 commandEvidenceStore 一样提升到模块作用域，供 registerIpcHandlers 闭包读取。 */
let gitReviewService: GitReviewService | null = null
let artifactRegistry: ArtifactRegistry | null = null
let artifactContentService: ArtifactContentService | null = null

/** 创建应用主窗口，并限制渲染层直接访问系统能力。 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: appearanceController?.windowBackground() ?? '#0d1117',
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

  // 对话 Markdown 外链走 target=_blank；这里再拦一层，避免 javascript: / file: 进系统浏览器。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const safeHref = sanitizeExternalHref(url)
    if (safeHref) void shell.openExternal(safeHref)
    return { action: 'deny' }
  })

  // 菜单加速键在输入框里不稳定；键盘缩放走 before-input，菜单项只展示和点击。
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const action = resolveWindowZoomAction({
      platform: process.platform,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      key: input.key
    })
    if (!action) return
    event.preventDefault()
    applyMainWindowZoom(action)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 把规格菜单转成 Electron 模板，缩放走 click 以便统一 10% 步进。 */
function toElectronMenuTemplate(items: StudioMenuItem[]): MenuItemConstructorOptions[] {
  return items.map((item) => {
    const mapped: MenuItemConstructorOptions = {}
    if (item.role) mapped.role = item.role
    if (item.type) mapped.type = item.type
    if (item.label) mapped.label = item.label
    if (item.accelerator) mapped.accelerator = item.accelerator
    if (item.visible === false) mapped.visible = false
    if (item.submenu) mapped.submenu = toElectronMenuTemplate(item.submenu)
    if (item.zoomAction) {
      const action = item.zoomAction
      mapped.registerAccelerator = false
      mapped.click = () => applyMainWindowZoom(action)
    }
    return mapped
  })
}

/** 只缩放当前主窗口页面，不改窗口外框尺寸。 */
function applyMainWindowZoom(action: WindowZoomAction): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  window.webContents.setZoomFactor(nextZoomFactor(window.webContents.getZoomFactor(), action))
}

/** 替换默认菜单：保留编辑/窗口，缩放用自己的加速键避免 role:zoomIn 吃不到 Cmd+=。 */
function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(toElectronMenuTemplate(createStudioMenuTemplate(process.platform)))
  )
}

/** safeStorage 只能在 app.whenReady() 后注入，避免模块加载阶段提前访问系统密钥库。 */
async function initializeServices(
  controlledE2e: ControlledAcpE2eBootstrap | null,
  gacp01Observe: Gacp01ObserveBootstrap | null = null
): Promise<void> {
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
  appearanceController = new AppearanceController({
    store: new AppearanceStore({ userDataPath: app.getPath('userData') }),
    nativeTheme: createNativeThemeAdapter()
  })
  await appearanceController.initialize()
  appearanceController.onResolvedChange((state) => publishAppearance(state))
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
    await projectRegistry.register(controlledE2e.secondaryWorkspacePath)
  }
  if (gacp01Observe) {
    await projectRegistry.register(gacp01Observe.workspacePath)
  }
  taskStore = new TaskStore({ projectRegistry })
  await taskStore.initialize()
  taskAttachmentInbox = new TaskAttachmentInbox({
    resolveTaskDirectory: (taskId) => requireTaskStore().getTaskFilesystemRoot(taskId),
    probeImagePixels: (bytes) => {
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) return null
      return image.getSize()
    },
    createThumbnail: createImageThumbnail
  })
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
        const matched = resolvePermissionTurnIdentity({
          activeTurnId: task.activeTurnId,
          lastTurnId: task.lastTurnId,
          state: task.state,
          requestedTurnId: turnId
        })
        return {
          taskId: task.taskId,
          turnId: matched.turnId,
          projectId: task.projectId,
          executionRoot: task.environment.rootSnapshot,
          environmentId: createLocalEnvironmentId(task.projectId, task.environment.rootSnapshot),
          runtimeId: task.runtimeId,
          environmentKind: 'local',
          active: matched.active
        }
      } catch {
        return null
      }
    },
    redactText: redactProviderText
  })

  const grokHome = getManagedGrokHome(app.getPath('userData'))
  grokHomeConfig = new GrokHomeConfigController(grokHome)
  grokMemoryStore = new GrokMemoryStore(grokHome)
  await grokMemoryStore.ensureShare().catch(() => undefined)
  mcpServerStore = new McpServerStore({
    userDataPath: app.getPath('userData'),
    grokHome,
    safeStorage: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plainText) => safeStorage.encryptString(plainText),
      decryptString: (encryptedValue) => safeStorage.decryptString(encryptedValue),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend()
    },
    platform: process.platform,
    config: grokHomeConfig
  })
  await mcpServerStore.initialize()
  await syncUserMcpFromHome({
    userConfigPath: getUserGrokConfigPath(),
    store: mcpServerStore
  }).catch(() => undefined)

  const rendererTrust = createRendererTrustOptions()
  // 命令证据根放在 userData 下并尽量 0700；store 模块不调用 app.getPath。
  const commandEvidenceRoot = join(app.getPath('userData'), 'command-evidence')
  await fs.mkdir(commandEvidenceRoot, { recursive: true, mode: 0o700 })
  const evidenceStore = new CommandEvidenceStore({ rootDir: commandEvidenceRoot })
  commandEvidenceStore = evidenceStore
  // Git 审阅根同样注入，store 自己不调用 app.getPath。
  const gitReviewRoot = join(app.getPath('userData'), 'git-review')
  await fs.mkdir(gitReviewRoot, { recursive: true, mode: 0o700 })
  const taskChangeBaselineStore = new TaskChangeBaselineStore({ rootDir: gitReviewRoot })
  const turnChangeCheckpointStore = new TurnChangeCheckpointStore({
    rootDir: join(gitReviewRoot, 'checkpoints')
  })
  const reviewService = new GitReviewService({
    baselineStore: taskChangeBaselineStore,
    checkpointStore: turnChangeCheckpointStore,
    getTaskIdentity: (taskId) => {
      const task = requireTaskStore().getTaskRecord(taskId)
      return {
        taskId: task.taskId,
        projectId: task.projectId,
        environmentId: task.environment.environmentId,
        executionRoot: task.environment.rootSnapshot
      }
    },
    getProjectAvailability: async (projectId) => {
      try {
        return (await requireProjectRegistry().getSummary(projectId)).availability
      } catch {
        return { state: 'unavailable', message: 'Project 当前不可用。' }
      }
    },
    listCommandEvidence: (taskId) => evidenceStore.listEvidence(taskId),
    hasPersistIncomplete: (taskId) => evidenceStore.hasPersistIncomplete(taskId),
    waitForEvidenceWrites: () => evidenceStore.waitForWrites(),
    attachTurnValidationIds: (taskId, turnId, validationIds) =>
      requireTaskStore().attachTurnValidationIds(taskId, turnId, validationIds),
    sourceEnvironment: process.env,
    hasActiveExecution: () => taskExecutor?.hasActiveExecution() ?? false,
    broker: permissionBroker ?? undefined
  })
  gitReviewService = reviewService
  const probeImagePixels = (bytes: Buffer): { width: number; height: number } | null => {
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return null
    return image.getSize()
  }
  artifactRegistry = new ArtifactRegistry({
    getTaskContext: (taskId) => {
      const task = requireTaskStore().getTaskRecord(taskId)
      return {
        projectId: task.projectId,
        taskId: task.taskId,
        environmentId: task.environment.environmentId,
        executionRoot: task.environment.rootSnapshot,
        lastTurnId: task.lastTurnId,
        taskDirectory: requireTaskStore().getTaskFilesystemRoot(taskId)
      }
    },
    attachTurnArtifactIds: (taskId, turnId, artifactIds) =>
      requireTaskStore().attachTurnArtifactIds(taskId, turnId, artifactIds),
    probeImagePixels
  })
  artifactContentService = new ArtifactContentService({
    registry: artifactRegistry,
    getFileDiff: (taskId, path) => reviewService.getFileDiff(taskId, path),
    probeImagePixels
  })
  taskChangeMediaPreviewService = new TaskChangeMediaPreviewService({
    getChangeSet: (taskId) => reviewService.getChangeSet(taskId),
    getExecutionRoot: (taskId) => {
      try {
        const task = requireTaskStore().getTaskRecord(taskId)
        return task.environment.kind === 'local' ? task.environment.rootSnapshot : null
      } catch {
        return null
      }
    },
    createImageThumbnail
  })
  const adapter = new GrokAcpAdapter(
    {
      onStatus: (status) =>
        sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.status, status),
      onEvent: (event) => {
        // TaskExecutor 负责持久化确认后发布；旧 Service 路径只收束兼容历史，不得绕过提交门。
        if (!taskExecutor?.handleRuntimeEvent(event)) agentService?.handleRuntimeEvent(event)
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
      },
      onQuestion: (request) => {
        const service = agentService
        if (!service) {
          runtimeAdapter?.respondQuestion?.(
            request.requestId,
            { action: 'cancel' },
            { cancelReason: 'service-not-current' }
          )
          return
        }
        service.handleQuestionRequest(request)
      },
      onQuestionCancelled: (request) => {
        agentService?.handleQuestionCancellation(request)
      },
      onAvailableCommands: (snapshot) => {
        // Service 持久化当前 session 快照；同步推给 Renderer（已投影，非 ACP 原文）
        agentService?.handleAvailableCommands(snapshot)
        sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.availableCommands, snapshot)
        const service = agentService
        const executor = taskExecutor
        if (service && executor) {
          void applyTakeoverControlPrompt(service, executor, snapshot.taskId, true)
        }
      }
    },
    {
      userDataPath: app.getPath('userData'),
      getProviderConfig: () => requireProviderStore().getRuntimeConfig(),
      // 备注：握手 clientInfo.version 与关于页/安装包对齐；开发态加 -dev，禁止 Renderer 传入。
      getClientVersion: () => (app.isPackaged ? app.getVersion() : `${app.getVersion()}-dev`),
      redactText: redactProviderText,
      getMcpServers: async () =>
        toAgentRuntimeMcpServers(await requireMcpServerStore().listEnabledResolved()),
      isMemoryEnabled: async () => (await requireGrokMemoryStore().getEnabledState()).enabled,
      commandEvidenceStore: evidenceStore,
      resolveCommandEvidenceContext: (taskId) => {
        // Adapter 不得自造 environmentId；查不到 Task 就跳过落盘。
        try {
          const task = requireTaskStore().getTaskRecord(taskId)
          if (task.environment.kind !== 'local') return null
          return { environmentId: task.environment.environmentId }
        } catch {
          return null
        }
      },
      storeRuntimeImage: async (input) => {
        // Runtime 图片只由主进程附件柜落盘；Adapter 收到的是不含路径和字节的有限引用。
        const descriptor = await requireTaskAttachmentInbox().importRuntimeBytes(input)
        return {
          attachmentId: descriptor.attachmentId,
          attachmentKind: 'image',
          originalName: descriptor.originalName
        }
      },
      ...(controlledE2e ? { controlledFixture: controlledE2e.fixture } : {}),
      ...(gacp01Observe
        ? { protocolObserver: createGrokAcpFileObserver(gacp01Observe.observationFilePath) }
        : {})
    }
  )
  runtimeAdapter = adapter
  operationGate = new OperationGate()
  const ensureChangeBaseline = createEnsureTaskChangeBaseline({
    store: taskChangeBaselineStore,
    getProjectAvailability: async (projectId) => {
      try {
        return (await requireProjectRegistry().getSummary(projectId)).availability
      } catch {
        return { state: 'unavailable', message: 'Project 当前不可用。' }
      }
    },
    sourceEnvironment: process.env
  })
  taskExecutor = new TaskExecutor({
    taskStore: requireTaskStore(),
    adapter,
    operationGate,
    redactText: redactProviderText,
    onCancelTimeout: (identity) =>
      requirePermissionBroker().cancelTurn(identity.taskId, identity.turnId),
    onSnapshot: (snapshot) =>
      sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.executionUpdate, snapshot),
    onEvent: (event) =>
      sendToTrustedRenderer(
        rendererTrust,
        AGENT_PUSH_CHANNELS.event,
        projectPublicAgentEvent(event, redactProviderText)
      ),
    ensureChangeBaseline,
    recordTurnChangeCheckpoint: createRecordTurnChangeCheckpoint(reviewService),
    attachmentInbox: taskAttachmentInbox ?? undefined
  })
  agentService = new AgentService(adapter, new TaskExecutionController(), {
    projectRegistry,
    taskStore,
    ensureChangeBaseline,
    getTurnModel: () => {
      const config = requireProviderRuntimeConfig()
      return {
        modelId: config.modelId,
        ...(config.modelDisplayName ? { displayName: config.modelDisplayName } : {})
      }
    },
    redactText: redactProviderText,
    permissionBroker: requirePermissionBroker(),
    taskExecutor,
    operationGate,
    getSessionMcpServers: async () =>
      toAgentRuntimeMcpServers(await requireMcpServerStore().listEnabledResolved()),
    getTrustedExternalRoots: () => requireGrokMemoryStore().listTrustedRoots(),
    attachmentInbox: taskAttachmentInbox ?? undefined,
    onEvent: (event) =>
      sendToTrustedRenderer(
        rendererTrust,
        AGENT_PUSH_CHANNELS.event,
        projectPublicAgentEvent(event, redactProviderText)
      ),
    onTaskRuntimeState: (task) =>
      sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.taskRuntimeState, task),
    onQuestion: (request) =>
      sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.question, request),
    onQuestionCancelled: (request) =>
      sendToTrustedRenderer(rendererTrust, AGENT_PUSH_CHANNELS.questionCancelled, request)
  })
}

/** 与 Adapter 同源：~/.grok/bin/grok 存在则用之，否则 PATH 上的 grok。不改 Adapter.resolveBinary。 */
function resolveGrokPluginBinary(): string {
  const bundledPath = join(homedir(), '.grok/bin/grok')
  return existsSync(bundledPath) ? bundledPath : 'grok'
}

/**
 * 在 App grok-home 下跑 grok plugin CLI。
 * 失败抛普通 Error，让 toDesktopIpcError 再跑 URL/路径正则；不得用 DesktopIpcFailure 跳过脱敏。
 * 成功丢弃 stdout，避免绝对路径进 Renderer。不得 cancelTurn / disconnect。
 */
async function runManagedPluginCli(args: string[]): Promise<null> {
  const result = await runGrokPlugin({
    grokHome: getManagedGrokHome(app.getPath('userData')),
    grokBinary: resolveGrokPluginBinary(),
    args,
    timeoutMs: GROK_PLUGIN_CLI_TIMEOUT_MS
  })
  if (!result.ok) {
    throw new Error(result.message)
  }
  return null
}

/**
 * 加源走幂等封装：config 已有该 git URL 时刷新 cache，而不是把 already configured 抛给 UI。
 */
async function runManagedMarketplaceAdd(gitUrl: string): Promise<null> {
  const result = await ensureGrokMarketplaceSource({
    grokHome: getManagedGrokHome(app.getPath('userData')),
    grokBinary: resolveGrokPluginBinary(),
    gitUrl,
    timeoutMs: GROK_PLUGIN_CLI_TIMEOUT_MS
  })
  if (!result.ok) {
    throw new Error(result.message)
  }
  return null
}

/** 注册渲染层可调用的最小 IPC 接口。 */
/**
 * 与 agent:start-turn 同一条执行槽。接管斜杠命令也走这里，
 * displayText 经统一脱敏，字面量为 /always-approve，不含用户原文。
 */
async function startTurnWithPrompt(
  service: AgentService,
  executor: TaskExecutor,
  taskId: string,
  prompt: string,
  attachmentIds: string[] = [],
  turnKind?: typeof TAKEOVER_CONTROL_TURN_KIND
): Promise<TaskExecutionSnapshot> {
  await service.waitForEnter(taskId)
  await service.ensureTaskSessionForTurn(taskId)
  const task = requireTaskStore().getTaskRecord(taskId)
  return executor.start({
    taskId,
    projectId: task.projectId,
    runtimeId: task.runtimeId,
    session: {
      runtimeId: task.runtimeSession.runtimeId,
      runtimeSessionId: task.runtimeSession.runtimeSessionId,
      workspace: task.runtimeSession.workspace
    },
    environmentId: task.environment.environmentId,
    resolvedExecutionRoot: task.environment.rootSnapshot,
    prompt,
    promptDisplayText: redactProviderText(prompt),
    ...(turnKind ? { turnKind } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}),
    model: (() => {
      const config = requireProviderRuntimeConfig()
      return {
        modelId: config.modelId,
        ...(config.modelDisplayName ? { displayName: config.modelDisplayName } : {})
      }
    })(),
    capabilitySnapshot: requireRuntimeAdapter().getCapabilitySnapshot(),
    prepareRuntime: async (lease) => {
      await service.resumeTask(taskId, lease)
    }
  })
}

/**
 * 仅在 control turn 入队成功后标 applied。失败保持未 applied，以便广告晚到或重试再发。
 * swallowError 用于 enter / 晚到广告：不得阻断浏览。
 */
async function applyTakeoverControlPrompt(
  service: AgentService,
  executor: TaskExecutor,
  taskId: string,
  swallowError = false
): Promise<void> {
  const prompt = service.beginTakeoverControlPrompt(taskId)
  if (!prompt) return
  try {
    await startTurnWithPrompt(service, executor, taskId, prompt, [], TAKEOVER_CONTROL_TURN_KIND)
    service.markTakeoverCommandDispatched(taskId)
  } catch (error) {
    service.abortTakeoverControlPrompt(taskId)
    if (!swallowError) throw error
  }
}

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
    getAgent: () => {
      const service = agentService
      const executor = taskExecutor
      if (!service || !executor) return service
      return {
        getStatus: () => service.getStatus(),
        getExecutionSnapshot: () => executor.getSnapshot(),
        connect: (projectId) => service.connect(projectId),
        disconnect: () => service.disconnect(),
        createTask: (projectId) => service.createTask(projectId),
        enterTask: async (taskId) => {
          const entry = await service.enterTask(taskId)
          await applyTakeoverControlPrompt(service, executor, taskId, true)
          return entry
        },
        startTurn: async (taskId, prompt, attachmentIds = []) =>
          startTurnWithPrompt(service, executor, taskId, prompt, attachmentIds),
        cancelTurn: async (request) => {
          if (typeof request === 'string') return service.cancelTurn(request)
          const cancelled = await executor.cancel(request)
          if (!cancelled)
            throw new AgentServiceError('invalid-state', '指定 execution 当前不可取消。')
        },
        getTaskRuntimeState: (taskId) => service.getTaskRuntimeState(taskId),
        getAvailableCommands: (taskId) => service.getAvailableCommands(taskId),
        respondPermission: (request) => service.respondPermission(request),
        // 门面必须转发问答；漏挂时 IPC 会成功返回，Grok 却一直等 skip。
        respondQuestion: (request) => service.respondQuestion(request),
        setPermissionMode: async (request) => {
          const result = await service.setPermissionMode(request)
          if (result.decision.kind === 'send-command' && result.controlPrompt) {
            try {
              // enable/disable 都用已返回的 controlPrompt 入队，关接管不得再走 begin 闸门。
              await service.runTakeoverControlPrompt(
                request.taskId,
                result.controlPrompt,
                (taskId, prompt) =>
                  startTurnWithPrompt(
                    service,
                    executor,
                    taskId,
                    prompt,
                    [],
                    TAKEOVER_CONTROL_TURN_KIND
                  )
              )
            } catch {
              // start 失败不得把 applied 写成 true；仍返回已写盘快照（enable 未生效 / disable 可能仍在）。
            }
            return { ...result, task: service.getTaskRuntimeState(request.taskId) }
          }
          return result
        }
      }
    },
    sanitizeError: (error) => redactSensitiveError(error, getKnownSecrets())
  })

  registerAppIpcHandlers({
    ipcMain: desktopIpcMain,
    assertTrustedSender,
    chooseProject: chooseProject,
    listProjects: () => requireProjectRegistry().list(),
    revealProject: async (projectId) => {
      // 只打开 Registry 里的 canonicalRoot，拒绝 Renderer 自带路径。
      try {
        const root = await requireProjectRegistry().resolveAvailableRoot(projectId)
        const failure = await shell.openPath(root)
        if (failure.trim()) {
          throw new DesktopIpcFailure('project-unavailable', '该项目目录已删除或无法访问。')
        }
      } catch (error) {
        if (error instanceof DesktopIpcFailure) throw error
        if (error instanceof ProjectRegistryError && error.code === 'project-unavailable') {
          throw new DesktopIpcFailure('project-unavailable', '该项目目录已删除或无法访问。')
        }
        throw error
      }
    },
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
    getAppearance: () => requireAppearanceController().getState(),
    setAppearance: (mode) => requireAppearanceController().setMode(mode),
    // 插件扫描牢笼绑在 userData，不把绝对路径经 IPC 回传
    listPlugins: async () => {
      const plugins = await listGrokPlugins(app.getPath('userData'))
      const enablement = await requireGrokHomeConfig().readPluginEnablement()
      return plugins.map((plugin) => applyPluginEnablement(plugin, enablement))
    },
    getPlugin: async (pluginId) => {
      const detail = await getGrokPlugin(app.getPath('userData'), pluginId)
      if (!detail) return null
      const enablement = await requireGrokHomeConfig().readPluginEnablement()
      return applyPluginEnablement(detail, enablement)
    },
    setPluginEnabled: async (pluginId, enabled) => {
      if (!isRuntimePluginId(pluginId)) {
        throw new DesktopIpcFailure('invalid-input', '插件标识无效。')
      }
      const controller = requireGrokHomeConfig()
      const enablement = await controller.readPluginEnablement()
      const enabledList = new Set(enablement.enabled ?? [])
      const disabledList = new Set(enablement.disabled ?? [])
      if (enabled) {
        disabledList.delete(pluginId)
        enabledList.add(pluginId)
      } else {
        enabledList.delete(pluginId)
        disabledList.add(pluginId)
      }
      await controller.apply({
        pluginsEnabled: [...enabledList],
        pluginsDisabled: [...disabledList]
      })
      return { pluginId, enabled }
    },
    getGrokConfig: async () => {
      const text = await requireGrokHomeConfig().read()
      if (!text.trim()) return { text: GROK_CONFIG_STARTER_TOML, seeded: true as const }
      return { text }
    },
    saveGrokConfig: async (text) => {
      assertGrokConfigCanReload()
      try {
        await requireGrokHomeConfig().writeText(text)
      } catch (error) {
        if (error instanceof Error && error.name === 'GrokConfigTextError') {
          throw new DesktopIpcFailure('invalid-input', error.message)
        }
        throw error
      }
      // 备注：Grok 进程启动时读 toml，空闲已连接时必须重载，手改的 context_window 才会生效。
      if (agentService?.getStatus().state === 'ready') {
        await reloadGrokRuntimeAfterConfigSave(agentService)
      }
    },
    listMemories: (projectHint) => requireGrokMemoryStore().list(projectHint),
    getMemory: (memoryId) => requireGrokMemoryStore().get(memoryId),
    saveMemory: (memoryId, markdown) => requireGrokMemoryStore().save(memoryId, markdown),
    deleteMemory: (memoryId) => requireGrokMemoryStore().delete(memoryId),
    getMemoryEnabled: () => requireGrokMemoryStore().getEnabledState(),
    setMemoryEnabled: (enabled) => requireGrokMemoryStore().setEnabled(enabled),
    /**
     * 只读已保存档。缺省 off；非法磁盘值由 controller 抛错，不得伪装成 off。
     */
    getGrokSandbox: async () => {
      const profile = await requireGrokHomeConfig().readSandboxProfile()
      return { profile }
    },
    /**
     * 空闲才写盘；已连接则复用 reloadGrokRuntimeAfterConfigSave，但禁止静默 session/new。
     * 执行中先拒绝以免文件已改、旧进程仍按旧沙箱跑。重载或 resume/load 失败不得返回 applied: true。
     */
    setGrokSandbox: async (profile) => {
      assertGrokConfigCanReload()
      await requireGrokHomeConfig().apply({ sandboxProfile: profile })
      if (agentService?.getStatus().state === 'ready') {
        await reloadGrokRuntimeAfterConfigSave(agentService, { allowSessionRebuild: false })
      }
      return { profile, applied: true }
    },
    listMcpServers: async (projectId) => {
      const projectServers = projectId
        ? await listProjectMcpServers(
            await requireProjectRegistry().resolveAvailableRoot(projectId)
          ).catch(() => [])
        : []
      return requireMcpServerStore().list(projectServers)
    },
    upsertMcpServer: async (input) => {
      const store = requireMcpServerStore()
      const summary = await store.upsert(input)
      const record = store.getRecord(input.name)
      if (record) {
        const resolved = store.resolveRecord(record)
        await writeUserMcpServer({
          userConfigPath: getUserGrokConfigPath(),
          server: {
            name: resolved.name,
            enabled: resolved.enabled,
            transport: resolved.transport,
            ...(resolved.command ? { command: resolved.command } : {}),
            ...(resolved.args ? { args: resolved.args } : {}),
            ...(resolved.url ? { url: resolved.url } : {}),
            ...(resolved.env ? { env: resolved.env } : {}),
            ...(resolved.headers ? { headers: resolved.headers } : {})
          }
        })
      }
      return summary
    },
    deleteMcpServer: async (name) => {
      await requireMcpServerStore().delete(name)
      await removeUserMcpServer({
        userConfigPath: getUserGrokConfigPath(),
        name
      })
    },
    listMarketplacePlugins: () => listGrokMarketplacePlugins(app.getPath('userData')),
    installPlugin: ({ name, trust }) => {
      const args = ['plugin', 'install', name]
      if (trust === true) args.push('--trust')
      return runManagedPluginCli(args)
    },
    uninstallPlugin: ({ pluginId }) =>
      runManagedPluginCli(['plugin', 'uninstall', pluginId, '--confirm']),
    addMarketplaceSource: ({ gitUrl }) => runManagedMarketplaceAdd(gitUrl),
    /**
     * 选中或恢复工作区时由 Renderer 带 projectId 调用。
     * 读 canonicalRoot 触发文稿/桌面/下载 TCC，失败只回状态，不断开 Runtime。
     */
    probeMacosFolderAccess: async (projectId) => {
      try {
        const root = await requireProjectRegistry().resolveAvailableRoot(projectId)
        return await probeMacosWorkspaceFolderAccess(root, {
          platform: process.platform,
          homedir: homedir(),
          isPackaged: app.isPackaged,
          readDirectory: (directory) => fs.readdir(directory)
        })
      } catch (error) {
        if (error instanceof DesktopIpcFailure) throw error
        if (error instanceof ProjectRegistryError && error.code === 'project-unavailable') {
          throw new DesktopIpcFailure('project-unavailable', '该项目目录已删除或无法访问。')
        }
        throw error
      }
    },
    openMacosFilesPrivacySettings: async () => {
      await openMacosFilesPrivacySettings({
        openExternal: (url) => shell.openExternal(url)
      })
    },
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
    getCommandEvidenceStore: () => commandEvidenceStore,
    getGitReview: () => gitReviewService,
    getInbox: () => taskAttachmentInbox,
    pickFiles: pickAttachmentFiles,
    readClipboard: readClipboardAttachments,
    getChangeMediaPreview: (taskId, path) =>
      requireTaskChangeMediaPreviewService().getPreview(taskId, path),
    getArtifactRegistry: () => artifactRegistry,
    getArtifactContent: () => artifactContentService,
    getSubagentActivity: async (taskId, shortId) => {
      // 子代理活动只允许绑定当前 Task 私有的父 Runtime session，禁止跨 Task 扫描旧会话。
      const store = taskStore
      if (!store) return { source: 'missing', tools: [] }
      try {
        const record = store.getTaskRecord(taskId)
        if (record.runtimeId !== 'grok' || record.runtimeSession.runtimeId !== 'grok') {
          return { source: 'missing', tools: [] }
        }
        return await readGrokSubagentSessionActivity({
          grokHome: getManagedGrokHome(app.getPath('userData')),
          workspacePath: record.runtimeSession.workspace,
          parentRuntimeSessionId: record.runtimeSession.runtimeSessionId,
          shortId,
          redactText: (text) => redactSensitiveText(text, getKnownSecrets())
        })
      } catch {
        return { source: 'missing', tools: [] }
      }
    },
    getHistory: () => {
      const store = taskStore
      const service = agentService
      if (!store || !service) return null
      return {
        listTasks: (projectId, cursor, limit) => store.listTasks(projectId, cursor, limit),
        getTaskDetail: (taskId) => store.getTaskDetail(taskId),
        listTurns: (taskId, cursor, limit) => store.listTurns(taskId, cursor, limit),
        listEvents: async (taskId, turnId, afterSequence, limit) => {
          const page = await store.listEvents(taskId, turnId, afterSequence, limit)
          return {
            ...page,
            items: page.items.map((event) => projectPublicAgentEvent(event, redactProviderText))
          }
        },
        listPermissionAudits: (taskId, cursor, limit) =>
          requirePermissionAuditStore().list(taskId, cursor, limit),
        resumeTask: (taskId) => service.resumeTask(taskId),
        previewTaskDeletion: (taskId) => store.previewTaskDeletion(taskId),
        /** 只改展示标题，不在入口层做业务校验。 */
        renameTask: async (taskId, title) => {
          await store.renameTask(taskId, title)
          return store.getTaskDetail(taskId)
        },
        /** 归档结果回详情 DTO，默认 list 由 Store 省略。 */
        archiveTask: async (taskId) => {
          await store.archiveTask(taskId)
          return store.getTaskDetail(taskId)
        },
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
          return runProviderMutation(async (lease) => {
            const resolvedInput = validateProviderConfigInput(attachStoredCredential(input))
            const result = await requireProviderTester().testInference(resolvedInput)
            if (!result.ok) throw new Error(result.message)
            return persistProviderConfig(resolvedInput, lease)
          })
        }),
      selectModel: (model: ProviderModelOption) =>
        runProviderOperation(async () => {
          return runProviderMutation(async (lease) => {
            const current = requireProviderRuntimeConfig()
            if (!model || typeof model.modelId !== 'string') throw new Error('请选择有效模型。')

            const nextInput = validateProviderConfigInput({
              ...current,
              modelId: model.modelId,
              modelDisplayName: model.displayName
            })
            const result = await requireProviderTester().testInference(nextInput)
            if (!result.ok) throw new Error(result.message)
            return persistProviderConfig(nextInput, lease)
          })
        }),
      clear: () =>
        runProviderOperation(async () => {
          return runProviderMutation(async (lease) => {
            await requireAgentService().disconnect(lease)
            const summary = await requireProviderStore().clear()
            await clearGrokProviderConfig(app.getPath('userData'))
            return summary
          })
        })
    }
  })
}

const ATTACHMENT_DIALOG_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'pdf',
  'txt',
  'md',
  'json',
  'csv',
  'log',
  'ts',
  'tsx',
  'js',
  'vue',
  'py',
  'go',
  'rs',
  'toml',
  'yaml',
  'yml'
]

/** 主进程选文件，路径不回传 Renderer，只把校验后的描述符交出去。 */
async function pickAttachmentFiles(): Promise<string[] | null> {
  const options: Electron.OpenDialogOptions = {
    title: '添加附件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '附件', extensions: ATTACHMENT_DIALOG_EXTENSIONS }]
  }
  const currentWindow = mainWindow
  const result =
    currentWindow && !currentWindow.isDestroyed()
      ? await dialog.showOpenDialog(currentWindow, options)
      : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths.slice(0, ATTACHMENT_LIMITS.maxPerTurn)
}

/** 统一生成受限 JPEG 缩略图，避免附件柜与 ChangeSet 预览使用不同尺寸策略。 */
function createImageThumbnail(bytes: Buffer): { bytes: Buffer; mime: string } | null {
  const image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  const { width } = image.getSize()
  const resized =
    width > ATTACHMENT_LIMITS.maxPreviewEdge
      ? image.resize({ width: ATTACHMENT_LIMITS.maxPreviewEdge, quality: 'good' })
      : image
  return { bytes: resized.toJPEG(80), mime: 'image/jpeg' }
}

/** 剪贴板图片与 file URL；Finder 复制的文件走 file://。 */
async function readClipboardAttachments(): Promise<Array<{ originalName: string; bytes: Buffer }>> {
  const items: Array<{ originalName: string; bytes: Buffer }> = []
  const image = clipboard.readImage()
  if (!image.isEmpty()) {
    items.push({ originalName: 'clipboard.png', bytes: image.toPNG() })
  }
  const uriText = [clipboard.read('public.file-url'), clipboard.read('text/uri-list')]
    .filter((value) => value && value.trim())
    .join('\n')
  const finderPaths = parseClipboardFilePaths(clipboard.read('NSFilenamesPboardType'))
  const candidates = [...uriText.split(/\r?\n/), ...finderPaths]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    try {
      const filePath = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : trimmed
      if (seen.has(filePath)) continue
      seen.add(filePath)
      const stats = await fs.lstat(filePath)
      if (stats.isSymbolicLink() || !stats.isFile()) continue
      const bytes = await fs.readFile(filePath)
      items.push({ originalName: filePath, bytes })
    } catch {
      continue
    }
  }
  return items.slice(0, ATTACHMENT_LIMITS.maxPerTurn)
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

/** 把 Electron nativeTheme 收成可测适配器，避免 AppearanceController 直接依赖 electron 模块。 */
function createNativeThemeAdapter(): NativeThemeAdapter {
  return {
    get shouldUseDarkColors() {
      return nativeTheme.shouldUseDarkColors
    },
    get themeSource() {
      if (nativeTheme.themeSource === 'light' || nativeTheme.themeSource === 'dark') {
        return nativeTheme.themeSource
      }
      return 'system'
    },
    set themeSource(value) {
      nativeTheme.themeSource = value
    },
    onUpdated(listener) {
      nativeTheme.on('updated', listener)
      return () => {
        nativeTheme.off('updated', listener)
      }
    }
  }
}

function requireAppearanceController(): AppearanceController {
  if (!appearanceController) throw new Error('AppearanceController 尚未初始化。')
  return appearanceController
}

/** 窗口底色和 Renderer 必须同时拿到解析结果，避免只改 CSS 还闪一帧旧背景。 */
function publishAppearance(state: AppAppearanceState): void {
  const window = mainWindow
  if (window && !window.isDestroyed()) {
    window.setBackgroundColor(appearanceWindowBackground(state.resolved))
  }
  sendToTrustedRenderer(createRendererTrustOptions(), APP_PUSH_CHANNELS.appearance, state)
}

/** Provider 变更需要与已连接 Runtime 保持事务一致，失败时恢复旧配置。 */
async function persistProviderConfig(
  input: ProviderConfigInput,
  lease: OperationLease
): Promise<ProviderConfigSummary> {
  const currentAgent = requireAgentService()
  const store = requireProviderStore()
  const previous = store.getRuntimeConfig()
  const status = currentAgent.getStatus()

  if (status.state === 'busy' || status.state === 'connecting') {
    throw new Error('任务执行中，结束后才能修改模型配置。')
  }

  // 重连必须用 Project ID。workspace 是目录路径，交给 connect() 会被当成非法 ID。
  // 断开前先记住当前 Task，避免 disconnect 清掉 selectedTaskId 后对话接不回去。
  let reconnect: { projectId: string; selectedTaskId: string | null } | null = null
  if (status.state === 'ready') {
    const projectId = requireProjectRegistry().findActiveProjectIdByRoot(status.workspace ?? '')
    if (!projectId) {
      throw new Error('当前连接没有有效的 Project，无法切换模型。')
    }
    reconnect = { projectId, selectedTaskId: currentAgent.getSelectedTaskId() }
  }

  const nextSummary = await store.save(input, { testedAt: new Date().toISOString() })
  if (!reconnect) return nextSummary

  await currentAgent.disconnect(lease)
  try {
    await restoreProviderRuntime(currentAgent, reconnect, lease)
    return nextSummary
  } catch (error) {
    if (previous) {
      await store.save(previous, { testedAt: previous.testedAt })
      await restoreProviderRuntime(currentAgent, reconnect, lease).catch(() => undefined)
    }
    throw error
  }
}

/** 按 Project ID 重连，并在有打开的对话时立刻 resume/load，不把压缩交给桌面。 */
async function restoreProviderRuntime(
  currentAgent: AgentService,
  reconnect: { projectId: string; selectedTaskId: string | null },
  lease?: OperationLease,
  options?: { allowSessionRebuild?: boolean }
): Promise<void> {
  await currentAgent.connect(reconnect.projectId, lease)
  if (!reconnect.selectedTaskId) return
  if (options?.allowSessionRebuild === false) {
    await currentAgent.ensureTaskSessionForTurn(reconnect.selectedTaskId, lease, {
      allowRebuild: false
    })
    return
  }
  await currentAgent.ensureTaskSessionForTurn(reconnect.selectedTaskId, lease)
}

/** 任务执行中禁止保存 Grok 配置，避免文件已改但正在跑的进程仍用旧窗口。 */
function assertGrokConfigCanReload(): void {
  const state = agentService?.getStatus().state
  if (state === 'busy' || state === 'connecting') {
    throw new DesktopIpcFailure('invalid-state', '任务执行中，结束后才能保存并重载 Grok 配置。')
  }
}

/**
 * 把已连接的 Grok 进程拆掉再拉起来，让刚写入的 App config.toml 被 Runtime 重新读取。
 * 找不到 Project 时只断开，避免把目录路径当成身份重连。
 * sandbox 改档传 `allowSessionRebuild: false`：旧 session 因沙箱固定 resume/load 失败时
 * 必须抛错，禁止静默 `session/new`。saveGrokConfig 保持默认可重建。
 */
async function reloadGrokRuntimeAfterConfigSave(
  currentAgent: AgentService,
  options?: { allowSessionRebuild?: boolean }
): Promise<void> {
  const status = currentAgent.getStatus()
  if (status.state !== 'ready') return
  const projectId = requireProjectRegistry().findActiveProjectIdByRoot(status.workspace ?? '')
  const selectedTaskId = currentAgent.getSelectedTaskId()
  await currentAgent.disconnect()
  if (!projectId) return
  await restoreProviderRuntime(currentAgent, { projectId, selectedTaskId }, undefined, options)
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

/** Provider save/select/clear 在任何网络或持久化 await 前取得共享 mutation lease。 */
async function runProviderMutation<T>(
  operation: (lease: OperationLease) => Promise<T>
): Promise<T> {
  let lease: OperationLease
  try {
    lease = requireOperationGate().acquireProviderMutation()
  } catch {
    const state = requireOperationGate().getState()
    const message =
      state === 'execution-active' || state === 'admitting-execution'
        ? '任务执行中，结束后才能修改模型配置。'
        : state === 'shutting-down'
          ? '应用正在退出，不能修改模型配置。'
          : '已有主进程操作正在进行，请稍后重试。'
    throw new Error(message)
  }
  try {
    return await operation(lease)
  } finally {
    lease.release()
  }
}

function redactProviderText(text: string): string {
  return redactSensitiveText(text, getKnownSecrets())
}

function getKnownSecrets(): string[] {
  const apiKey = providerStore?.getRuntimeConfig()?.apiKey
  const mcpSecrets = mcpServerStore?.listKnownSecrets() ?? []
  return [...(apiKey ? [apiKey] : []), ...mcpSecrets]
}

function requireGrokHomeConfig(): GrokHomeConfigController {
  if (!grokHomeConfig) throw new Error('Grok 配置控制器尚未初始化。')
  return grokHomeConfig
}

function requireGrokMemoryStore(): GrokMemoryStore {
  if (!grokMemoryStore) throw new Error('记忆存储尚未初始化。')
  return grokMemoryStore
}

function requireMcpServerStore(): McpServerStore {
  if (!mcpServerStore) throw new Error('MCP 存储尚未初始化。')
  return mcpServerStore
}

function applyPluginEnablement<T extends { pluginId: string; status: RuntimePluginStatus }>(
  plugin: T,
  enablement: { enabled?: string[]; disabled?: string[] }
): T {
  if (plugin.status === 'invalid') return plugin
  const disabled = enablement.disabled?.includes(plugin.pluginId)
  const enabledList = enablement.enabled
  let status: RuntimePluginStatus = 'enabled'
  if (disabled) status = 'disabled'
  else if (enabledList && enabledList.length > 0 && !enabledList.includes(plugin.pluginId)) {
    status = 'disabled'
  }
  return { ...plugin, status }
}

function requireRuntimeAdapter(): GrokAcpAdapter {
  if (!runtimeAdapter) throw new Error('Agent Runtime Adapter 尚未初始化。')
  return runtimeAdapter
}

function requireOperationGate(): OperationGate {
  if (!operationGate) throw new Error('主进程操作门禁尚未初始化。')
  return operationGate
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

function requireTaskAttachmentInbox(): TaskAttachmentInbox {
  if (!taskAttachmentInbox) throw new Error('Task 附件柜尚未初始化。')
  return taskAttachmentInbox
}

function requireTaskChangeMediaPreviewService(): TaskChangeMediaPreviewService {
  if (!taskChangeMediaPreviewService) throw new Error('Task 变更媒体预览尚未初始化。')
  return taskChangeMediaPreviewService
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
let gacp01Observe: Gacp01ObserveBootstrap | null
try {
  controlledAcpE2e = resolveControlledAcpE2eBootstrap({
    development: is.dev,
    packaged: app.isPackaged,
    // 构建后的 Main 固定在 out/main；从模块位置反推仓库根，不能信任 Playwright loader 改写的 appPath 或可变 cwd。
    repositoryRoot: resolve(__dirname, '../..')
  })
  gacp01Observe = resolveGacp01ObserveBootstrap({
    development: is.dev,
    packaged: app.isPackaged
  })
  if (controlledAcpE2e && gacp01Observe) {
    throw new Error('受控 E2E 与 GACP-01 观察不能同时启动。')
  }
  if (controlledAcpE2e) app.setPath('userData', controlledAcpE2e.userDataPath)
  if (gacp01Observe) app.setPath('userData', gacp01Observe.userDataPath)
} catch {
  console.error('[Agent Studio] 隔离 Electron 启动配置无效。')
  app.exit(1)
  throw new Error('隔离 Electron 启动配置无效。')
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
      await initializeServices(controlledAcpE2e, gacp01Observe)
      registerIpcHandlers()
      installApplicationMenu()
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
  hasActiveExecution: () => taskExecutor?.hasActiveExecution() ?? false,
  chooseActiveExecutionAction: async () => {
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
    const result = owner
      ? await dialog.showMessageBox(owner, {
          type: 'warning',
          title: '任务仍在执行',
          message: '当前 Task 仍在执行，退出应用前请选择处理方式。',
          detail: '强制退出可能留下无法确认的外部副作用，重启后该 Turn 会标记为 interrupted。',
          buttons: ['继续等待', '取消任务并退出', '强制退出'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
      : await dialog.showMessageBox({
          type: 'warning',
          title: '任务仍在执行',
          message: '当前 Task 仍在执行，退出应用前请选择处理方式。',
          buttons: ['继续等待', '取消任务并退出', '强制退出'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
    return result.response === 1
      ? 'cancel-and-quit'
      : result.response === 2
        ? 'force-quit'
        : 'continue-waiting'
  },
  beginShutdown: () => {
    operationGate?.beginShutdown()
  },
  cancelActiveExecution: async () => {
    const identity = taskExecutor?.getActiveIdentity()
    if (!identity) return
    await taskExecutor?.cancel(identity)
    await taskExecutor?.waitForTerminal()
  },
  interruptActiveExecution: async () => {
    await taskExecutor?.interrupt('forced-shutdown')
  },
  drainHistory: async () => {
    await taskExecutor?.waitForTerminal()
  },
  shutdownPermissions: () => permissionBroker?.shutdown() ?? Promise.resolve(),
  disconnectRuntime: () => runtimeAdapter?.disconnect() ?? Promise.resolve(),
  quit: () => app.quit(),
  forceQuit: () => app.exit(0)
})

app.on('before-quit', appShutdownGate.handleBeforeQuit)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

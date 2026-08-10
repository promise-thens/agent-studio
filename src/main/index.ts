import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption
} from '../shared/provider'
import { GrokAgentBridge } from './grok-agent'
import { ProviderConfigStore, type ProviderRuntimeConfig } from './provider/provider-config-store'
import { ProviderConnectionTester } from './provider/provider-connection-tester'
import { clearGrokProviderConfig } from './provider/grok-provider-config'
import { validateProviderConfigInput } from './provider/provider-validation'
import { redactSensitiveError, redactSensitiveText } from './security/sensitive-redaction'

let mainWindow: BrowserWindow | null = null
let agent: GrokAgentBridge | null = null
let providerStore: ProviderConfigStore | null = null
let providerTester: ProviderConnectionTester | null = null

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
async function initializeServices(): Promise<void> {
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
  agent = new GrokAgentBridge(
    (status) => mainWindow?.webContents.send('grok:status', status),
    (event) => mainWindow?.webContents.send('grok:event', event),
    (request) => mainWindow?.webContents.send('grok:permission', request),
    {
      userDataPath: app.getPath('userData'),
      getProviderConfig: () => requireProviderStore().getRuntimeConfig(),
      redactText: redactProviderText
    }
  )
}

/** 注册渲染层可调用的最小 IPC 接口。 */
function registerIpcHandlers(): void {
  ipcMain.handle('grok:get-status', (event) => {
    assertTrustedSender(event)
    return requireAgent().getStatus()
  })
  ipcMain.handle('grok:choose-workspace', async (event) => {
    assertTrustedSender(event)
    const options: Electron.OpenDialogOptions = {
      title: '选择 Agent Studio 工作目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('grok:connect', (event, workspace: string) => {
    assertTrustedSender(event)
    return requireAgent().connect(workspace)
  })
  ipcMain.handle('grok:disconnect', (event) => {
    assertTrustedSender(event)
    return requireAgent().disconnect()
  })
  ipcMain.handle('grok:send-prompt', (event, prompt: string) => {
    assertTrustedSender(event)
    return requireAgent().sendPrompt(prompt)
  })
  ipcMain.handle('grok:cancel', (event) => {
    assertTrustedSender(event)
    return requireAgent().cancel()
  })
  ipcMain.handle('grok:respond-permission', (event, requestId: string, optionId?: string) => {
    assertTrustedSender(event)
    return requireAgent().respondPermission(requestId, optionId)
  })

  ipcMain.handle('provider:get-summary', (event) => {
    assertTrustedSender(event)
    return requireProviderStore().getSummary()
  })
  ipcMain.handle('provider:list-models', async (event, input?: ProviderConnectionInput) => {
    assertTrustedSender(event)
    return runProviderOperation(async () => {
      const resolvedInput = input
        ? attachStoredCredential(input)
        : toConnectionInput(requireProviderRuntimeConfig())
      return requireProviderTester().listModels(resolvedInput)
    })
  })
  ipcMain.handle('provider:save', async (event, input: ProviderConfigInput) => {
    assertTrustedSender(event)
    return runProviderOperation(async () => {
      const resolvedInput = validateProviderConfigInput(attachStoredCredential(input))
      const result = await requireProviderTester().testInference(resolvedInput)
      if (!result.ok) throw new Error(result.message)
      return persistProviderConfig(resolvedInput)
    })
  })
  ipcMain.handle('provider:select-model', async (event, model: ProviderModelOption) => {
    assertTrustedSender(event)
    return runProviderOperation(async () => {
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
    })
  })
  ipcMain.handle('provider:clear', async (event) => {
    assertTrustedSender(event)
    return runProviderOperation(async () => {
      await requireAgent().disconnect()
      const summary = await requireProviderStore().clear()
      await clearGrokProviderConfig(app.getPath('userData'))
      return summary
    })
  })
}

/** Provider 变更需要与已连接 Runtime 保持事务一致，失败时恢复旧配置。 */
async function persistProviderConfig(input: ProviderConfigInput): Promise<ProviderConfigSummary> {
  const currentAgent = requireAgent()
  const store = requireProviderStore()
  const previous = store.getRuntimeConfig()
  const status = currentAgent.getStatus()

  if (status.state === 'busy' || status.state === 'connecting') {
    throw new Error('任务执行中，结束后才能修改模型配置。')
  }

  const workspace = status.state === 'ready' ? status.workspace : undefined
  const nextSummary = await store.save(input, { testedAt: new Date().toISOString() })
  if (!workspace) return nextSummary

  await currentAgent.disconnect(false)
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
    throw new Error(redactSensitiveError(error, getKnownSecrets()))
  }
}

function redactProviderText(text: string): string {
  return redactSensitiveText(text, getKnownSecrets())
}

function getKnownSecrets(): string[] {
  const apiKey = providerStore?.getRuntimeConfig()?.apiKey
  return apiKey ? [apiKey] : []
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('拒绝来自未知窗口的 IPC 调用。')
  }
}

function requireAgent(): GrokAgentBridge {
  if (!agent) throw new Error('Agent Runtime 尚未初始化。')
  return agent
}

function requireProviderStore(): ProviderConfigStore {
  if (!providerStore) throw new Error('Provider 配置服务尚未初始化。')
  return providerStore
}

function requireProviderTester(): ProviderConnectionTester {
  if (!providerTester) throw new Error('Provider 连接测试服务尚未初始化。')
  return providerTester
}

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId('com.promise-thens.agent-studio')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    await initializeServices()
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

app.on('before-quit', () => {
  void agent?.disconnect(false)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

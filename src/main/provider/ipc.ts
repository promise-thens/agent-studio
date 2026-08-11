import type {
  ProviderConfigInput,
  ProviderConfigSummary,
  ProviderConnectionInput,
  ProviderModelOption,
  ProviderTestResult
} from '../../shared/provider'
import type { DesktopIpcMain } from '../ipc-types'
import type { TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'

export interface ProviderIpcOperations {
  getSummary: () => ProviderConfigSummary | Promise<ProviderConfigSummary>
  listModels: (input?: ProviderConnectionInput) => Promise<ProviderTestResult>
  save: (input: ProviderConfigInput) => Promise<ProviderConfigSummary>
  selectModel: (model: ProviderModelOption) => Promise<ProviderConfigSummary>
  clear: () => Promise<ProviderConfigSummary>
}

export interface ProviderIpcDependencies {
  ipcMain: DesktopIpcMain
  assertTrustedSender: (event: TrustedIpcInvokeEvent) => void
  operations: ProviderIpcOperations
}

/**
 * 注册 Provider 原有 IPC 契约，只增加统一来源守卫。
 * Provider 成功值和 Promise rejection 保持现状，不改为 Agent/App 结果封套。
 */
export function registerProviderIpcHandlers(dependencies: ProviderIpcDependencies): void {
  dependencies.ipcMain.handle('provider:get-summary', (event, ...args) => {
    dependencies.assertTrustedSender(event)
    void args
    return dependencies.operations.getSummary()
  })
  dependencies.ipcMain.handle('provider:list-models', (event, ...args) => {
    dependencies.assertTrustedSender(event)
    return dependencies.operations.listModels(args[0] as ProviderConnectionInput | undefined)
  })
  dependencies.ipcMain.handle('provider:save', (event, ...args) => {
    dependencies.assertTrustedSender(event)
    return dependencies.operations.save(args[0] as ProviderConfigInput)
  })
  dependencies.ipcMain.handle('provider:select-model', (event, ...args) => {
    dependencies.assertTrustedSender(event)
    return dependencies.operations.selectModel(args[0] as ProviderModelOption)
  })
  dependencies.ipcMain.handle('provider:clear', (event, ...args) => {
    dependencies.assertTrustedSender(event)
    void args
    return dependencies.operations.clear()
  })
}

import { ref, type Ref } from 'vue'
import { isGrokSandboxProfile, type GrokSandboxProfile } from '../../../shared/grok-sandbox-profile'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import {
  GROK_SANDBOX_APPLIED_MESSAGE,
  GROK_SANDBOX_NOT_APPLIED_MESSAGE,
  resolveConfirmedSandboxProfile
} from '../grok-sandbox-settings'

export interface GrokSandboxSettingsState {
  confirmed: Ref<GrokSandboxProfile | null>
  saving: Ref<boolean>
  errorMessage: Ref<string>
  statusMessage: Ref<string>
  load: () => Promise<void>
  reloadFromSaved: () => Promise<void>
  applyProfile: (profile: GrokSandboxProfile) => Promise<boolean>
}

/**
 * Grok 沙箱选择器状态。确认档只在 set 返回 applied: true 后更新；
 * get 失败或 toml 非法档不得把非法字符串写进选择器。
 */
export function useGrokSandboxSettings(): GrokSandboxSettingsState {
  const confirmed = ref<GrokSandboxProfile | null>(null)
  const saving = ref(false)
  const errorMessage = ref('')
  const statusMessage = ref('')

  /** 读取已保存档。非法/失败时保留上一合法档并露出主进程错误。 */
  async function reloadFromSaved(): Promise<void> {
    try {
      const state = unwrapDesktopIpcResult(await window.app.getGrokSandbox())
      if (!isGrokSandboxProfile(state.profile)) {
        errorMessage.value = 'Grok sandbox 状态无效。'
        return
      }
      confirmed.value = state.profile
      errorMessage.value = ''
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
    }
  }

  async function load(): Promise<void> {
    errorMessage.value = ''
    statusMessage.value = ''
    await reloadFromSaved()
  }

  /**
   * 向主进程改档。未 applied 时选择器停在上一确认档，禁止先显示「已应用」。
   * 非法 profile 不发 IPC。
   */
  async function applyProfile(profile: GrokSandboxProfile): Promise<boolean> {
    if (!isGrokSandboxProfile(profile) || saving.value || confirmed.value === profile) {
      return false
    }
    saving.value = true
    errorMessage.value = ''
    statusMessage.value = ''
    try {
      const result = unwrapDesktopIpcResult(await window.app.setGrokSandbox(profile))
      const next = resolveConfirmedSandboxProfile(confirmed.value, result)
      if (result.applied === true && next === profile) {
        confirmed.value = next
        statusMessage.value = GROK_SANDBOX_APPLIED_MESSAGE
        return true
      }
      errorMessage.value = GROK_SANDBOX_NOT_APPLIED_MESSAGE
      return false
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : String(error)
      return false
    } finally {
      saving.value = false
    }
  }

  return {
    confirmed,
    saving,
    errorMessage,
    statusMessage,
    load,
    reloadFromSaved,
    applyProfile
  }
}

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { MacosFolderAccessNotice } from '../../../shared/macos-folder-access'
import { unwrapDesktopIpcResult } from '../desktop-ipc-result'
import { formatMacosFolderAccessMessage } from '../macos-folder-access-copy'

export interface MacosFolderAccessState {
  notice: Ref<MacosFolderAccessNotice | null>
  message: ComputedRef<string>
  probing: Ref<boolean>
  openingSettings: Ref<boolean>
  probe: (projectId: string | null) => Promise<void>
  openSettings: () => Promise<void>
}

/** 探测失败不得假装已授权；非 denied 不展示条。 */
export function useMacosFolderAccess(): MacosFolderAccessState {
  const notice = ref<MacosFolderAccessNotice | null>(null)
  const probing = ref(false)
  const openingSettings = ref(false)
  const message = computed(() => (notice.value ? formatMacosFolderAccessMessage(notice.value) : ''))

  async function probe(projectId: string | null): Promise<void> {
    if (!projectId) {
      notice.value = null
      return
    }
    probing.value = true
    try {
      const result = unwrapDesktopIpcResult(await window.app.probeMacosFolderAccess(projectId))
      notice.value = result.status === 'denied' ? result : null
    } catch {
      notice.value = null
    } finally {
      probing.value = false
    }
  }

  async function openSettings(): Promise<void> {
    openingSettings.value = true
    try {
      unwrapDesktopIpcResult(await window.app.openMacosFilesPrivacySettings())
    } finally {
      openingSettings.value = false
    }
  }

  return { notice, message, probing, openingSettings, probe, openSettings }
}

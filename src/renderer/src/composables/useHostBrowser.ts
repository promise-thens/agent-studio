import {
  onUnmounted,
  readonly,
  ref,
  unref,
  watch,
  type DeepReadonly,
  type MaybeRef,
  type Ref
} from 'vue'
import {
  parseHostBrowserNavigateUrl,
  type HostBrowserBounds,
  type HostBrowserChrome
} from '../../../shared/host-browser'

const EMPTY_CHROME: HostBrowserChrome = {
  url: '',
  title: '',
  isLoading: false,
  open: false
}

/**
 * 右栏可见性只跟主进程 chrome.open。
 * 打开/关闭必须等 IPC 成功，禁止先乐观显示再等失败。
 */
export function useHostBrowser(taskIdRef: MaybeRef<string | undefined | null>): {
  visible: DeepReadonly<Ref<boolean>>
  chrome: DeepReadonly<Ref<HostBrowserChrome>>
  setVisible: (open: boolean) => Promise<void>
  navigate: (url: string) => Promise<void>
  updateBounds: (bounds: HostBrowserBounds) => Promise<void>
} {
  const visible = ref(false)
  const chrome = ref<HostBrowserChrome>({ ...EMPTY_CHROME })
  const pending = ref(false)
  let unsubscribe: (() => void) | null = null

  function applyChrome(next: HostBrowserChrome): void {
    chrome.value = next
    visible.value = next.open
  }

  watch(
    () => unref(taskIdRef),
    async (taskId, previous) => {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      if (!taskId) {
        if (previous) {
          await window.task.setBrowserOpen(previous, false).catch(() => undefined)
        }
        applyChrome({ ...EMPTY_CHROME })
        return
      }

      unsubscribe = window.task.onBrowserChrome((updated) => {
        applyChrome(updated)
      })
      const result = await window.task.getBrowserChrome(taskId)
      if (result.ok) applyChrome(result.value)
    },
    { immediate: true }
  )

  onUnmounted(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  async function setVisible(open: boolean): Promise<void> {
    const taskId = unref(taskIdRef)
    if (!taskId || pending.value) return
    pending.value = true
    try {
      const result = await window.task.setBrowserOpen(taskId, open)
      if (result.ok) applyChrome(result.value)
    } finally {
      pending.value = false
    }
  }

  async function navigate(url: string): Promise<void> {
    const taskId = unref(taskIdRef)
    if (!taskId) return
    const href = parseHostBrowserNavigateUrl(url) ?? url.trim()
    const result = await window.task.userNavigateBrowser(taskId, href)
    if (result.ok) applyChrome(result.value)
  }

  async function updateBounds(bounds: HostBrowserBounds): Promise<void> {
    const taskId = unref(taskIdRef)
    if (!taskId) return
    await window.task.updateBrowserBounds(taskId, bounds)
  }

  return {
    visible: readonly(visible),
    chrome: readonly(chrome),
    setVisible,
    navigate,
    updateBounds
  }
}

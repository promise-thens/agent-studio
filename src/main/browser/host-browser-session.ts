/** Project 级 persist partition。禁止空 ID，避免落到 defaultSession。 */
export function createBrowserPartition(projectId: string): string {
  if (!projectId || projectId.trim() === '') {
    throw new Error('Project ID cannot be empty')
  }
  return `persist:as-browser:${projectId}`
}

export type HostBrowserClearDataKind = 'cookies' | 'cache' | 'history' | 'downloads'
export type HostBrowserClearStorageName =
  'cookies' | 'filesystem' | 'indexdb' | 'localstorage' | 'cachestorage'

const HOST_BROWSER_CLEAR_KIND_STORAGES: Record<
  HostBrowserClearDataKind,
  readonly HostBrowserClearStorageName[]
> = {
  cookies: ['cookies'],
  cache: ['cachestorage'],
  history: ['localstorage', 'indexdb'],
  downloads: ['filesystem']
}

/**
 * 把设置页 kinds 映射到 Electron clearStorageData storages。
 * 没有独立的 history/downloads 类型，只能用最接近的 web 存储，且只清内置 partition。
 */
export function mapHostBrowserClearDataKindsToStorages(
  kinds: readonly HostBrowserClearDataKind[]
): HostBrowserClearStorageName[] {
  const seen = new Set<HostBrowserClearStorageName>()
  const storages: HostBrowserClearStorageName[] = []
  for (const kind of kinds) {
    const mapped = HOST_BROWSER_CLEAR_KIND_STORAGES[kind]
    if (!mapped) continue
    for (const storage of mapped) {
      if (seen.has(storage)) continue
      seen.add(storage)
      storages.push(storage)
    }
  }
  return storages
}

/**
 * 清数据只认当前选中 Task 的 projectId。Renderer 不得提交 partition 名或路径。
 */
export function resolveHostBrowserClearProjectId(
  selectedTaskId: string | null | undefined,
  projectId: string | null | undefined
): string | null {
  if (typeof selectedTaskId !== 'string' || selectedTaskId.trim() === '') return null
  if (typeof projectId !== 'string' || projectId.trim() === '') return null
  return projectId
}

/**
 * 只擦 `persist:as-browser:{projectId}`。空 project 直接失败，避免落到 defaultSession。
 */
export async function clearHostBrowserPartitionData(
  projectId: string,
  kinds: readonly HostBrowserClearDataKind[],
  clearStorageData: (partition: string, storages: HostBrowserClearStorageName[]) => Promise<void>
): Promise<void> {
  const resolved = resolveHostBrowserClearProjectId('task', projectId)
  if (!resolved) {
    throw new Error('没有可清理的内置浏览器会话。')
  }
  await clearStorageData(
    createBrowserPartition(resolved),
    mapHostBrowserClearDataKindsToStorages(kinds)
  )
}

/** Guest 固定沙箱：无 preload、无 nodeIntegration，不把 App IPC 暴露给网页。 */
export function createBrowserWebPreferences(): {
  sandbox: true
  contextIsolation: true
  nodeIntegration: false
} {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
}

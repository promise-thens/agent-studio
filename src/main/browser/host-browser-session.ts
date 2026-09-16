/** Project 级 persist partition。禁止空 ID，避免落到 defaultSession。 */
export function createBrowserPartition(projectId: string): string {
  if (!projectId || projectId.trim() === '') {
    throw new Error('Project ID cannot be empty')
  }
  return `persist:as-browser:${projectId}`
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

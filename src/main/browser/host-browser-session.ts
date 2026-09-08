export function createBrowserPartition(projectId: string): string {
  if (!projectId || projectId.trim() === '') {
    throw new Error('Project ID cannot be empty')
  }
  return `persist:as-browser:${projectId}`
}

export function createBrowserWebPreferences() {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false
  }
}

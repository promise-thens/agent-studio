import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { HostBrowserActionResult } from './host-browser-actions'
import { HostBrowserMcpGateway } from './host-browser-mcp-gateway'
import type { HostBrowserMcpInjection } from './host-browser-mcp'

export interface HostBrowserMcpHostDependencies {
  userDataPath: string
  getEnabled: () => boolean
  getExecPath: () => string
  getScriptPath: () => string
  getPathEnv?: () => string | undefined
  perform: (taskId: string, action: unknown) => Promise<HostBrowserActionResult>
}

/**
 * 为当前 Task 准备一次性 token 和本机 socket。
 * 设置关闭或打包脚本缺失时返回 null，session 只带用户 MCP。
 */
export class HostBrowserMcpHost {
  private readonly gateway: HostBrowserMcpGateway

  constructor(private readonly dependencies: HostBrowserMcpHostDependencies) {
    this.gateway = new HostBrowserMcpGateway({ perform: dependencies.perform })
  }

  async prepareForTask(taskId: string): Promise<HostBrowserMcpInjection | null> {
    if (!this.dependencies.getEnabled()) return null
    const scriptPath = this.dependencies.getScriptPath()
    const execPath = this.dependencies.getExecPath()
    if (!scriptPath || !existsSync(scriptPath) || !isAbsolute(execPath)) return null
    const socketPath = join(this.dependencies.userDataPath, 'browser', 'host-browser.sock')
    await this.gateway.listen(socketPath)
    const token = randomBytes(32).toString('base64url')
    this.gateway.bind(token, taskId)
    return {
      execPath,
      scriptPath,
      socketPath,
      token,
      ...(this.dependencies.getPathEnv?.() ? { pathEnv: this.dependencies.getPathEnv() } : {})
    }
  }

  async close(): Promise<void> {
    await this.gateway.close()
  }
}

export function resolveHostBrowserMcpScriptPath(mainDirectory: string): string {
  const bundled = join(mainDirectory, 'host-browser-mcp-stdio.js')
  if (existsSync(bundled)) return bundled
  return join(mainDirectory.replace('app.asar', 'app.asar.unpacked'), 'host-browser-mcp-stdio.js')
}

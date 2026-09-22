import { constants, promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProjectSummary } from '../../shared/task-history'
import type { ProjectRegistry } from './project-registry'

/** 无项目聊天只使用主进程指定的独立工作目录；不得把配置、凭据或其父目录作为 cwd。 */
export class ManagedChatWorkspace {
  private pending?: Promise<ProjectSummary>

  constructor(private readonly options: {
    root: string
    userDataPath: string
    registry: ProjectRegistry
  }) {}

  /** 并发点击共用准备请求；失败释放单飞以便重试，重启由 registry 复用同一身份。 */
  prepare(): Promise<ProjectSummary> {
    if (this.pending) return this.pending
    this.pending = this.prepareDirectory().finally(() => { this.pending = undefined })
    return this.pending
  }

  /** 两次路径隔离检查覆盖 symlink；只创建自己的工作目录，不修改用户项目权限。 */
  private async prepareDirectory(): Promise<ProjectSummary> {
    try {
      const { root, userDataPath, registry } = this.options
      if (!isAbsolute(root) || !isAbsolute(userDataPath)) throw new Error('invalid root')
      assertSeparateRoots(resolve(root), resolve(userDataPath))
      await fs.mkdir(root, { recursive: true, mode: 0o700 })
      const canonicalRoot = await fs.realpath(root)
      const canonicalData = await fs.realpath(userDataPath)
      assertSeparateRoots(canonicalRoot, canonicalData)
      await fs.access(canonicalRoot, constants.R_OK | constants.W_OK | constants.X_OK)
      return await registry.register(canonicalRoot, 'managed-chat')
    } catch {
      throw new Error('无法准备聊天工作目录，请检查磁盘空间和目录权限后重试。')
    }
  }
}

/** 双向排除包含关系，防止 Runtime cwd 覆盖配置树或落进凭据目录。 */
function assertSeparateRoots(left: string, right: string): void {
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  }
  if (contains(left, right) || contains(right, left)) throw new Error('overlapping roots')
}

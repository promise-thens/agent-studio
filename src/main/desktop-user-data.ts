/** 解析桌面 Chromium userData 时使用的启动形态。 */
export interface ResolveDesktopUserDataPathOptions {
  readonly packaged: boolean
  readonly currentUserData: string
  readonly hasIsolatedBootstrap: boolean
}

/**
 * 未打包进程必须与安装包错开 Chromium userData，否则单实例锁会把另一边直接 quit。
 * 受控 E2E / GACP-01 已经切到临时目录时不得再改。
 * 安装包保持 Electron 默认路径，避免把已保存的密钥和任务迁走。
 */
export function resolveDesktopUserDataPath(options: ResolveDesktopUserDataPathOptions): string {
  if (options.hasIsolatedBootstrap || options.packaged) return options.currentUserData
  return `${options.currentUserData}-dev`
}

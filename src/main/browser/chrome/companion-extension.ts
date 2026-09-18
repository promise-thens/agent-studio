import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { AgentPointer, AgentPointerBounds } from '../../../shared/agent-pointer-overlay'
import { installChromeNativeHostManifest } from './native-host'

export interface ChromeNativeSnapshotOverlayInput {
  windowScreenBounds?: AgentPointerBounds
  cssX?: number
  cssY?: number
  zoom?: number
  overlayBounds?: AgentPointerBounds
}

/**
 * 配套扩展 viewport CSS → overlay 本地 DIP。
 * 必须用 overlay 窗落地后的 getBounds()；没有 windowScreenBounds 不得发明光标。
 * zoom 缺省当 1。
 */
export function mapChromeNativeSnapshotToOverlayDip(
  input: ChromeNativeSnapshotOverlayInput
): AgentPointer | undefined {
  const windowBounds = input.windowScreenBounds
  const overlayBounds = input.overlayBounds
  const cssX = input.cssX
  const cssY = input.cssY
  const zoom =
    input.zoom === undefined ? 1 : Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : NaN
  if (!windowBounds || !overlayBounds) return undefined
  if (!isFiniteBounds(windowBounds) || !isFiniteBounds(overlayBounds)) return undefined
  if (
    typeof cssX !== 'number' ||
    typeof cssY !== 'number' ||
    !Number.isFinite(cssX) ||
    !Number.isFinite(cssY) ||
    !Number.isFinite(zoom)
  ) {
    return undefined
  }
  const overlayX = windowBounds.x + cssX / zoom - overlayBounds.x
  const overlayY = windowBounds.y + cssY / zoom - overlayBounds.y
  if (!Number.isFinite(overlayX) || !Number.isFinite(overlayY)) return undefined
  return { x: overlayX, y: overlayY }
}

/** 没有窗 DIP 或节点 CSS 就不得建 overlay 窗。 */
export function companionSnapshotHasMappableGeometry(input: {
  windowScreenBounds?: AgentPointerBounds
  cssX?: number
  cssY?: number
}): boolean {
  const bounds = input.windowScreenBounds
  return (
    bounds != null &&
    isFiniteBounds(bounds) &&
    typeof input.cssX === 'number' &&
    typeof input.cssY === 'number' &&
    Number.isFinite(input.cssX) &&
    Number.isFinite(input.cssY)
  )
}

function isFiniteBounds(value: AgentPointerBounds): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height)
  )
}

/** Native Messaging path 不得是 bash/sh 等通用 Shell。 */
export function isChromeNativeHostForbiddenExecPath(execPath: string): boolean {
  if (typeof execPath !== 'string' || execPath.trim() === '' || execPath.includes('\0')) {
    return true
  }
  const base = execPath.split(/[/\\]/).pop() ?? ''
  return base === 'bash' || base === 'sh' || base === 'zsh' || base === 'dash'
}

function posixShellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * 写出专用包装命令。Chrome 清单的 path 必须指向它，而不是 /bin/bash。
 * 包装脚本只拉起 chrome-native-host-stdio，禁止变成任意 Shell。
 * 必须钉死本次安装的 chrome-native-host.json：Chrome 全局只有一份 Native Host 清单，
 * 不写 AGENT_STUDIO_CHROME_NATIVE_STATE 时，残留的 agent-studio-dev json 会把正式包连到另一份 partition。
 */
export async function writeChromeNativeHostWrapper(options: {
  wrapperPath: string
  electronExecPath: string
  scriptPath: string
  statePath: string
}): Promise<string> {
  if (isChromeNativeHostForbiddenExecPath(options.electronExecPath)) {
    throw new Error('Native Host 命令不得是通用 Shell。')
  }
  if (isChromeNativeHostForbiddenExecPath(options.scriptPath)) {
    throw new Error('Native Host 命令不得是通用 Shell。')
  }
  if (!options.scriptPath.includes('chrome-native-host-stdio')) {
    throw new Error('Native Host 必须指向 chrome-native-host-stdio。')
  }
  if (typeof options.wrapperPath !== 'string' || !isAbsolute(options.wrapperPath)) {
    throw new Error('Native Host 包装路径无效。')
  }
  if (
    typeof options.statePath !== 'string' ||
    !isAbsolute(options.statePath) ||
    options.statePath.includes('\0')
  ) {
    throw new Error('Native Host 状态文件路径无效。')
  }
  const stateBase = options.statePath.split(/[/\\]/).pop() ?? ''
  if (stateBase !== 'chrome-native-host.json') {
    throw new Error('Native Host 状态文件必须是 chrome-native-host.json。')
  }
  const script = `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
export AGENT_STUDIO_CHROME_NATIVE_STATE=${posixShellSingleQuote(options.statePath)}
exec ${posixShellSingleQuote(options.electronExecPath)} ${posixShellSingleQuote(options.scriptPath)} "$@"
`
  await mkdir(dirname(options.wrapperPath), { recursive: true, mode: 0o700 })
  await writeFile(options.wrapperPath, script, { encoding: 'utf8', mode: 0o700 })
  return options.wrapperPath
}

export function resolveCompanionChromeExtensionDirectory(input: {
  mainDirectory: string
  resourcesPath?: string
  appPath?: string
}): string | null {
  const candidates = [
    input.resourcesPath ? join(input.resourcesPath, 'chrome-extension/agent-studio-browser') : '',
    input.appPath ? join(input.appPath, 'chrome-extension/agent-studio-browser') : '',
    join(input.mainDirectory, '../../chrome-extension/agent-studio-browser')
  ].filter((path) => path.length > 0)
  for (const directory of candidates) {
    if (existsSync(join(directory, 'manifest.json'))) return directory
  }
  return null
}

/**
 * 安装：reveal unpacked 扩展目录，并把 Native Host 清单写到注入的 homeDir。
 * 测试必须传入临时 homeDir；禁止默认写开发者真 Chrome 目录。
 */
export async function installHostBrowserCompanionExtension(options: {
  homeDir: string
  execPath: string
  extensionDirectory: string
  reveal: (directory: string) => Promise<unknown>
}): Promise<{ installed: true }> {
  if (isChromeNativeHostForbiddenExecPath(options.execPath)) {
    throw new Error('Native Host 命令不得是通用 Shell。')
  }
  if (!options.execPath.includes('chrome-native-host-stdio')) {
    throw new Error('Native Host 必须指向 chrome-native-host-stdio。')
  }
  if (!existsSync(join(options.extensionDirectory, 'manifest.json'))) {
    throw new Error('未找到配套扩展目录。')
  }
  await options.reveal(options.extensionDirectory)
  await installChromeNativeHostManifest({
    homeDir: options.homeDir,
    execPath: options.execPath
  })
  return { installed: true }
}

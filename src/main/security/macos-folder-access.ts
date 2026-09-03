import { isAbsolute, relative, resolve } from 'node:path'
import type {
  MacosFolderAccessNotice,
  MacosPrivacySettingsAppLabel,
  MacosProtectedFolderKind
} from '../../shared/macos-folder-access'

/** 只打开「文件和文件夹」，不要误开屏幕录制或辅助功能。 */
export const MACOS_FILES_AND_FOLDERS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'

const PROTECTED_FOLDER_ENTRIES = [
  { kind: 'documents', name: 'Documents' },
  { kind: 'desktop', name: 'Desktop' },
  { kind: 'downloads', name: 'Downloads' }
] as const

export type FolderAccessErrorClass = 'denied' | 'other'

export interface MacosFolderAccessProbeOptions {
  platform: NodeJS.Platform
  homedir: string
  isPackaged: boolean
  readDirectory: (directory: string) => Promise<unknown>
}

export interface OpenMacosFilesPrivacySettingsOptions {
  openExternal: (url: string) => Promise<unknown>
}

/** 开发版跑的是 Electron 身份，打包后才是 Agent Studio。 */
export function resolveMacosPrivacySettingsAppLabel(
  isPackaged: boolean
): MacosPrivacySettingsAppLabel {
  return isPackaged ? 'Agent Studio' : 'Electron'
}

/** 路径必须落在家目录下那个真实文件夹内，Documents-backup 这种前缀不算。 */
export function protectedUserFolderKind(
  workspace: string,
  homedir: string
): MacosProtectedFolderKind | null {
  const child = resolve(workspace)
  for (const entry of PROTECTED_FOLDER_ENTRIES) {
    if (isPathInside(resolve(homedir, entry.name), child)) return entry.kind
  }
  return null
}

export function isMacosProtectedUserFolder(
  workspace: string,
  homedir: string,
  platform: NodeJS.Platform
): boolean {
  return platform === 'darwin' && protectedUserFolderKind(workspace, homedir) !== null
}

export function classifyFolderAccessError(error: unknown): FolderAccessErrorClass {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
  if (code === 'EPERM' || code === 'EACCES') return 'denied'
  return 'other'
}

/**
 * 用读目录去撞 TCC：系统会在 Info.plist 有用途说明时弹窗。
 * 探测失败不得假装已授权；也不阻断 Runtime 连接。
 */
export async function probeMacosWorkspaceFolderAccess(
  workspace: string,
  options: MacosFolderAccessProbeOptions
): Promise<MacosFolderAccessNotice> {
  const settingsAppLabel = resolveMacosPrivacySettingsAppLabel(options.isPackaged)
  if (options.platform !== 'darwin') {
    return { status: 'unsupported', settingsAppLabel }
  }
  const folderKind = protectedUserFolderKind(workspace, options.homedir)
  if (!folderKind) {
    return { status: 'not-protected', settingsAppLabel }
  }
  try {
    await options.readDirectory(workspace)
    return { status: 'ok', folderKind, settingsAppLabel }
  } catch (error) {
    if (classifyFolderAccessError(error) === 'denied') {
      return { status: 'denied', folderKind, settingsAppLabel }
    }
    return { status: 'ok', folderKind, settingsAppLabel }
  }
}

export async function openMacosFilesPrivacySettings(
  options: OpenMacosFilesPrivacySettingsOptions
): Promise<void> {
  await options.openExternal(MACOS_FILES_AND_FOLDERS_SETTINGS_URL)
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

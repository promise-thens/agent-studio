import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_FILES_AND_FOLDERS_SETTINGS_URL,
  classifyFolderAccessError,
  isMacosProtectedUserFolder,
  openMacosFilesPrivacySettings,
  probeMacosWorkspaceFolderAccess,
  protectedUserFolderKind,
  resolveMacosPrivacySettingsAppLabel
} from './macos-folder-access'

const home = '/Users/huyaohang'

describe('macOS 文稿/桌面/下载文件夹探测', () => {
  it('只把家目录下的 Documents、Desktop、Downloads 算作受保护目录', () => {
    expect(protectedUserFolderKind(`${home}/Documents/agentStudioTest`, home)).toBe('documents')
    expect(protectedUserFolderKind(`${home}/Desktop/个人/agent-studio`, home)).toBe('desktop')
    expect(protectedUserFolderKind(`${home}/Downloads/inbox`, home)).toBe('downloads')
    expect(protectedUserFolderKind(`${home}/Documents`, home)).toBe('documents')
    expect(protectedUserFolderKind(`${home}/Documents-backup/app`, home)).toBeNull()
    expect(protectedUserFolderKind(`${home}/code/agent-studio`, home)).toBeNull()
  })

  it('darwin 上受保护目录才需要探测，其它平台直接 unsupported', () => {
    expect(isMacosProtectedUserFolder(`${home}/Documents/app`, home, 'darwin')).toBe(true)
    expect(isMacosProtectedUserFolder(`${home}/Documents/app`, home, 'linux')).toBe(false)
    expect(isMacosProtectedUserFolder(`${home}/code/app`, home, 'darwin')).toBe(false)
  })

  it('EPERM / EACCES 才算系统拒绝，其它错误不当成文件夹权限问题', () => {
    expect(classifyFolderAccessError(Object.assign(new Error('denied'), { code: 'EPERM' }))).toBe(
      'denied'
    )
    expect(classifyFolderAccessError(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(
      'denied'
    )
    expect(classifyFolderAccessError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(
      'other'
    )
  })

  it('开发版设置页应用名是 Electron，打包版是 Agent Studio', () => {
    expect(resolveMacosPrivacySettingsAppLabel(false)).toBe('Electron')
    expect(resolveMacosPrivacySettingsAppLabel(true)).toBe('Agent Studio')
  })

  it('非 macOS 不读盘，返回 unsupported', async () => {
    const readDirectory = vi.fn()
    await expect(
      probeMacosWorkspaceFolderAccess(`${home}/Documents/app`, {
        platform: 'linux',
        homedir: home,
        isPackaged: true,
        readDirectory
      })
    ).resolves.toEqual({
      status: 'unsupported',
      settingsAppLabel: 'Agent Studio'
    })
    expect(readDirectory).not.toHaveBeenCalled()
  })

  it('不受保护的工作区不读盘，返回 not-protected', async () => {
    const readDirectory = vi.fn()
    await expect(
      probeMacosWorkspaceFolderAccess(`${home}/code/app`, {
        platform: 'darwin',
        homedir: home,
        isPackaged: false,
        readDirectory
      })
    ).resolves.toEqual({
      status: 'not-protected',
      settingsAppLabel: 'Electron'
    })
    expect(readDirectory).not.toHaveBeenCalled()
  })

  it('受保护目录读成功则 ok，并带上 folderKind', async () => {
    const readDirectory = vi.fn(async () => ['README.md'])
    await expect(
      probeMacosWorkspaceFolderAccess(`${home}/Documents/agentStudioTest`, {
        platform: 'darwin',
        homedir: home,
        isPackaged: false,
        readDirectory
      })
    ).resolves.toEqual({
      status: 'ok',
      folderKind: 'documents',
      settingsAppLabel: 'Electron'
    })
    expect(readDirectory).toHaveBeenCalledWith(`${home}/Documents/agentStudioTest`)
  })

  it('受保护目录 getcwd 式 EPERM 则 denied，不把成功伪装进去', async () => {
    const readDirectory = vi.fn(async () => {
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
    })
    await expect(
      probeMacosWorkspaceFolderAccess(`${home}/Documents/agentStudioTest`, {
        platform: 'darwin',
        homedir: home,
        isPackaged: true,
        readDirectory
      })
    ).resolves.toEqual({
      status: 'denied',
      folderKind: 'documents',
      settingsAppLabel: 'Agent Studio'
    })
  })

  it('打开系统设置只走文件和文件夹页，不打开屏幕录制', async () => {
    const openExternal = vi.fn(async () => true)
    await openMacosFilesPrivacySettings({ openExternal })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith(MACOS_FILES_AND_FOLDERS_SETTINGS_URL)
    expect(MACOS_FILES_AND_FOLDERS_SETTINGS_URL).toContain('Privacy_FilesAndFolders')
    expect(MACOS_FILES_AND_FOLDERS_SETTINGS_URL).not.toContain('ScreenCapture')
    expect(MACOS_FILES_AND_FOLDERS_SETTINGS_URL).not.toContain('Privacy_Accessibility')
  })
})

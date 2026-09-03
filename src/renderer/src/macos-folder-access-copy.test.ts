import { describe, expect, it } from 'vitest'
import { formatMacosFolderAccessMessage } from './macos-folder-access-copy'

describe('macOS 文件夹权限文案', () => {
  it('只在 denied 时出提示，并点名系统设置里可能显示的应用名', () => {
    expect(
      formatMacosFolderAccessMessage({
        status: 'ok',
        folderKind: 'documents',
        settingsAppLabel: 'Electron'
      })
    ).toBe('')
    expect(
      formatMacosFolderAccessMessage({
        status: 'denied',
        folderKind: 'documents',
        settingsAppLabel: 'Electron'
      })
    ).toContain('文稿')
    expect(
      formatMacosFolderAccessMessage({
        status: 'denied',
        folderKind: 'documents',
        settingsAppLabel: 'Electron'
      })
    ).toContain('Electron')
    expect(
      formatMacosFolderAccessMessage({
        status: 'denied',
        folderKind: 'desktop',
        settingsAppLabel: 'Agent Studio'
      })
    ).toContain('桌面')
    expect(
      formatMacosFolderAccessMessage({
        status: 'denied',
        folderKind: 'desktop',
        settingsAppLabel: 'Agent Studio'
      })
    ).not.toContain('开发版')
  })
})

import { describe, expect, it } from 'vitest'
import { parseMacosFolderAccessNotice } from './macos-folder-access'

describe('parseMacosFolderAccessNotice', () => {
  it('denied 必须带 folderKind，并丢掉路径字段', () => {
    expect(
      parseMacosFolderAccessNotice({
        status: 'denied',
        folderKind: 'documents',
        settingsAppLabel: 'Electron',
        workspace: '/Users/huyaohang/Documents/secret'
      })
    ).toEqual({
      status: 'denied',
      folderKind: 'documents',
      settingsAppLabel: 'Electron'
    })
    expect(
      parseMacosFolderAccessNotice({
        status: 'denied',
        settingsAppLabel: 'Agent Studio'
      })
    ).toBeNull()
  })

  it('拒绝未知 status 或未知应用名', () => {
    expect(
      parseMacosFolderAccessNotice({
        status: 'granted',
        settingsAppLabel: 'Agent Studio'
      })
    ).toBeNull()
    expect(
      parseMacosFolderAccessNotice({
        status: 'ok',
        settingsAppLabel: 'Chrome'
      })
    ).toBeNull()
  })
})

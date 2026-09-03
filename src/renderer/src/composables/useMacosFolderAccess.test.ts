import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import type { MacosFolderAccessNotice } from '../../../shared/macos-folder-access'
import { useMacosFolderAccess } from './useMacosFolderAccess'

function ok<T>(data: T): DesktopIpcResult<T> {
  return { ok: true, value: data }
}

describe('useMacosFolderAccess', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        app: {
          probeMacosFolderAccess: vi.fn(),
          openMacosFilesPrivacySettings: vi.fn(async () => ok(null))
        }
      }
    })
  })

  it('denied 才展示提示，ok 则清空', async () => {
    const denied: MacosFolderAccessNotice = {
      status: 'denied',
      folderKind: 'documents',
      settingsAppLabel: 'Electron'
    }
    vi.mocked(window.app.probeMacosFolderAccess).mockResolvedValueOnce(ok(denied))
    const state = useMacosFolderAccess()
    await state.probe('project-1')
    expect(state.notice.value).toEqual(denied)
    expect(state.message.value).toContain('文稿')

    vi.mocked(window.app.probeMacosFolderAccess).mockResolvedValueOnce(
      ok({ status: 'ok', folderKind: 'documents', settingsAppLabel: 'Electron' })
    )
    await state.probe('project-1')
    expect(state.notice.value).toBeNull()
    expect(state.message.value).toBe('')
  })

  it('没有 projectId 时清空，不调用探测', async () => {
    const state = useMacosFolderAccess()
    state.notice.value = {
      status: 'denied',
      folderKind: 'desktop',
      settingsAppLabel: 'Agent Studio'
    }
    await state.probe(null)
    expect(state.notice.value).toBeNull()
    expect(window.app.probeMacosFolderAccess).not.toHaveBeenCalled()
  })
})

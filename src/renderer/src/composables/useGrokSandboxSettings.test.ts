import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopIpcResult } from '../../../shared/ipc-result'
import type { AppGrokSandboxApplyResult, AppGrokSandboxState } from '../../../shared/app-ipc'
import { useGrokSandboxSettings } from './useGrokSandboxSettings'

function ok<T>(data: T): DesktopIpcResult<T> {
  return { ok: true, value: data }
}

function fail(
  code: 'invalid-state' | 'invalid-input' | 'operation-failed',
  message: string
): DesktopIpcResult<never> {
  return { ok: false, error: { code, message } }
}

describe('useGrokSandboxSettings', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        app: {
          getGrokSandbox: vi.fn(),
          setGrokSandbox: vi.fn()
        }
      }
    })
  })

  it('加载后只展示已保存的合法档，非法 get 不得改选择器', async () => {
    vi.mocked(window.app.getGrokSandbox).mockResolvedValueOnce(
      ok<AppGrokSandboxState>({ profile: 'off' })
    )
    const state = useGrokSandboxSettings()
    await state.load()
    expect(state.confirmed.value).toBe('off')

    vi.mocked(window.app.getGrokSandbox).mockResolvedValueOnce(
      fail('operation-failed', 'Grok sandbox 状态无效。')
    )
    await state.reloadFromSaved()
    expect(state.confirmed.value).toBe('off')
    expect(state.errorMessage.value).toContain('Grok sandbox 状态无效')
  })

  it('set 返回 applied: false 时保持上一确认档，不显示已应用', async () => {
    vi.mocked(window.app.getGrokSandbox).mockResolvedValueOnce(
      ok<AppGrokSandboxState>({ profile: 'off' })
    )
    vi.mocked(window.app.setGrokSandbox).mockResolvedValueOnce(
      ok<AppGrokSandboxApplyResult>({ profile: 'workspace', applied: false })
    )
    const state = useGrokSandboxSettings()
    await state.load()
    await state.applyProfile('workspace')
    expect(window.app.setGrokSandbox).toHaveBeenCalledWith('workspace')
    expect(state.confirmed.value).toBe('off')
    expect(state.errorMessage.value).toBeTruthy()
    expect(state.statusMessage.value).not.toContain('已应用')
  })

  it('set 成功 applied: true 后才更新确认档', async () => {
    vi.mocked(window.app.getGrokSandbox).mockResolvedValueOnce(
      ok<AppGrokSandboxState>({ profile: 'off' })
    )
    vi.mocked(window.app.setGrokSandbox).mockResolvedValueOnce(
      ok<AppGrokSandboxApplyResult>({ profile: 'read-only', applied: true })
    )
    const state = useGrokSandboxSettings()
    await state.load()
    await state.applyProfile('read-only')
    expect(state.confirmed.value).toBe('read-only')
    expect(state.statusMessage.value).toContain('已应用')
    expect(state.errorMessage.value).toBe('')
  })

  it('执行中 invalid-state 失败时回到上一确认档，不得静默改成 off', async () => {
    vi.mocked(window.app.getGrokSandbox).mockResolvedValueOnce(
      ok<AppGrokSandboxState>({ profile: 'workspace' })
    )
    vi.mocked(window.app.setGrokSandbox).mockResolvedValueOnce(
      fail('invalid-state', '任务执行中，结束后才能保存并重载 Grok 配置。')
    )
    const state = useGrokSandboxSettings()
    await state.load()
    await state.applyProfile('strict')
    expect(state.confirmed.value).toBe('workspace')
    expect(state.errorMessage.value).toContain('任务执行中')
    expect(state.statusMessage.value).not.toContain('已应用')
  })

  it('非法 profile 不发 IPC，选择器不吃进字符串', async () => {
    vi.mocked(window.app.getGrokSandbox).mockResolvedValueOnce(
      ok<AppGrokSandboxState>({ profile: 'off' })
    )
    const state = useGrokSandboxSettings()
    await state.load()
    await state.applyProfile('devbox' as never)
    expect(window.app.setGrokSandbox).not.toHaveBeenCalled()
    expect(state.confirmed.value).toBe('off')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { APP_INVOKE_CHANNELS } from '../shared/app-ipc'
import type { DesktopIpcResult } from '../shared/ipc-result'
import type { DesktopIpcHandler } from './ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from './security/ipc-sender-validation'
import { registerAppIpcHandlers } from './app-ipc'

const event = {} as TrustedIpcInvokeEvent

describe('App IPC Handler', () => {
  function createFixture(): {
    handler: DesktopIpcHandler
    chooseWorkspace: ReturnType<typeof vi.fn>
    assertTrustedSender: ReturnType<typeof vi.fn>
  } {
    let handler: DesktopIpcHandler | undefined
    const chooseWorkspace = vi.fn(async () => '/tmp/project')
    const assertTrustedSender = vi.fn()
    registerAppIpcHandlers({
      ipcMain: {
        handle: (channel, nextHandler) => {
          expect(channel).toBe(APP_INVOKE_CHANNELS.chooseWorkspace)
          handler = nextHandler
        }
      },
      assertTrustedSender,
      chooseWorkspace,
      sanitizeError: (error) => (error instanceof Error ? error.message : String(error))
    })
    if (!handler) throw new Error('Handler 未注册')
    return { handler, chooseWorkspace, assertTrustedSender }
  }

  it('目录选择成功和取消都返回显式成功值', async () => {
    const fixture = createFixture()
    expect(await fixture.handler(event)).toEqual({ ok: true, value: '/tmp/project' })

    fixture.chooseWorkspace.mockResolvedValueOnce(null)
    expect(await fixture.handler(event)).toEqual({ ok: true, value: null })
  })

  it('拒绝额外参数且不打开 Dialog', async () => {
    const fixture = createFixture()
    const result = (await fixture.handler(event, 'unexpected')) as DesktopIpcResult<unknown>

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-input' } })
    expect(fixture.chooseWorkspace).not.toHaveBeenCalled()
  })

  it('来源拒绝先于 Dialog', async () => {
    const fixture = createFixture()
    fixture.assertTrustedSender.mockImplementation(() => {
      throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
    })

    expect(await fixture.handler(event)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(fixture.chooseWorkspace).not.toHaveBeenCalled()
  })

  it('Dialog 异常转换为有限错误封套', async () => {
    const fixture = createFixture()
    fixture.chooseWorkspace.mockRejectedValueOnce(new Error('dialog failed'))

    expect(await fixture.handler(event)).toEqual({
      ok: false,
      error: { code: 'operation-failed', message: 'dialog failed' }
    })
  })
})

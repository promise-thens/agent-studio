import { describe, expect, it } from 'vitest'
import { unwrapDesktopIpcResult, type RendererDesktopIpcError } from './desktop-ipc-result'

describe('Renderer IPC 结果解包', () => {
  it('返回成功值并保留 null', () => {
    expect(unwrapDesktopIpcResult({ ok: true, value: { state: 'ready' } })).toEqual({
      state: 'ready'
    })
    expect(unwrapDesktopIpcResult({ ok: true, value: null })).toBeNull()
  })

  it('失败时只消费稳定 code 和有限 message', () => {
    let captured: RendererDesktopIpcError | undefined
    try {
      unwrapDesktopIpcResult({
        ok: false,
        error: { code: 'invalid-state', message: 'Runtime 当前状态不允许连接。' }
      })
    } catch (error) {
      captured = error as RendererDesktopIpcError
    }

    expect(captured).toBeInstanceOf(Error)
    expect(captured?.name).toBe('DesktopIpcError')
    expect(captured?.code).toBe('invalid-state')
    expect(captured?.message).toBe('Runtime 当前状态不允许连接。')
  })
})

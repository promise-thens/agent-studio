import { describe, expect, it, vi } from 'vitest'
import type { DesktopIpcHandler } from '../ipc-types'
import { DesktopIpcFailure, type TrustedIpcInvokeEvent } from '../security/ipc-sender-validation'
import { registerProviderIpcHandlers } from './ipc'

const event = {} as TrustedIpcInvokeEvent

describe('Provider IPC Handler', () => {
  it('非法来源不会触发配置、网络或 Runtime 业务回调', async () => {
    const handlers = new Map<string, DesktopIpcHandler>()
    const operations = {
      getSummary: vi.fn(),
      listModels: vi.fn(),
      save: vi.fn(),
      selectModel: vi.fn(),
      clear: vi.fn()
    }
    registerProviderIpcHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      assertTrustedSender: () => {
        throw new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
      },
      operations
    })

    for (const [channel, handler] of handlers) {
      await expect(Promise.resolve().then(() => handler(event, { channel }))).rejects.toThrow(
        '拒绝此 IPC 调用。'
      )
    }
    expect(operations.getSummary).not.toHaveBeenCalled()
    expect(operations.listModels).not.toHaveBeenCalled()
    expect(operations.save).not.toHaveBeenCalled()
    expect(operations.selectModel).not.toHaveBeenCalled()
    expect(operations.clear).not.toHaveBeenCalled()
  })

  it('保持 Provider 原始成功值和请求参数', async () => {
    const handlers = new Map<string, DesktopIpcHandler>()
    const summary = {
      configured: true,
      hasApiKey: true,
      credentialStorage: 'secure' as const
    }
    const save = vi.fn(async () => summary)
    registerProviderIpcHandlers({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      assertTrustedSender: vi.fn(),
      operations: {
        getSummary: vi.fn(() => summary),
        listModels: vi.fn(async () => ({ ok: true, stage: 'models' as const, message: 'ok' })),
        save,
        selectModel: vi.fn(async () => summary),
        clear: vi.fn(async () => summary)
      }
    })
    const input = { baseUrl: 'https://example.com/v1', authMode: 'none' as const, modelId: 'm1' }

    expect(await handlers.get('provider:save')?.(event, input)).toBe(summary)
    expect(save).toHaveBeenCalledWith(input)
  })
})

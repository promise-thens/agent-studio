import { describe, expect, it, vi } from 'vitest'
import {
  assertTrustedIpcSender,
  DesktopIpcFailure,
  sendToTrustedRenderer,
  toDesktopIpcError,
  truncateUtf8,
  type RendererTrustOptions,
  type TrustedIpcInvokeEvent,
  type TrustedRendererFrame,
  type TrustedRendererWebContents,
  type TrustedRendererWindow
} from './ipc-sender-validation'

function createFixture(url = 'http://127.0.0.1:5173/index.html'): {
  event: TrustedIpcInvokeEvent
  frame: TrustedRendererFrame
  webContents: TrustedRendererWebContents
  window: TrustedRendererWindow
  options: RendererTrustOptions
} {
  const frame: TrustedRendererFrame = {
    url,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }
  const webContents: TrustedRendererWebContents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false)
  }
  const window: TrustedRendererWindow = {
    webContents,
    isDestroyed: vi.fn(() => false)
  }

  return {
    frame,
    webContents,
    window,
    event: { sender: webContents, senderFrame: frame },
    options: {
      getMainWindow: () => window,
      developmentUrl: 'http://127.0.0.1:5173',
      productionFileUrl: 'file:///app/renderer/index.html'
    }
  }
}

describe('IPC 调用来源验证', () => {
  it('接受当前窗口主 frame 的开发 origin', () => {
    const fixture = createFixture()
    expect(() => assertTrustedIpcSender(fixture.event, fixture.options)).not.toThrow()
  })

  it.each([
    'missing-window',
    'destroyed-window',
    'destroyed-web-contents',
    'destroyed-frame',
    'missing-frame',
    'wrong-sender',
    'child-frame',
    'wrong-url'
  ])('拒绝非法来源：%s', (scenario) => {
    const fixture = createFixture()
    if (scenario === 'missing-window') fixture.options.getMainWindow = () => null
    if (scenario === 'destroyed-window') {
      fixture.window.isDestroyed = vi.fn(() => true)
    }
    if (scenario === 'destroyed-web-contents') {
      fixture.webContents.isDestroyed = vi.fn(() => true)
    }
    if (scenario === 'destroyed-frame') {
      fixture.frame.isDestroyed = vi.fn(() => true)
    }
    if (scenario === 'missing-frame') {
      fixture.event = { ...fixture.event, senderFrame: null }
    }
    if (scenario === 'wrong-sender') {
      fixture.event = {
        ...fixture.event,
        sender: { ...fixture.webContents }
      }
    }
    if (scenario === 'child-frame') {
      fixture.event = {
        ...fixture.event,
        senderFrame: { ...fixture.frame }
      }
    }
    if (scenario === 'wrong-url') {
      Object.defineProperty(fixture.frame, 'url', { value: 'https://example.com' })
    }

    expect(() => assertTrustedIpcSender(fixture.event, fixture.options)).toThrow(
      new DesktopIpcFailure('forbidden', '拒绝此 IPC 调用。')
    )
  })

  it('生产环境只接受规范化后的精确 file URL', () => {
    const fixture = createFixture('file:///app/renderer/index.html')
    delete fixture.options.developmentUrl

    expect(() => assertTrustedIpcSender(fixture.event, fixture.options)).not.toThrow()

    Object.defineProperty(fixture.frame, 'url', {
      value: 'file:///app/renderer/index.html?unexpected=1'
    })
    expect(() => assertTrustedIpcSender(fixture.event, fixture.options)).toThrow(DesktopIpcFailure)
  })
})

describe('可信 Renderer 推送', () => {
  it('只向仍可信的主 frame 发送 payload', () => {
    const fixture = createFixture()

    expect(sendToTrustedRenderer(fixture.options, 'agent:status', { state: 'ready' })).toBe(true)
    expect(fixture.frame.send).toHaveBeenCalledWith('agent:status', { state: 'ready' })
  })

  it('页面导航后停止推送', () => {
    const fixture = createFixture()
    Object.defineProperty(fixture.frame, 'url', { value: 'https://example.com' })

    expect(sendToTrustedRenderer(fixture.options, 'agent:event', { kind: 'error' })).toBe(false)
    expect(fixture.frame.send).not.toHaveBeenCalled()
  })
})

describe('IPC 错误清洗', () => {
  it('移除 Secret、URL、内部路径、控制字符和堆栈', () => {
    const error = new Error(
      'Bearer fake-secret 请求 https://internal.example/v1 读取 /Users/test/private/config.json 失败\n详情'
    )
    error.stack = 'internal stack'

    const result = toDesktopIpcError(error, (value) =>
      value instanceof Error ? value.message.replace('fake-secret', '[REDACTED]') : String(value)
    )

    expect(result.code).toBe('operation-failed')
    expect(result.message).not.toContain('fake-secret')
    expect(result.message).not.toContain('internal.example')
    expect(result.message).not.toContain('/Users/test')
    expect(result.message).not.toContain('\n')
    expect(result.message).not.toContain('stack')
  })

  it('UTF-8 截断不会切坏 emoji', () => {
    expect(truncateUtf8('你😀好', 7)).toBe('你😀')
  })

  it('错误文案始终限制在 4 KiB UTF-8 内', () => {
    const result = toDesktopIpcError(new Error('😀'.repeat(2_000)), (error) =>
      error instanceof Error ? error.message : String(error)
    )

    expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    expect(result.message).not.toContain('�')
  })
})

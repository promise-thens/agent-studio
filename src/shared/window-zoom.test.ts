import { describe, expect, it } from 'vitest'
import {
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  nextZoomFactor,
  resolveWindowZoomAction
} from './window-zoom'

describe('窗口缩放步进', () => {
  it('放大缩小按 10% 走，并夹在 50%–200%', () => {
    expect(nextZoomFactor(1, 'in')).toBe(1.1)
    expect(nextZoomFactor(1.1, 'in')).toBe(1.2)
    expect(nextZoomFactor(1, 'out')).toBe(0.9)
    expect(nextZoomFactor(1, 'reset')).toBe(1)
    expect(nextZoomFactor(MAX_ZOOM_FACTOR, 'in')).toBe(MAX_ZOOM_FACTOR)
    expect(nextZoomFactor(MIN_ZOOM_FACTOR, 'out')).toBe(MIN_ZOOM_FACTOR)
    expect(nextZoomFactor(1.19, 'in')).toBe(1.3)
  })
})

describe('窗口缩放快捷键', () => {
  it('macOS 用 Command，= 和 + 都放大，- 缩小，0 复位', () => {
    expect(
      resolveWindowZoomAction({
        platform: 'darwin',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        key: '='
      })
    ).toBe('in')
    expect(
      resolveWindowZoomAction({
        platform: 'darwin',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        key: '+'
      })
    ).toBe('in')
    expect(
      resolveWindowZoomAction({
        platform: 'darwin',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        key: '-'
      })
    ).toBe('out')
    expect(
      resolveWindowZoomAction({
        platform: 'darwin',
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        key: '0'
      })
    ).toBe('reset')
  })

  it('Windows / Linux 用 Control，macOS 的 Control 或 Option 不触发', () => {
    expect(
      resolveWindowZoomAction({
        platform: 'win32',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        key: '='
      })
    ).toBe('in')
    expect(
      resolveWindowZoomAction({
        platform: 'linux',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        key: '-'
      })
    ).toBe('out')
    expect(
      resolveWindowZoomAction({
        platform: 'darwin',
        metaKey: false,
        ctrlKey: true,
        altKey: false,
        key: '='
      })
    ).toBeNull()
    expect(
      resolveWindowZoomAction({
        platform: 'darwin',
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        key: '='
      })
    ).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { alignScreenshotPngToViewportCss, readPngPixelSize } from './host-browser-screenshot'

describe('PNG IHDR 对齐', () => {
  it('按 PNG IHDR 判断像素，不信任 NativeImage.getSize 的 DIP', () => {
    const retinaPng = pngIhdr(1600, 1200)
    const alignedPng = pngIhdr(800, 600)
    expect(readPngPixelSize(retinaPng)).toEqual({ width: 1600, height: 1200 })
    expect(readPngPixelSize(alignedPng)).toEqual({ width: 800, height: 600 })
    expect(readPngPixelSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()

    const resized: Array<{ width: number; height: number }> = []
    const out = alignScreenshotPngToViewportCss(
      retinaPng,
      { width: 800, height: 600 },
      (_png, size) => {
        resized.push(size)
        return alignedPng
      }
    )
    expect(resized).toEqual([{ width: 800, height: 600 }])
    expect(out).toBe(alignedPng)

    const skipped = alignScreenshotPngToViewportCss(alignedPng, { width: 800, height: 600 }, () => {
      throw new Error('已对齐不得再缩放')
    })
    expect(skipped).toBe(alignedPng)
  })
})

/** 只写签名和 IHDR 宽高，足够测像素读取，不需要完整 CRC。 */
function pngIhdr(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

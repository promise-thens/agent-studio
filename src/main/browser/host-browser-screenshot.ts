import { HOST_BROWSER_MAX_BOUND, screenshotImageNeedsCssResize } from '../../shared/host-browser'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 读 PNG IHDR 像素。只允许在主进程调用：Renderer 没有 Buffer。
 * Retina 上 NativeImage.getSize() 常是 DIP，和 toPNG 实际像素不一致。
 */
export function readPngPixelSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.byteLength < 24) return undefined
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return undefined
  if (width < 1 || height < 1) return undefined
  if (width > HOST_BROWSER_MAX_BOUND || height > HOST_BROWSER_MAX_BOUND) return undefined
  return { width, height }
}

/**
 * 截图必须和 click_xy 同一套 CSS 像素。只看 PNG 头，不看 NativeImage.getSize。
 */
export function alignScreenshotPngToViewportCss(
  png: Buffer,
  viewport: { width: number; height: number } | undefined,
  resizePng: (png: Buffer, size: { width: number; height: number }) => Buffer
): Buffer {
  if (!viewport) return png
  const pixels = readPngPixelSize(png)
  if (!pixels || !screenshotImageNeedsCssResize(pixels, viewport)) return png
  return resizePng(png, viewport)
}

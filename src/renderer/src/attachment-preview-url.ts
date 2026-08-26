const PREVIEW_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** 缩略图使用 CSP 已允许的 data URL；拒绝未知 MIME 和非规范 base64。 */
export function createAttachmentPreviewUrl(base64: string, mimeType: string): string | null {
  if (!PREVIEW_IMAGE_MIMES.has(mimeType) || !base64 || !BASE64_RE.test(base64)) return null
  return `data:${mimeType};base64,${base64}`
}

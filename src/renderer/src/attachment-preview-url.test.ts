import { describe, expect, it } from 'vitest'
import { createAttachmentPreviewUrl } from './attachment-preview-url'

describe('createAttachmentPreviewUrl', () => {
  it('生成 CSP 已允许的图片 data URL', () => {
    expect(createAttachmentPreviewUrl('dGh1bWI=', 'image/jpeg')).toBe(
      'data:image/jpeg;base64,dGh1bWI='
    )
  })

  it('拒绝未知 MIME 和非规范 base64', () => {
    expect(createAttachmentPreviewUrl('dGh1bWI=', 'text/html')).toBeNull()
    expect(createAttachmentPreviewUrl('not base64', 'image/png')).toBeNull()
  })
})

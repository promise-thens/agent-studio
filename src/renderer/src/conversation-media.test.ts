import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'components/ConversationMedia.vue'),
  'utf8'
)

describe('对话媒体', () => {
  it('助手图片可点开灯箱并提供下载', () => {
    expect(source).toContain('getAttachmentImage')
    expect(source).toContain('attachment-image-backdrop')
    expect(source).toContain('下载图片')
    expect(source).toContain('link.download')
  })
})

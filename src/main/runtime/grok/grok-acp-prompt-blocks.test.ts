import { describe, expect, it } from 'vitest'
import { buildGrokPromptContentBlocks } from './grok-acp-prompt-blocks'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('buildGrokPromptContentBlocks', () => {
  it('无附件时只发文本块', () => {
    expect(
      buildGrokPromptContentBlocks({
        prompt: '  改登录  ',
        attachments: [],
        promptImage: false,
        embeddedContext: true
      })
    ).toEqual([{ type: 'text', text: '改登录' }])
  })

  it('空正文有附件时使用占位文本，图片在未声明识图时走 Resource blob', () => {
    const blocks = buildGrokPromptContentBlocks({
      prompt: '   ',
      attachments: [
        { fileName: 'shot.png', mimeType: 'image/png', kind: 'image', bytes: PNG }
      ],
      promptImage: false,
      embeddedContext: true
    })
    expect(blocks[0]).toEqual({ type: 'text', text: '请查看附件。' })
    expect(blocks[1]).toMatchObject({
      type: 'resource',
      resource: {
        uri: 'attachment://shot.png',
        mimeType: 'image/png',
        blob: PNG.toString('base64')
      }
    })
  })

  it('声明识图时图片走 Image 块，文本附件走 Resource text', () => {
    const blocks = buildGrokPromptContentBlocks({
      prompt: '看看这两个',
      attachments: [
        { fileName: 'shot.png', mimeType: 'image/png', kind: 'image', bytes: PNG },
        { fileName: 'note.md', mimeType: 'text/markdown', kind: 'text', bytes: Buffer.from('# hi') }
      ],
      promptImage: true,
      embeddedContext: true
    })
    expect(blocks).toEqual([
      { type: 'text', text: '看看这两个' },
      { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') },
      {
        type: 'resource',
        resource: {
          uri: 'attachment://note.md',
          mimeType: 'text/markdown',
          text: '# hi'
        }
      }
    ])
  })
})

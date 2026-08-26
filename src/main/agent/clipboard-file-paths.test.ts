import { describe, expect, it } from 'vitest'
import { parseClipboardFilePaths } from './clipboard-file-paths'

describe('parseClipboardFilePaths', () => {
  it('解析 Finder XML plist 并解码安全实体', () => {
    expect(
      parseClipboardFilePaths(
        '<plist><array><string>/tmp/a&amp;b.png</string><string>/tmp/report.pdf</string></array></plist>'
      )
    ).toEqual(['/tmp/a&b.png', '/tmp/report.pdf'])
  })

  it('兼容 OpenStep 引号列表与普通 NUL 文本', () => {
    expect(parseClipboardFilePaths('(\n"/tmp/a.png",\n"/tmp/b.pdf"\n)')).toEqual([
      '/tmp/a.png',
      '/tmp/b.pdf'
    ])
    expect(parseClipboardFilePaths('/tmp/a.png\0/tmp/b.pdf')).toEqual([
      '/tmp/a.png',
      '/tmp/b.pdf'
    ])
  })
})

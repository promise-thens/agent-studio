import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_LIMITS,
  classifyTaskAttachmentBytes,
  isImageAttachmentPath,
  sanitizeAttachmentFileName
} from './task-attachment'

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3)
const GIF = utf8('GIF89a')
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 1, 2, 3)
const PDF = utf8('%PDF-1.4\n% demo')

describe('classifyTaskAttachmentBytes', () => {
  it('按魔数和扩展名识别 PNG / JPEG / WebP / GIF / PDF / 文本', () => {
    expect(classifyTaskAttachmentBytes({ originalName: 'a.PNG', bytes: PNG })).toEqual({
      ok: true,
      kind: 'image',
      mimeType: 'image/png',
      originalName: 'a.PNG'
    })
    expect(classifyTaskAttachmentBytes({ originalName: 'shot.jpg', bytes: JPEG })).toMatchObject({
      ok: true,
      kind: 'image',
      mimeType: 'image/jpeg'
    })
    expect(classifyTaskAttachmentBytes({ originalName: 'x.webp', bytes: WEBP })).toMatchObject({
      ok: true,
      mimeType: 'image/webp'
    })
    expect(classifyTaskAttachmentBytes({ originalName: 'x.gif', bytes: GIF })).toMatchObject({
      ok: true,
      mimeType: 'image/gif'
    })
    expect(classifyTaskAttachmentBytes({ originalName: 'doc.pdf', bytes: PDF })).toEqual({
      ok: true,
      kind: 'pdf',
      mimeType: 'application/pdf',
      originalName: 'doc.pdf'
    })
    expect(classifyTaskAttachmentBytes({ originalName: 'note.md', bytes: utf8('# hi') })).toEqual({
      ok: true,
      kind: 'text',
      mimeType: 'text/markdown',
      originalName: 'note.md'
    })
    expect(
      classifyTaskAttachmentBytes({ originalName: 'a.json', bytes: utf8('{}') })
    ).toMatchObject({
      ok: true,
      mimeType: 'application/json'
    })
  })

  it('拒绝空文件、超限、扩展名与魔数冲突、SVG 伪装、密钥类和二进制文本', () => {
    expect(classifyTaskAttachmentBytes({ originalName: 'a.png', bytes: bytes() })).toEqual({
      ok: false,
      reason: 'empty'
    })
    const huge = new Uint8Array(ATTACHMENT_LIMITS.maxBytesPerFile + 1)
    huge.set(PNG.subarray(0, 8))
    expect(classifyTaskAttachmentBytes({ originalName: 'a.png', bytes: huge })).toEqual({
      ok: false,
      reason: 'too-large'
    })
    expect(classifyTaskAttachmentBytes({ originalName: 'a.png', bytes: JPEG })).toEqual({
      ok: false,
      reason: 'mime-mismatch'
    })
    expect(
      classifyTaskAttachmentBytes({ originalName: 'icon.svg', bytes: utf8('<svg></svg>') })
    ).toEqual({
      ok: false,
      reason: 'unsupported-type'
    })
    expect(
      classifyTaskAttachmentBytes({ originalName: 'icon.png', bytes: utf8('<svg></svg>') })
    ).toEqual({ ok: false, reason: 'mime-mismatch' })
    expect(classifyTaskAttachmentBytes({ originalName: '.env', bytes: utf8('A=1') })).toEqual({
      ok: false,
      reason: 'unsupported-type'
    })
    expect(classifyTaskAttachmentBytes({ originalName: 'secret.pem', bytes: utf8('x') })).toEqual({
      ok: false,
      reason: 'unsupported-type'
    })
    expect(
      classifyTaskAttachmentBytes({ originalName: 'a.txt', bytes: bytes(0x61, 0x00, 0x62) })
    ).toEqual({ ok: false, reason: 'nul' })
    expect(
      classifyTaskAttachmentBytes({ originalName: 'a.txt', bytes: bytes(0xff, 0xfe, 0xfd) })
    ).toEqual({ ok: false, reason: 'binary-text' })
  })
})

describe('sanitizeAttachmentFileName', () => {
  it('去掉路径和空字节，保留可展示的基名', () => {
    expect(sanitizeAttachmentFileName('../../a/b.png')).toBe('b.png')
    expect(sanitizeAttachmentFileName('a\0b.txt')).toBe('ab.txt')
    expect(sanitizeAttachmentFileName('')).toBe('attachment')
  })
})

describe('isImageAttachmentPath', () => {
  it('只认白名单图片扩展名，忽略大小写', () => {
    expect(isImageAttachmentPath('src/shot.PNG')).toBe(true)
    expect(isImageAttachmentPath('out/diagram.pdf')).toBe(false)
    expect(isImageAttachmentPath('a.svg')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_LIMITS,
  classifyArtifactBytes,
  parseArtifactContent,
  parseArtifactDescriptor,
  sanitizeArtifactMarkdown,
  sanitizeArtifactRelativePath
} from './artifact'

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

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactId: 'art-1',
    projectId: 'project-1',
    taskId: 'task-1',
    turnId: 'turn-1',
    kind: 'markdown',
    title: 'README.md',
    mimeType: 'text/markdown',
    source: 'git-review',
    environmentId: 'local:abc',
    location: { kind: 'file', relativePath: 'docs/README.md' },
    size: 12,
    contentHash: 'abc',
    createdAt: '2026-08-28T00:00:00.000Z',
    trustLevel: 'verified',
    availability: 'ready',
    revision: 1,
    ...overrides
  }
}

describe('parseArtifactDescriptor', () => {
  it('接受不含绝对路径的完整描述符，并丢掉 path/filePath', () => {
    expect(parseArtifactDescriptor(descriptor())).toMatchObject({
      artifactId: 'art-1',
      kind: 'markdown',
      location: { kind: 'file', relativePath: 'docs/README.md' }
    })
    expect(parseArtifactDescriptor({ ...descriptor(), path: '/etc/passwd' })).toBeNull()
    expect(parseArtifactDescriptor({ ...descriptor(), filePath: '/tmp/x' })).toBeNull()
    expect(
      parseArtifactDescriptor({
        ...descriptor(),
        location: { kind: 'file', relativePath: '/etc/passwd' }
      })
    ).toBeNull()
  })

  it('接受 Diff 引用，拒绝把路径和 diff 混在一起', () => {
    expect(
      parseArtifactDescriptor(
        descriptor({
          kind: 'diff',
          mimeType: 'text/x-diff',
          location: { kind: 'diff', path: 'src/app.ts' }
        })
      )
    ).toMatchObject({
      kind: 'diff',
      location: { kind: 'diff', path: 'src/app.ts' }
    })
    expect(
      parseArtifactDescriptor(
        descriptor({
          location: { kind: 'file', relativePath: 'a.md', path: 'src/app.ts' }
        })
      )
    ).toBeNull()
  })
})

describe('sanitizeArtifactRelativePath', () => {
  it('只保留 posix 相对路径，拒绝越界与绝对路径', () => {
    expect(sanitizeArtifactRelativePath('docs/README.md')).toBe('docs/README.md')
    expect(sanitizeArtifactRelativePath('docs\\README.md')).toBeNull()
    expect(sanitizeArtifactRelativePath('../secret')).toBeNull()
    expect(sanitizeArtifactRelativePath('/etc/passwd')).toBeNull()
    expect(sanitizeArtifactRelativePath('C:/Windows')).toBeNull()
    expect(sanitizeArtifactRelativePath('a\0b')).toBeNull()
  })
})

describe('classifyArtifactBytes', () => {
  it('按魔数和扩展名识别 PNG/JPEG/WebP/GIF、Markdown 和纯文本', () => {
    expect(classifyArtifactBytes({ relativePath: 'a.PNG', bytes: PNG })).toEqual({
      ok: true,
      kind: 'image',
      mimeType: 'image/png',
      title: 'a.PNG'
    })
    expect(classifyArtifactBytes({ relativePath: 'shot.jpg', bytes: JPEG })).toMatchObject({
      ok: true,
      kind: 'image',
      mimeType: 'image/jpeg'
    })
    expect(classifyArtifactBytes({ relativePath: 'x.webp', bytes: WEBP })).toMatchObject({
      ok: true,
      mimeType: 'image/webp'
    })
    expect(classifyArtifactBytes({ relativePath: 'x.gif', bytes: GIF })).toMatchObject({
      ok: true,
      mimeType: 'image/gif'
    })
    expect(classifyArtifactBytes({ relativePath: 'note.md', bytes: utf8('# hi') })).toEqual({
      ok: true,
      kind: 'markdown',
      mimeType: 'text/markdown',
      title: 'note.md'
    })
    expect(classifyArtifactBytes({ relativePath: 'log.txt', bytes: utf8('ok') })).toMatchObject({
      ok: true,
      kind: 'text',
      mimeType: 'text/plain'
    })
  })

  it('拒绝空文件、超限、扩展名与魔数冲突、SVG/HTML 伪装', () => {
    expect(classifyArtifactBytes({ relativePath: 'a.png', bytes: bytes() })).toEqual({
      ok: false,
      reason: 'empty'
    })
    const huge = new Uint8Array(ARTIFACT_LIMITS.maxBytesPerFile + 1)
    huge.set(PNG.subarray(0, 8))
    expect(classifyArtifactBytes({ relativePath: 'a.png', bytes: huge })).toEqual({
      ok: false,
      reason: 'too-large'
    })
    expect(classifyArtifactBytes({ relativePath: 'a.png', bytes: JPEG })).toEqual({
      ok: false,
      reason: 'mime-mismatch'
    })
    expect(classifyArtifactBytes({ relativePath: 'icon.svg', bytes: utf8('<svg></svg>') })).toEqual(
      { ok: false, reason: 'unsupported-type' }
    )
    expect(
      classifyArtifactBytes({ relativePath: 'page.html', bytes: utf8('<script>alert(1)</script>') })
    ).toEqual({ ok: false, reason: 'unsupported-type' })
  })
})

describe('parseArtifactContent', () => {
  it('丢掉混入的 path/filePath，只保留有限内容', () => {
    const base = {
      kind: 'markdown',
      markdown: '# hi',
      descriptor: descriptor()
    }
    expect(parseArtifactContent(base)).toMatchObject({ kind: 'markdown', markdown: '# hi' })
    expect(parseArtifactContent({ ...base, filePath: '/tmp/x' })).toBeNull()
  })
})

describe('sanitizeArtifactMarkdown', () => {
  it('去掉原始 HTML、脚本和危险链接，保留普通 Markdown', () => {
    const sanitized = sanitizeArtifactMarkdown(
      [
        '# 标题',
        '<script>alert(1)</script>',
        '点击 [x](javascript:alert(1)) 和 [安全](https://example.com)。',
        '<img src=x onerror=alert(1)>',
        '普通段落。'
      ].join('\n')
    )
    expect(sanitized).toContain('# 标题')
    expect(sanitized).toContain('普通段落。')
    expect(sanitized).toContain('[安全](https://example.com/)')
    expect(sanitized).not.toContain('<script')
    expect(sanitized).not.toContain('javascript:')
    expect(sanitized).not.toContain('onerror')
    expect(sanitized).not.toContain('<img')
  })
})

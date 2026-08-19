import { describe, expect, it } from 'vitest'
import { sanitizeExternalHref } from './external-href'

describe('sanitizeExternalHref', () => {
  it('只放行 http 与 https，并去掉账号密码', () => {
    expect(sanitizeExternalHref('https://docs.x.ai/grok/faq')).toBe('https://docs.x.ai/grok/faq')
    expect(sanitizeExternalHref('http://example.com/path')).toBe('http://example.com/path')
    expect(sanitizeExternalHref('https://user:secret@evil.example/')).toBeNull()
  })

  it('拒绝 javascript、data、file 和相对路径', () => {
    expect(sanitizeExternalHref('javascript:alert(1)')).toBeNull()
    expect(sanitizeExternalHref('data:text/html,hi')).toBeNull()
    expect(sanitizeExternalHref('file:///etc/passwd')).toBeNull()
    expect(sanitizeExternalHref('/local/path')).toBeNull()
    expect(sanitizeExternalHref('')).toBeNull()
  })
})

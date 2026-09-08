import { describe, expect, it } from 'vitest'
import { parseBrowserOrigin } from './browser-origin'

describe('parseBrowserOrigin', () => {
  it('http(s) URL 投影为 origin，userinfo 与残缺值返回 null', () => {
    expect(parseBrowserOrigin('https://example.com/path?q=1')).toBe('https://example.com')
    expect(parseBrowserOrigin('http://localhost:5173/')).toBe('http://localhost:5173')
    expect(parseBrowserOrigin('https://user:pass@example.com/')).toBeNull()
    expect(parseBrowserOrigin('file:///tmp/x')).toBeNull()
    expect(parseBrowserOrigin('not-a-url')).toBeNull()
  })
})

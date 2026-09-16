import { describe, expect, it } from 'vitest'
import {
  HOST_BROWSER_MAX_URL_CHARS,
  parseHostBrowserBounds,
  parseHostBrowserChrome,
  parseHostBrowserNavigateUrl
} from './host-browser'

describe('parseHostBrowserNavigateUrl', () => {
  it('只接受 http(s)，并去掉 userinfo / 非网页协议', () => {
    expect(parseHostBrowserNavigateUrl('https://example.com/path?q=1')).toBe(
      'https://example.com/path?q=1'
    )
    expect(parseHostBrowserNavigateUrl('http://localhost:5173/')).toBe('http://localhost:5173/')
    expect(parseHostBrowserNavigateUrl('  https://example.com  ')).toBe('https://example.com/')
    expect(parseHostBrowserNavigateUrl('javascript:alert(1)')).toBeNull()
    expect(parseHostBrowserNavigateUrl('file:///tmp/x')).toBeNull()
    expect(parseHostBrowserNavigateUrl('data:text/html,hi')).toBeNull()
    expect(parseHostBrowserNavigateUrl('about:blank')).toBeNull()
    expect(parseHostBrowserNavigateUrl('https://user:pass@example.com/')).toBeNull()
    expect(parseHostBrowserNavigateUrl('not-a-url')).toBeNull()
    expect(parseHostBrowserNavigateUrl('')).toBeNull()
    expect(
      parseHostBrowserNavigateUrl(`https://example.com/${'a'.repeat(HOST_BROWSER_MAX_URL_CHARS)}`)
    ).toBeNull()
  })
})

describe('parseHostBrowserChrome', () => {
  it('只保留可展示字段，拒绝多余键带来的污染', () => {
    expect(
      parseHostBrowserChrome({
        url: 'https://example.com/docs',
        title: 'Example',
        isLoading: true,
        open: true,
        cookie: 'secret'
      })
    ).toEqual({
      url: 'https://example.com/docs',
      title: 'Example',
      isLoading: true,
      open: true
    })
    expect(
      parseHostBrowserChrome({ url: 'about:blank', title: '', isLoading: false, open: false })
    ).toEqual({
      url: 'about:blank',
      title: '',
      isLoading: false,
      open: false
    })
    expect(parseHostBrowserChrome({ url: '', title: '', isLoading: false, open: false })).toEqual({
      url: '',
      title: '',
      isLoading: false,
      open: false
    })
    expect(
      parseHostBrowserChrome({
        url: 'javascript:alert(1)',
        title: '',
        isLoading: false,
        open: true
      })
    ).toBeNull()
    expect(parseHostBrowserChrome(null)).toBeNull()
  })
})

describe('parseHostBrowserBounds', () => {
  it('只接受窗口内的有限整数矩形', () => {
    expect(parseHostBrowserBounds({ x: 10, y: 20, width: 800, height: 600 })).toEqual({
      x: 10,
      y: 20,
      width: 800,
      height: 600
    })
    expect(parseHostBrowserBounds({ x: 10.5, y: 20, width: 800, height: 600 })).toBeNull()
    expect(parseHostBrowserBounds({ x: -1, y: 0, width: 800, height: 600 })).toBeNull()
    expect(parseHostBrowserBounds({ x: 0, y: 0, width: 0, height: 600 })).toBeNull()
    expect(parseHostBrowserBounds({ x: 0, y: 0, width: 800, height: 1_000_001 })).toBeNull()
  })
})

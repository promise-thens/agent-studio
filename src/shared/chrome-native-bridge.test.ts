import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_PUBLIC_KEY,
  CHROME_NATIVE_COMMANDS,
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_MAX_COOKIE_VALUE_CHARS,
  CHROME_NATIVE_MAX_COOKIES,
  CHROME_NATIVE_MAX_FRAME_BYTES,
  cookieMatchesBlacklist,
  createChromeNativeLogRecord,
  parseChromeNativeCookiesSyncPayload,
  parseChromeNativeFrameLength,
  parseChromeNativeRequest,
  parseChromeNativeTabsOpenUrl,
  parseChromeNativeTabsSnapshotPayload,
  synthesizeChromeNativeCookieUrl,
  type ChromeNativeCookie
} from './chrome-native-bridge'

function le32(length: number): Uint8Array {
  return Uint8Array.from([
    length & 0xff,
    (length >>> 8) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 24) & 0xff
  ])
}

function fakeCookie(overrides: Partial<ChromeNativeCookie> = {}): ChromeNativeCookie {
  return {
    name: 'sid',
    value: 'cookie-value-test',
    domain: 'example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    ...overrides
  }
}

describe('Chrome Native 常量与扩展身份', () => {
  it('host 名固定，扩展 id 由提交的公钥算出，不是占位符', () => {
    expect(CHROME_NATIVE_HOST_NAME).toBe('com.agentstudio.browser')
    expect(CHROME_NATIVE_COMMANDS).toEqual(['ping', 'cookies.sync', 'tabs.snapshot', 'tabs.open'])
    expect(CHROME_EXTENSION_ID).toMatch(/^[a-p]{32}$/)
    expect(CHROME_EXTENSION_ID).not.toContain('12345')
    const digest = createHash('sha256')
      .update(Buffer.from(CHROME_EXTENSION_PUBLIC_KEY, 'base64'))
      .digest('hex')
      .slice(0, 32)
    const computed = [...digest]
      .map((char) => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16)))
      .join('')
    expect(CHROME_EXTENSION_ID).toBe(computed)
  })
})

describe('parseChromeNativeFrameLength', () => {
  it('超长帧拒绝，合法上限仍收下', () => {
    expect(parseChromeNativeFrameLength(new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      code: 'incomplete'
    })
    expect(parseChromeNativeFrameLength(le32(CHROME_NATIVE_MAX_FRAME_BYTES))).toEqual({
      ok: true,
      length: CHROME_NATIVE_MAX_FRAME_BYTES
    })
    expect(parseChromeNativeFrameLength(le32(CHROME_NATIVE_MAX_FRAME_BYTES + 1))).toEqual({
      ok: false,
      code: 'frame-too-large'
    })
  })
})

describe('parseChromeNativeRequest', () => {
  it('未知 command 返回错误对象，不把 payload 当 shell', () => {
    const parsed = parseChromeNativeRequest({
      id: 'req-1',
      command: 'bash',
      payload: { cmd: 'rm -rf /', value: 'cookie-value-test' }
    })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.id).toBe('req-1')
    expect(parsed.error.code).toBe('unknown-command')
    expect(JSON.stringify(parsed)).not.toContain('rm -rf')
    expect(JSON.stringify(parsed)).not.toContain('cookie-value-test')
  })

  it('id / command 超长拒绝', () => {
    expect(parseChromeNativeRequest({ id: 'a'.repeat(129), command: 'ping' }).ok).toBe(false)
    expect(parseChromeNativeRequest({ id: 'ok', command: 'ping'.repeat(40) }).ok).toBe(false)
  })

  it('白名单命令可以解析', () => {
    expect(parseChromeNativeRequest({ id: 'p1', command: 'ping' })).toEqual({
      ok: true,
      request: { id: 'p1', command: 'ping' }
    })
    expect(
      parseChromeNativeRequest({
        id: 's1',
        command: 'tabs.snapshot',
        payload: { nodes: [{ x: 1 }] }
      })
    ).toMatchObject({
      ok: true,
      request: { id: 's1', command: 'tabs.snapshot' }
    })
  })
})

describe('cookies.sync payload', () => {
  it('数组超过 500 或单值超过 4096 拒绝', () => {
    expect(
      parseChromeNativeCookiesSyncPayload({
        cookies: Array.from({ length: CHROME_NATIVE_MAX_COOKIES + 1 }, (_, index) =>
          fakeCookie({ name: `c${index}` })
        )
      })
    ).toBeNull()
    expect(
      parseChromeNativeCookiesSyncPayload({
        cookies: [fakeCookie({ value: 'x'.repeat(CHROME_NATIVE_MAX_COOKIE_VALUE_CHARS + 1) })]
      })
    ).toBeNull()
    expect(parseChromeNativeCookiesSyncPayload({ cookies: [fakeCookie()] })).toEqual({
      cookies: [fakeCookie()]
    })
  })

  it('合成 url；非法 domain 得不到 url', () => {
    expect(synthesizeChromeNativeCookieUrl(fakeCookie({ secure: true }))).toBe(
      'https://example.com/'
    )
    expect(
      synthesizeChromeNativeCookieUrl(
        fakeCookie({ secure: false, domain: '.shop.example.com', path: '/app' })
      )
    ).toBe('http://shop.example.com/app')
    expect(
      synthesizeChromeNativeCookieUrl(fakeCookie({ domain: 'https://evil.example' }))
    ).toBeNull()
    expect(synthesizeChromeNativeCookieUrl(fakeCookie({ domain: '../etc' }))).toBeNull()
    expect(synthesizeChromeNativeCookieUrl(fakeCookie({ domain: '' }))).toBeNull()
  })

  it('黑名单 origin 命中 domain cookie 与精确 host', () => {
    expect(
      cookieMatchesBlacklist(fakeCookie({ domain: 'mail.example.com' }), [
        'https://mail.example.com'
      ])
    ).toBe(true)
    expect(
      cookieMatchesBlacklist(fakeCookie({ domain: '.example.com' }), ['https://mail.example.com'])
    ).toBe(true)
    expect(
      cookieMatchesBlacklist(fakeCookie({ domain: 'shop.example.com' }), [
        'https://mail.example.com'
      ])
    ).toBe(false)
  })
})

describe('createChromeNativeLogRecord', () => {
  it('JSON.stringify(log) 夹具不含 cookie value', () => {
    const record = createChromeNativeLogRecord({
      command: 'cookies.sync',
      cookieCount: 2,
      origins: ['https://example.com']
    })
    const dumped = JSON.stringify(record)
    expect(dumped).toContain('cookies.sync')
    expect(dumped).toContain('https://example.com')
    expect(dumped).not.toContain('cookie-value-test')
    expect(dumped).not.toMatch(/"value"/)
    expect(record).not.toHaveProperty('value')
    expect(record).not.toHaveProperty('cookies')
  })
})

describe('tabs.open payload', () => {
  it('只收 http(s) 导航 URL', () => {
    expect(parseChromeNativeTabsOpenUrl({ url: 'https://example.com/app' })).toBe(
      'https://example.com/app'
    )
    expect(parseChromeNativeTabsOpenUrl({ url: 'file:///etc/passwd' })).toBeNull()
    expect(parseChromeNativeTabsOpenUrl({ url: 'javascript:alert(1)' })).toBeNull()
  })
})

describe('tabs.snapshot payload', () => {
  it('收下窗 DIP 与节点 CSS 盒；非法数字整包丢掉', () => {
    expect(
      parseChromeNativeTabsSnapshotPayload({
        windowScreenBounds: { x: 100, y: 80, width: 1200, height: 800 },
        dpr: 2,
        zoom: 1.25,
        nodes: [{ x: 40, y: 60, width: 12, height: 18 }]
      })
    ).toEqual({
      windowScreenBounds: { x: 100, y: 80, width: 1200, height: 800 },
      dpr: 2,
      zoom: 1.25,
      nodes: [{ x: 40, y: 60, width: 12, height: 18 }]
    })
    expect(parseChromeNativeTabsSnapshotPayload({})).toEqual({})
    expect(
      parseChromeNativeTabsSnapshotPayload({
        windowScreenBounds: { x: '100', y: 80, width: 1, height: 1 }
      })
    ).toBeNull()
  })
})

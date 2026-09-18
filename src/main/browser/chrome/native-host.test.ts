import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOST_BROWSER_SETTINGS } from '../../../shared/host-browser'
import {
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_PUBLIC_KEY,
  CHROME_NATIVE_HOST_NAME,
  CHROME_NATIVE_MAX_FRAME_BYTES,
  type ChromeNativeCookie
} from '../../../shared/chrome-native-bridge'
import {
  applyChromeNativeCookiesSync,
  buildChromeNativeHostManifest,
  computeChromeExtensionId,
  handleChromeNativeRequest,
  installChromeNativeHostManifest,
  resolveChromeNativeHostScriptPath
} from './native-host'
import {
  encodeChromeNativeFrame,
  resolveChromeNativeHostBridge,
  runChromeNativeHostStdio
} from './native-host-stdio'
import { writeChromeNativeHostWrapper } from './companion-extension'

const here = dirname(fileURLToPath(import.meta.url))

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

async function readNativeFrame(stream: PassThrough): Promise<unknown> {
  const chunks: Buffer[] = []
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 Native Host 帧超时')), 2000)
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const buffer = Buffer.concat(chunks)
      if (buffer.length < 4) return
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length) return
      clearTimeout(timer)
      stream.off('data', onData)
      resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')))
    }
    stream.on('data', onData)
  })
}

describe('Chrome 扩展 id', () => {
  it('提交的公钥算出固定 id', () => {
    expect(computeChromeExtensionId(CHROME_EXTENSION_PUBLIC_KEY)).toBe(CHROME_EXTENSION_ID)
    expect(CHROME_EXTENSION_ID).toBe(
      [
        ...createHash('sha256')
          .update(Buffer.from(CHROME_EXTENSION_PUBLIC_KEY, 'base64'))
          .digest('hex')
          .slice(0, 32)
      ]
        .map((char) => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16)))
        .join('')
    )
  })
})

describe('Native Messaging 清单', () => {
  it('只允许本扩展 origin，path 是传入的 host 命令', () => {
    const manifest = buildChromeNativeHostManifest('/tmp/chrome-native-host-stdio.js')
    expect(manifest).toEqual({
      name: CHROME_NATIVE_HOST_NAME,
      description: 'Agent Studio Browser Native Host',
      path: '/tmp/chrome-native-host-stdio.js',
      type: 'stdio',
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`]
    })
    expect(JSON.stringify(manifest)).not.toContain('*')
    expect(JSON.stringify(manifest)).not.toContain('chrome-extension://*/')
  })

  it('安装只写临时 homeDir 的 NativeMessagingHosts，不碰开发者真 Chrome', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'as-chrome-native-'))
    const execPath = join(homeDir, 'chrome-native-host-stdio.js')
    const written = await installChromeNativeHostManifest({ homeDir, execPath })
    expect(written).toBe(
      join(
        homeDir,
        'Library/Application Support/Google/Chrome/NativeMessagingHosts',
        `${CHROME_NATIVE_HOST_NAME}.json`
      )
    )
    expect(written.startsWith(homeDir)).toBe(true)
    expect(written).not.toBe(
      join(
        homedir(),
        'Library/Application Support/Google/Chrome/NativeMessagingHosts',
        `${CHROME_NATIVE_HOST_NAME}.json`
      )
    )
    const manifest = JSON.parse(await readFile(written, 'utf8')) as {
      path: string
      allowed_origins: string[]
    }
    expect(manifest.path).toBe(execPath)
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}/`])
  })
})

describe('handleChromeNativeRequest', () => {
  it('未知 command 返回错误对象且不写 Cookie、不 exec', async () => {
    const setCookie = vi.fn(async () => undefined)
    const response = await handleChromeNativeRequest({
      request: {
        id: 'x1',
        command: 'shell',
        payload: { cmd: '/bin/bash', value: 'cookie-value-test' }
      },
      settings: DEFAULT_HOST_BROWSER_SETTINGS,
      projectId: 'proj-1',
      setCookie
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('unknown-command')
    expect(setCookie).not.toHaveBeenCalled()
    expect(JSON.stringify(response)).not.toContain('cookie-value-test')
    expect(JSON.stringify(response)).not.toContain('/bin/bash')
  })

  it('ping 与 tabs.snapshot 收下；无窗 DIP 不回调光标', async () => {
    const setCookie = vi.fn(async () => undefined)
    const ping = await handleChromeNativeRequest({
      request: { id: 'p1', command: 'ping' },
      settings: DEFAULT_HOST_BROWSER_SETTINGS,
      projectId: 'proj-1',
      setCookie
    })
    expect(ping).toEqual({ id: 'p1', ok: true, result: { pong: true } })
    const snapshot = await handleChromeNativeRequest({
      request: { id: 's1', command: 'tabs.snapshot', payload: { nodes: [{ x: 8 }] } },
      settings: DEFAULT_HOST_BROWSER_SETTINGS,
      projectId: 'proj-1',
      setCookie
    })
    expect(snapshot).toEqual({ id: 's1', ok: true, result: { accepted: true } })
    expect(setCookie).not.toHaveBeenCalled()
    const onTabsSnapshot = vi.fn()
    await handleChromeNativeRequest({
      request: { id: 's2', command: 'tabs.snapshot', payload: { nodes: [{ x: 8, y: 2 }] } },
      settings: DEFAULT_HOST_BROWSER_SETTINGS,
      projectId: 'proj-1',
      setCookie,
      onTabsSnapshot
    })
    expect(onTabsSnapshot).toHaveBeenCalledWith({ nodes: [{ x: 8, y: 2 }] })
  })

  it('cookieSyncEnabled 为 false 时忽略 sync', async () => {
    const setCookie = vi.fn(async () => undefined)
    const response = await handleChromeNativeRequest({
      request: {
        id: 'c0',
        command: 'cookies.sync',
        payload: { cookies: [fakeCookie()] }
      },
      settings: { ...DEFAULT_HOST_BROWSER_SETTINGS, cookieSyncEnabled: false },
      projectId: 'proj-1',
      setCookie
    })
    expect(response.ok).toBe(true)
    expect(response.result).toMatchObject({ ignored: true, applied: 0 })
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('没有 project 时拒绝写入', async () => {
    const setCookie = vi.fn(async () => undefined)
    const response = await handleChromeNativeRequest({
      request: {
        id: 'c1',
        command: 'cookies.sync',
        payload: { cookies: [fakeCookie()] }
      },
      settings: DEFAULT_HOST_BROWSER_SETTINGS,
      projectId: null,
      setCookie
    })
    expect(response.ok).toBe(false)
    expect(response.error?.code).toBe('no-project')
    expect(setCookie).not.toHaveBeenCalled()
  })
})

describe('applyChromeNativeCookiesSync', () => {
  it('黑名单 origin 跳过，其它写入当前 partition', async () => {
    const setCookie = vi.fn(async () => undefined)
    const logs: unknown[] = []
    const result = await applyChromeNativeCookiesSync({
      cookies: [
        fakeCookie(),
        fakeCookie({ name: 'mail', domain: 'mail.example.com' }),
        fakeCookie({ name: 'bad', domain: 'https://evil.example' })
      ],
      settings: {
        cookieSyncEnabled: true,
        syncBlacklist: ['https://mail.example.com']
      },
      projectId: 'proj-1',
      setCookie,
      log: (record) => logs.push(record)
    })
    expect(result).toMatchObject({ ignored: false, applied: 1, skipped: 2 })
    expect(setCookie).toHaveBeenCalledTimes(1)
    expect(setCookie).toHaveBeenCalledWith(
      'persist:as-browser:proj-1',
      expect.objectContaining({
        url: 'https://example.com/',
        name: 'sid',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: true
      })
    )
    const dumped = JSON.stringify(logs)
    expect(dumped).toContain('cookies.sync')
    expect(dumped).not.toContain('cookie-value-test')
    expect(dumped).not.toMatch(/"value":/)
  })
})

describe('stdio 长度帧', () => {
  it('超长帧拒绝且不调用 handle', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const handle = vi.fn(async () => ({ ok: true }))
    const stop = runChromeNativeHostStdio({ stdin, stdout, handle })
    const header = Buffer.alloc(4)
    header.writeUInt32LE(CHROME_NATIVE_MAX_FRAME_BYTES + 1, 0)
    stdin.write(header)
    const frame = await readNativeFrame(stdout)
    stop()
    expect(handle).not.toHaveBeenCalled()
    expect(frame).toMatchObject({ ok: false, error: { code: 'frame-too-large' } })
    expect(JSON.stringify(frame)).not.toContain('cookie-value-test')
  })

  it('未知 command 回错误对象', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const handle = vi.fn(async (request) => {
      return handleChromeNativeRequest({
        request,
        settings: DEFAULT_HOST_BROWSER_SETTINGS,
        projectId: 'proj-1',
        setCookie: vi.fn(async () => undefined)
      })
    })
    const stop = runChromeNativeHostStdio({ stdin, stdout, handle })
    stdin.write(
      encodeChromeNativeFrame({
        id: 'u1',
        command: 'tabs.eval',
        payload: { code: 'alert(1)', value: 'cookie-value-test' }
      })
    )
    const frame = await readNativeFrame(stdout)
    stop()
    expect(frame).toMatchObject({ id: 'u1', ok: false, error: { code: 'unknown-command' } })
    expect(JSON.stringify(frame)).not.toContain('cookie-value-test')
  })
})

describe('v1 路径不读 Profile', () => {
  it('Native Host 源码不解析磁盘 Chrome Profile，也不走 capability 目录', async () => {
    const files = ['native-host.ts', 'native-host-stdio.ts']
    for (const file of files) {
      const source = await readFile(join(here, file), 'utf8')
      expect(source).not.toContain('Default/Cookies')
      expect(source).not.toContain('Login Data')
      expect(source).not.toContain('Web Data')
      expect(source).not.toContain('Network/Cookies')
      expect(source).not.toContain('src/main/capability')
      expect(source).not.toMatch(/Google\/Chrome\/(?!NativeMessagingHosts)/)
    }
    const shared = await readFile(join(here, '../../../shared/chrome-native-bridge.ts'), 'utf8')
    expect(shared).not.toContain('Default/Cookies')
    expect(shared).not.toContain('Login Data')
  })

  it('electron-vite / asarUnpack 增加 stdio 入口', async () => {
    const repoRoot = join(here, '../../../../')
    const vite = await readFile(join(repoRoot, 'electron.vite.config.ts'), 'utf8')
    const builder = await readFile(join(repoRoot, 'electron-builder.yml'), 'utf8')
    expect(vite).toContain(
      "'chrome-native-host-stdio': resolve('src/main/browser/chrome/native-host-stdio.ts')"
    )
    expect(builder).toContain('out/main/chrome-native-host-stdio.js')
    expect(builder).toContain('chrome-extension/agent-studio-browser')
    expect(resolveChromeNativeHostScriptPath('/tmp/out/main')).toContain(
      'chrome-native-host-stdio.js'
    )
  })

  it('packaged 优先 app.asar.unpacked，不因 asar 内 existsSync 为 true 就 exec 进归档', async () => {
    const root = await mkdtemp(join(tmpdir(), 'as-chrome-asar-'))
    const asarMain = join(root, 'Contents', 'Resources', 'app.asar', 'out', 'main')
    const unpackedMain = join(root, 'Contents', 'Resources', 'app.asar.unpacked', 'out', 'main')
    await mkdir(asarMain, { recursive: true })
    await mkdir(unpackedMain, { recursive: true })
    await writeFile(join(asarMain, 'chrome-native-host-stdio.js'), 'asar-stub\n', 'utf8')
    await writeFile(join(unpackedMain, 'chrome-native-host-stdio.js'), 'unpacked-stub\n', 'utf8')
    expect(resolveChromeNativeHostScriptPath(asarMain)).toBe(
      join(unpackedMain, 'chrome-native-host-stdio.js')
    )
    expect(resolveChromeNativeHostScriptPath(unpackedMain)).toBe(
      join(unpackedMain, 'chrome-native-host-stdio.js')
    )
    expect(resolveChromeNativeHostScriptPath(join(root, 'out', 'main'))).toBe(
      join(root, 'out', 'main', 'chrome-native-host-stdio.js')
    )
  })
})

describe('Native Host 身份钉死', () => {
  it('-dev json 能 parse 时，packaged wrapper 仍连当前身份，不连 -dev', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'as-chrome-identity-'))
    const devState = join(
      homeDir,
      'Library/Application Support/agent-studio-dev/browser/chrome-native-host.json'
    )
    const prodState = join(
      homeDir,
      'Library/Application Support/agent-studio/browser/chrome-native-host.json'
    )
    await mkdir(dirname(devState), { recursive: true })
    await mkdir(dirname(prodState), { recursive: true })
    const devSocket = join(homeDir, 'dev.sock')
    const prodSocket = join(homeDir, 'prod.sock')
    await writeFile(
      devState,
      `${JSON.stringify({ socketPath: devSocket, token: 'dev-token' })}\n`,
      'utf8'
    )
    await writeFile(
      prodState,
      `${JSON.stringify({ socketPath: prodSocket, token: 'prod-token' })}\n`,
      'utf8'
    )

    const wrapperPath = await writeChromeNativeHostWrapper({
      wrapperPath: join(homeDir, 'browser', 'chrome-native-host-stdio'),
      electronExecPath: join(homeDir, 'Agent Studio.app/Contents/MacOS/Agent Studio'),
      scriptPath: join(homeDir, 'chrome-native-host-stdio.js'),
      statePath: prodState
    })
    const wrapper = await readFile(wrapperPath, 'utf8')
    expect(wrapper).toContain(`AGENT_STUDIO_CHROME_NATIVE_STATE='${prodState}'`)
    expect(wrapper).not.toContain('agent-studio-dev')

    expect(resolveChromeNativeHostBridge({ AGENT_STUDIO_CHROME_NATIVE_STATE: prodState })).toEqual({
      socketPath: prodSocket,
      token: 'prod-token'
    })
    expect(resolveChromeNativeHostBridge({})).toBeNull()
    expect(
      resolveChromeNativeHostBridge({
        AGENT_STUDIO_CHROME_NATIVE_STATE: join(homeDir, 'missing-chrome-native-host.json')
      })
    ).toBeNull()
  })
})

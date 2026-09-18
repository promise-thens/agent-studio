import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, isAbsolute, join } from 'node:path'
import type { HostBrowserSettings } from '../../../shared/host-browser'
import {
  CHROME_NATIVE_HOST_NAME,
  chromeExtensionAllowedOrigin,
  cookieMatchesBlacklist,
  createChromeNativeLogRecord,
  parseChromeNativeCookiesSyncPayload,
  parseChromeNativeRequest,
  parseChromeNativeTabsOpenUrl,
  synthesizeChromeNativeCookieUrl,
  type ChromeNativeCookie,
  type ChromeNativeError,
  type ChromeNativeResponse
} from '../../../shared/chrome-native-bridge'
import { parseBrowserOrigin } from '../../../shared/browser-origin'
import { createBrowserPartition } from '../host-browser-session'

export interface ChromeNativeHostManifest {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

export interface ChromeNativeCookieSetDetails {
  url: string
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: 'no_restriction' | 'lax' | 'strict'
}

export interface ChromeNativeCookieApplyResult {
  applied: number
  skipped: number
  ignored: boolean
  reason?: string
}

export type ChromeNativeCookieApplyOutcome =
  ChromeNativeCookieApplyResult | { rejected: true; error: ChromeNativeError }

export interface ChromeNativeHostDependencies {
  userDataPath: string
  getSettings: () => HostBrowserSettings
  getProjectId: () => string | null
  setCookie: (partition: string, details: ChromeNativeCookieSetDetails) => Promise<void>
  log?: (record: Record<string, unknown>) => void
  onTabsSnapshot?: (payload: unknown) => void
}

/**
 * 用 SPKI DER 公钥计算 Chrome 扩展 id。测试锁定提交的公钥，禁止换成任意 origin。
 */
export function computeChromeExtensionId(publicKeyDerBase64: string): string {
  const digest = createHash('sha256')
    .update(Buffer.from(publicKeyDerBase64, 'base64'))
    .digest('hex')
    .slice(0, 32)
  return [...digest]
    .map((char) => String.fromCharCode('a'.charCodeAt(0) + Number.parseInt(char, 16)))
    .join('')
}

/**
 * Native Messaging 清单：path 只能是本 host 命令，allowed_origins 只有配套扩展。
 */
export function buildChromeNativeHostManifest(execPath: string): ChromeNativeHostManifest {
  if (typeof execPath !== 'string' || execPath.trim() === '' || execPath.includes('\0')) {
    throw new Error('Native Host 命令路径无效。')
  }
  if (!isAbsolute(execPath)) {
    throw new Error('Native Host 命令路径必须是绝对路径。')
  }
  return {
    name: CHROME_NATIVE_HOST_NAME,
    description: 'Agent Studio Browser Native Host',
    path: execPath,
    type: 'stdio',
    allowed_origins: [chromeExtensionAllowedOrigin()]
  }
}

/**
 * 把清单写到 `$homeDir/.../NativeMessagingHosts/`。
 * 测试必须传入临时 homeDir；禁止默认写开发者本机 Chrome 目录。
 */
export async function installChromeNativeHostManifest(options: {
  homeDir: string
  execPath: string
}): Promise<string> {
  if (typeof options.homeDir !== 'string' || !isAbsolute(options.homeDir)) {
    throw new Error('Native Host 安装目录无效。')
  }
  const directory = join(
    options.homeDir,
    'Library/Application Support/Google/Chrome/NativeMessagingHosts'
  )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filePath = join(directory, `${CHROME_NATIVE_HOST_NAME}.json`)
  const manifest = buildChromeNativeHostManifest(options.execPath)
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  return filePath
}

export function resolveChromeNativeHostScriptPath(mainDirectory: string): string {
  const bundled = join(mainDirectory, 'chrome-native-host-stdio.js')
  if (existsSync(bundled)) return bundled
  return join(mainDirectory.replace('app.asar', 'app.asar.unpacked'), 'chrome-native-host-stdio.js')
}

/**
 * 把扩展 Cookie 写入 `persist:as-browser:{projectId}`。
 * cookieSyncEnabled === false 时整批忽略；黑名单 origin 跳过；没有 project 拒绝且不写。
 * 日志只走 createChromeNativeLogRecord，value 不得出现。
 */
export async function applyChromeNativeCookiesSync(options: {
  cookies: ChromeNativeCookie[]
  settings: Pick<HostBrowserSettings, 'cookieSyncEnabled' | 'syncBlacklist'>
  projectId: string | null
  setCookie: (partition: string, details: ChromeNativeCookieSetDetails) => Promise<void>
  log?: (record: Record<string, unknown>) => void
}): Promise<ChromeNativeCookieApplyOutcome> {
  const { cookies, settings } = options
  if (settings.cookieSyncEnabled !== true) {
    options.log?.(
      createChromeNativeLogRecord({
        command: 'cookies.sync',
        cookieCount: cookies.length,
        ignored: true
      })
    )
    return {
      applied: 0,
      skipped: cookies.length,
      ignored: true,
      reason: 'cookie-sync-disabled'
    }
  }
  if (typeof options.projectId !== 'string' || options.projectId.trim() === '') {
    options.log?.(
      createChromeNativeLogRecord({
        command: 'cookies.sync',
        cookieCount: cookies.length
      })
    )
    return {
      rejected: true,
      error: { code: 'no-project', message: '没有可写入的内置浏览器会话。' }
    }
  }
  const partition = createBrowserPartition(options.projectId)
  let applied = 0
  let skipped = 0
  const origins: string[] = []
  for (const cookie of cookies) {
    const url = synthesizeChromeNativeCookieUrl(cookie)
    if (!url || cookieMatchesBlacklist(cookie, settings.syncBlacklist)) {
      skipped += 1
      continue
    }
    const origin = parseBrowserOrigin(url)
    if (origin && !origins.includes(origin)) origins.push(origin)
    const details: ChromeNativeCookieSetDetails = {
      url,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly
    }
    if (typeof cookie.expirationDate === 'number') details.expirationDate = cookie.expirationDate
    if (cookie.sameSite) details.sameSite = cookie.sameSite
    try {
      await options.setCookie(partition, details)
      applied += 1
    } catch {
      skipped += 1
    }
  }
  options.log?.(
    createChromeNativeLogRecord({
      command: 'cookies.sync',
      cookieCount: cookies.length,
      origins,
      applied,
      skipped
    })
  )
  return { applied, skipped, ignored: false }
}

/**
 * 命令白名单分发。未知 command 已在 parse 阶段变成错误对象；这里仍不 exec / spawn。
 */
export async function handleChromeNativeRequest(options: {
  request: unknown
  settings: HostBrowserSettings
  projectId: string | null
  setCookie: (partition: string, details: ChromeNativeCookieSetDetails) => Promise<void>
  log?: (record: Record<string, unknown>) => void
  onTabsSnapshot?: (payload: unknown) => void
}): Promise<ChromeNativeResponse> {
  const parsed = parseChromeNativeRequest(options.request)
  if (!parsed.ok) {
    return { id: parsed.id ?? '', ok: false, error: parsed.error }
  }
  const { request } = parsed
  if (request.command === 'ping') {
    return { id: request.id, ok: true, result: { pong: true } }
  }
  if (request.command === 'tabs.snapshot') {
    // 几何映射由调用方用 overlay getBounds() 完成；这里只回 accepted，不发明光标
    options.onTabsSnapshot?.(request.payload)
    return { id: request.id, ok: true, result: { accepted: true } }
  }
  if (request.command === 'tabs.open') {
    const url = parseChromeNativeTabsOpenUrl(request.payload)
    if (!url) {
      return {
        id: request.id,
        ok: false,
        error: { code: 'invalid-url', message: '标签 URL 无效。' }
      }
    }
    return { id: request.id, ok: true, result: { accepted: true } }
  }
  if (request.command === 'cookies.sync') {
    const payload = parseChromeNativeCookiesSyncPayload(request.payload)
    if (!payload) {
      return {
        id: request.id,
        ok: false,
        error: { code: 'invalid-payload', message: 'Cookie 同步载荷无效。' }
      }
    }
    const outcome = await applyChromeNativeCookiesSync({
      cookies: payload.cookies,
      settings: options.settings,
      projectId: options.projectId,
      setCookie: options.setCookie,
      log: options.log
    })
    if ('rejected' in outcome && outcome.rejected) {
      return { id: request.id, ok: false, error: outcome.error }
    }
    return { id: request.id, ok: true, result: outcome }
  }
  return {
    id: request.id,
    ok: false,
    error: { code: 'unknown-command', message: '不支持该命令。' }
  }
}

/**
 * 主进程在 app ready 后监听的本机 socket。
 * stdio 子进程把 Native Messaging 帧转过来；Cookie 写入内置 partition，不读磁盘 Chrome Profile。
 */
export class ChromeNativeHost {
  private server: Server | null = null
  private socketPathValue = ''
  private tokenValue = ''
  private lastCookieSyncAtValue: string | null = null
  private readonly sockets = new Set<Socket>()

  constructor(private readonly dependencies: ChromeNativeHostDependencies) {}

  /** 最近一次真正 apply 的 Cookie 同步时间；关同步忽略时不更新。 */
  lastCookieSyncAt(): string | null {
    return this.lastCookieSyncAtValue
  }

  async start(): Promise<void> {
    const directory = join(this.dependencies.userDataPath, 'browser')
    const socketPath = join(directory, 'chrome-native-host.sock')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await unlink(socketPath).catch(() => undefined)
    this.tokenValue = randomBytes(32).toString('base64url')
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        // unref：避免测试进程因 socket 听口退不出去；有主窗时事件循环仍由 Electron 撑着。
        server.unref()
        this.server = server
        this.socketPathValue = socketPath
        resolve()
      })
    })
    await chmod(socketPath, 0o600).catch(() => undefined)
    await writeFile(
      join(directory, 'chrome-native-host.json'),
      `${JSON.stringify({ socketPath, token: this.tokenValue })}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
  }

  socketPath(): string {
    return this.socketPathValue
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.server
    const socketPath = this.socketPathValue
    this.server = null
    this.socketPathValue = ''
    this.tokenValue = ''
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (socketPath) {
      await unlink(socketPath).catch(() => undefined)
      await unlink(join(dirname(socketPath), 'chrome-native-host.json')).catch(() => undefined)
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) void this.handleLine(socket, line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {
      socket.destroy()
      this.sockets.delete(socket)
    })
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch {
      socket.destroy()
      return
    }
    if (
      !isRecord(payload) ||
      !tokensEqual(String(payload.token ?? ''), this.tokenValue) ||
      !this.tokenValue
    ) {
      socket.destroy()
      return
    }
    const response = await handleChromeNativeRequest({
      request: payload.request,
      settings: this.dependencies.getSettings(),
      projectId: this.dependencies.getProjectId(),
      setCookie: this.dependencies.setCookie,
      log: this.dependencies.log,
      onTabsSnapshot: this.dependencies.onTabsSnapshot
    })
    if (
      response.ok &&
      isRecord(response.result) &&
      response.result.ignored !== true &&
      typeof response.result.applied === 'number'
    ) {
      this.lastCookieSyncAtValue = new Date().toISOString()
    }
    if (!socket.destroyed) {
      socket.write(`${JSON.stringify({ result: response })}\n`)
    }
  }
}

function tokensEqual(left: string, right: string): boolean {
  const hashedLeft = createHash('sha256').update(left).digest()
  const hashedRight = createHash('sha256').update(right).digest()
  return timingSafeEqual(hashedLeft, hashedRight)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

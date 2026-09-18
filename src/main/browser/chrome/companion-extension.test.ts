import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_PUBLIC_KEY,
  CHROME_NATIVE_HOST_NAME
} from '../../../shared/chrome-native-bridge'
import {
  installHostBrowserCompanionExtension,
  isChromeNativeHostForbiddenExecPath,
  companionSnapshotHasMappableGeometry,
  mapChromeNativeSnapshotToOverlayDip,
  resolveCompanionChromeExtensionDirectory,
  writeChromeNativeHostWrapper
} from './companion-extension'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '../../../../')
const extensionDir = join(repoRoot, 'chrome-extension/agent-studio-browser')

async function readExtensionFile(name: string): Promise<string> {
  return readFile(join(extensionDir, name), 'utf8')
}

describe('配套 MV3 扩展源码契约', () => {
  it('manifest 固定公钥 unpacked id，没有把当前标签交给 Agent 的主按钮', async () => {
    const manifestRaw = await readExtensionFile('manifest.json')
    const manifest = JSON.parse(manifestRaw) as {
      manifest_version: number
      key: string
      permissions: string[]
      background?: { service_worker?: string }
      action?: { default_popup?: string }
    }
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.key).toBe(CHROME_EXTENSION_PUBLIC_KEY)
    expect(manifest.permissions).toEqual(expect.arrayContaining(['cookies', 'nativeMessaging']))
    expect(manifest.background?.service_worker).toBe('background.js')
    expect(manifest.action?.default_popup).toBe('popup.html')
    expect(manifestRaw).not.toContain('把当前标签交给 Agent')
    expect(manifestRaw).not.toContain('交给 Agent')
    expect(manifestRaw).not.toContain('give-tab')
    expect(manifestRaw).not.toContain('Default/Cookies')
  })

  it('popup 只显示已连接/未连接，源码不含交给 Agent', async () => {
    const popup = `${await readExtensionFile('popup.html')}\n${await readExtensionFile('popup.js')}`
    expect(popup).toContain('已连接')
    expect(popup).toContain('未连接')
    expect(popup).not.toContain('交给 Agent')
    expect(popup).not.toContain('把当前标签交给 Agent')
    expect(popup).not.toMatch(/<button[^>]*>/)
  })

  it('background 装上即 connectNative，Cookie 走扩展 API，不读磁盘 Profile', async () => {
    const background = await readExtensionFile('background.js')
    expect(background).toContain(`chrome.runtime.connectNative('${CHROME_NATIVE_HOST_NAME}')`)
    expect(background).toContain('cookies.getAll')
    expect(background).toContain('cookies.sync')
    expect(background).toContain('tabs.snapshot')
    expect(background).toContain('windowScreenBounds')
    expect(background).not.toContain('Default/Cookies')
    expect(background).not.toContain('Login Data')
    expect(background).not.toContain('Web Data')
    expect(background).not.toContain('交给 Agent')
    expect(background).not.toContain(homedir())
  })

  it('README 说明 unpacked 安装，不写 Profile 路径', async () => {
    const readme = await readExtensionFile('README.md')
    expect(readme).toContain('开发者模式')
    expect(readme).toContain('加载已解压')
    expect(readme).toContain(CHROME_EXTENSION_ID)
    expect(readme).not.toContain('Default/Cookies')
  })
})

describe('配套扩展 snapshot → overlay DIP', () => {
  it('有窗 DIP 时按 overlay getBounds 映射；无 bounds 不发明光标', () => {
    expect(
      mapChromeNativeSnapshotToOverlayDip({
        windowScreenBounds: { x: 100, y: 200, width: 800, height: 600 },
        cssX: 40,
        cssY: 60,
        zoom: 2,
        overlayBounds: { x: 10, y: 20, width: 1440, height: 900 }
      })
    ).toEqual({ x: 110, y: 210 })

    expect(
      mapChromeNativeSnapshotToOverlayDip({
        windowScreenBounds: { x: 100, y: 200, width: 800, height: 600 },
        cssX: 40,
        cssY: 60,
        overlayBounds: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toEqual({ x: 140, y: 260 })

    expect(
      mapChromeNativeSnapshotToOverlayDip({
        cssX: 40,
        cssY: 60,
        zoom: 1,
        overlayBounds: { x: 0, y: 0, width: 1440, height: 900 }
      })
    ).toBeUndefined()

    expect(
      mapChromeNativeSnapshotToOverlayDip({
        windowScreenBounds: { x: 100, y: 200, width: 800, height: 600 },
        cssX: 40,
        cssY: 60,
        zoom: 1
      })
    ).toBeUndefined()

    expect(
      mapChromeNativeSnapshotToOverlayDip({
        windowScreenBounds: { x: Number.NaN, y: 0, width: 1, height: 1 },
        cssX: 1,
        cssY: 1,
        overlayBounds: { x: 0, y: 0, width: 100, height: 100 }
      })
    ).toBeUndefined()

    expect(
      companionSnapshotHasMappableGeometry({
        windowScreenBounds: { x: 100, y: 200, width: 800, height: 600 },
        cssX: 40,
        cssY: 60
      })
    ).toBe(true)
    expect(companionSnapshotHasMappableGeometry({ cssX: 40, cssY: 60 })).toBe(false)
    expect(
      companionSnapshotHasMappableGeometry({
        windowScreenBounds: { x: 100, y: 200, width: 800, height: 600 }
      })
    ).toBe(false)
  })
})

describe('配套扩展安装与 Native Host 包装', () => {
  it('execPath 拒绝通用 Shell，包装脚本必须指向 chrome-native-host-stdio', async () => {
    expect(isChromeNativeHostForbiddenExecPath('/bin/bash')).toBe(true)
    expect(isChromeNativeHostForbiddenExecPath('/bin/sh')).toBe(true)
    expect(isChromeNativeHostForbiddenExecPath('/tmp/chrome-native-host-stdio')).toBe(false)

    const homeDir = await mkdtemp(join(tmpdir(), 'as-chrome-wrapper-'))
    await expect(
      writeChromeNativeHostWrapper({
        wrapperPath: join(homeDir, 'chrome-native-host-stdio'),
        electronExecPath: '/bin/bash',
        scriptPath: join(homeDir, 'chrome-native-host-stdio.js'),
        statePath: join(homeDir, 'browser', 'chrome-native-host.json')
      })
    ).rejects.toThrow(/Shell/)

    const wrapperPath = await writeChromeNativeHostWrapper({
      wrapperPath: join(homeDir, 'browser', 'chrome-native-host-stdio'),
      electronExecPath: join(homeDir, 'Agent Studio.app/Contents/MacOS/Agent Studio'),
      scriptPath: join(homeDir, 'chrome-native-host-stdio.js'),
      statePath: join(homeDir, 'browser', 'chrome-native-host.json')
    })
    expect(wrapperPath.endsWith('chrome-native-host-stdio')).toBe(true)
    expect(wrapperPath).not.toBe('/bin/bash')
    const wrapper = await readFile(wrapperPath, 'utf8')
    expect(wrapper).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(wrapper).toContain('chrome-native-host-stdio.js')
    expect(wrapper).not.toMatch(/^\/bin\/bash/m)
  })

  it('包装脚本钉死本次 chrome-native-host.json，不把身份交给 -dev 扫描', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'as-chrome-wrapper-state-'))
    const prodState = join(
      homeDir,
      'Library/Application Support/agent-studio/browser/chrome-native-host.json'
    )
    const wrapperPath = await writeChromeNativeHostWrapper({
      wrapperPath: join(homeDir, 'browser', 'chrome-native-host-stdio'),
      electronExecPath: join(homeDir, 'Agent Studio.app/Contents/MacOS/Agent Studio'),
      scriptPath: join(homeDir, 'chrome-native-host-stdio.js'),
      statePath: prodState
    })
    const wrapper = await readFile(wrapperPath, 'utf8')
    expect(wrapper).toContain("AGENT_STUDIO_CHROME_NATIVE_STATE='")
    expect(wrapper).toContain(prodState)
    expect(wrapper).not.toContain('agent-studio-dev')
  })

  it('安装只写临时 homeDir，reveal unpacked 目录，不碰开发者真 Chrome', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'as-chrome-install-'))
    const extensionDirectory = join(homeDir, 'chrome-extension/agent-studio-browser')
    await mkdir(extensionDirectory, { recursive: true })
    await writeFile(join(extensionDirectory, 'manifest.json'), '{}\n', 'utf8')
    const execPath = join(homeDir, 'chrome-native-host-stdio')
    await writeFile(execPath, '#!/bin/sh\n', 'utf8')
    await chmod(execPath, 0o700)
    const reveal = vi.fn(async () => '')
    const result = await installHostBrowserCompanionExtension({
      homeDir,
      execPath,
      extensionDirectory,
      reveal
    })
    expect(result).toEqual({ installed: true })
    expect(reveal).toHaveBeenCalledWith(extensionDirectory)
    const written = join(
      homeDir,
      'Library/Application Support/Google/Chrome/NativeMessagingHosts',
      `${CHROME_NATIVE_HOST_NAME}.json`
    )
    const manifest = JSON.parse(await readFile(written, 'utf8')) as { path: string }
    expect(manifest.path).toBe(execPath)
    expect(written.startsWith(homeDir)).toBe(true)
    expect(written).not.toBe(
      join(
        homedir(),
        'Library/Application Support/Google/Chrome/NativeMessagingHosts',
        `${CHROME_NATIVE_HOST_NAME}.json`
      )
    )
  })

  it('解析配套扩展目录只认带 manifest 的候选，不打开 Chrome Profile', () => {
    const resolved = resolveCompanionChromeExtensionDirectory({
      mainDirectory: join(repoRoot, 'out/main'),
      appPath: repoRoot
    })
    expect(resolved).toBe(extensionDir)
    expect(resolved).not.toContain('Default/Cookies')
  })
})

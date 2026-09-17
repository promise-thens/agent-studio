import { describe, expect, it } from 'vitest'
import { resolveDesktopUserDataPath } from './desktop-user-data'

const PACKAGED_USER_DATA = '/Users/tester/Library/Application Support/agent-studio'
const E2E_USER_DATA = '/tmp/agent-studio-controlled-acp-e2e-xxxx'

describe('resolveDesktopUserDataPath', () => {
  it('未打包进程把 userData 改到独立的 -dev 目录，不改安装包默认路径', () => {
    expect(
      resolveDesktopUserDataPath({
        packaged: false,
        currentUserData: PACKAGED_USER_DATA,
        hasIsolatedBootstrap: false
      })
    ).toBe(`${PACKAGED_USER_DATA}-dev`)
    expect(
      resolveDesktopUserDataPath({
        packaged: true,
        currentUserData: PACKAGED_USER_DATA,
        hasIsolatedBootstrap: false
      })
    ).toBe(PACKAGED_USER_DATA)
  })

  it('受控 E2E 或观察启动已经切到临时目录时不得再追加 -dev', () => {
    expect(
      resolveDesktopUserDataPath({
        packaged: false,
        currentUserData: E2E_USER_DATA,
        hasIsolatedBootstrap: true
      })
    ).toBe(E2E_USER_DATA)
  })
})

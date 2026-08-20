import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppearanceController, type NativeThemeAdapter } from './appearance-controller'
import { AppearanceStore } from './appearance-store'

function createTheme(initialDark = true): NativeThemeAdapter & {
  emitUpdated: () => void
} {
  let themeSource: NativeThemeAdapter['themeSource'] = 'system'
  let shouldUseDarkColors = initialDark
  const listeners = new Set<() => void>()
  return {
    get shouldUseDarkColors() {
      return themeSource === 'system' ? shouldUseDarkColors : themeSource === 'dark'
    },
    get themeSource() {
      return themeSource
    },
    set themeSource(value) {
      themeSource = value
    },
    setSystemPrefersDark(value: boolean) {
      shouldUseDarkColors = value
    },
    onUpdated(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emitUpdated() {
      for (const listener of listeners) listener()
    }
  } as NativeThemeAdapter & { emitUpdated: () => void }
}

describe('AppearanceController', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await fs.mkdtemp(join(tmpdir(), 'agent-studio-appearance-ctrl-'))
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('初始化时按偏好设置 nativeTheme，并在系统变化时只对跟随系统推送', async () => {
    const theme = createTheme(true)
    const store = new AppearanceStore({ userDataPath })
    const controller = new AppearanceController({ store, nativeTheme: theme })
    const listener = vi.fn()
    controller.onResolvedChange(listener)

    expect(await controller.initialize()).toEqual({ mode: 'dark', resolved: 'dark' })
    expect(theme.themeSource).toBe('dark')

    expect(await controller.setMode('system')).toEqual({ mode: 'system', resolved: 'dark' })
    expect(theme.themeSource).toBe('system')
    expect(listener).toHaveBeenLastCalledWith({ mode: 'system', resolved: 'dark' })

    ;(theme as unknown as { setSystemPrefersDark: (value: boolean) => void }).setSystemPrefersDark(
      false
    )
    theme.emitUpdated()
    expect(listener).toHaveBeenLastCalledWith({ mode: 'system', resolved: 'light' })
    expect(controller.getState()).toEqual({ mode: 'system', resolved: 'light' })

    await controller.setMode('light')
    listener.mockClear()
    ;(theme as unknown as { setSystemPrefersDark: (value: boolean) => void }).setSystemPrefersDark(
      true
    )
    theme.emitUpdated()
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getState()).toEqual({ mode: 'light', resolved: 'light' })
    expect(theme.themeSource).toBe('light')
  })
})

import {
  isAppAppearanceMode,
  resolveAppearance,
  appearanceWindowBackground,
  type AppAppearanceMode,
  type AppAppearanceState
} from '../../shared/app-appearance'
import type { AppearanceStore } from './appearance-store'

export interface NativeThemeAdapter {
  readonly shouldUseDarkColors: boolean
  themeSource: 'system' | 'light' | 'dark'
  onUpdated(listener: () => void): () => void
}

export interface AppearanceControllerOptions {
  store: AppearanceStore
  nativeTheme: NativeThemeAdapter
}

/**
 * 把持久化偏好同步到 Electron nativeTheme，并在跟随系统时转发解析结果。
 * Renderer 只消费 { mode, resolved }，不直接读 OS。
 */
export class AppearanceController {
  private readonly store: AppearanceStore
  private readonly nativeTheme: NativeThemeAdapter
  private readonly listeners = new Set<(state: AppAppearanceState) => void>()
  private stopThemeListen: (() => void) | null = null
  private lastResolved: AppAppearanceState['resolved'] | null = null

  constructor(options: AppearanceControllerOptions) {
    this.store = options.store
    this.nativeTheme = options.nativeTheme
  }

  async initialize(): Promise<AppAppearanceState> {
    await this.store.initialize()
    this.applyThemeSource()
    this.stopThemeListen?.()
    this.stopThemeListen = this.nativeTheme.onUpdated(() => this.handleSystemUpdated())
    const state = this.getState()
    this.lastResolved = state.resolved
    return state
  }

  getState(): AppAppearanceState {
    const mode = this.store.getMode()
    return {
      mode,
      resolved: resolveAppearance(mode, this.nativeTheme.shouldUseDarkColors)
    }
  }

  windowBackground(): string {
    return appearanceWindowBackground(this.getState().resolved)
  }

  async setMode(mode: AppAppearanceMode): Promise<AppAppearanceState> {
    if (!isAppAppearanceMode(mode)) throw new Error('外观模式无效。')
    await this.store.save(mode)
    this.applyThemeSource()
    const state = this.getState()
    this.lastResolved = state.resolved
    this.emit(state)
    return state
  }

  onResolvedChange(listener: (state: AppAppearanceState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private applyThemeSource(): void {
    const mode = this.store.getMode()
    this.nativeTheme.themeSource = mode === 'system' ? 'system' : mode
  }

  private handleSystemUpdated(): void {
    if (this.store.getMode() !== 'system') return
    const state = this.getState()
    if (state.resolved === this.lastResolved) return
    this.lastResolved = state.resolved
    this.emit(state)
  }

  private emit(state: AppAppearanceState): void {
    for (const listener of this.listeners) listener(state)
  }
}

import { describe, expect, it } from 'vitest'
import { resolveEscapeWorkbenchTarget, shouldIgnoreWorkbenchEscape } from './workbench-keyboard'

describe('Esc 工作台焦点目标', () => {
  it('执行中且焦点不在检查器时，优先聚焦停止而不是关抽屉', () => {
    expect(
      resolveEscapeWorkbenchTarget({
        turnExecuting: true,
        inspectorOpen: true,
        focusInsideInspector: false
      })
    ).toBe('stop-button')
    expect(
      resolveEscapeWorkbenchTarget({
        turnExecuting: true,
        inspectorOpen: false,
        focusInsideInspector: false
      })
    ).toBe('stop-button')
  })

  it('执行中但焦点已在检查器内时，Esc 才关检查器', () => {
    expect(
      resolveEscapeWorkbenchTarget({
        turnExecuting: true,
        inspectorOpen: true,
        focusInsideInspector: true
      })
    ).toBe('close-inspector')
  })

  it('空闲时 Esc 只关打开的检查器，不找停止按钮', () => {
    expect(
      resolveEscapeWorkbenchTarget({
        turnExecuting: false,
        inspectorOpen: true,
        focusInsideInspector: false
      })
    ).toBe('close-inspector')
    expect(
      resolveEscapeWorkbenchTarget({
        turnExecuting: false,
        inspectorOpen: false,
        focusInsideInspector: false
      })
    ).toBe('none')
  })

  it('输入法、已处理的 Esc、权限卡/确认框不抢停止焦点', () => {
    expect(shouldIgnoreWorkbenchEscape({ key: 'Enter' })).toBe(true)
    expect(shouldIgnoreWorkbenchEscape({ key: 'Escape', isComposing: true })).toBe(true)
    expect(shouldIgnoreWorkbenchEscape({ key: 'Escape', keyCode: 229 })).toBe(true)
    expect(shouldIgnoreWorkbenchEscape({ key: 'Escape', defaultPrevented: true })).toBe(true)
    expect(shouldIgnoreWorkbenchEscape({ key: 'Escape', overlayConsumesEscape: true })).toBe(true)
    expect(shouldIgnoreWorkbenchEscape({ key: 'Escape' })).toBe(false)
  })
})

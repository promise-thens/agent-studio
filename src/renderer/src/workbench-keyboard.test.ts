import { describe, expect, it } from 'vitest'
import {
  overlayConsumesEscape,
  resolveEscapeWorkbenchTarget,
  shouldIgnoreWorkbenchEscape
} from './workbench-keyboard'

class JsdomLikeElement {
  constructor(
    readonly className: string,
    readonly parentElement: JsdomLikeElement | null = null
  ) {}

  closest(selector: string): JsdomLikeElement | null {
    return matchClassSelector(this, selector)
  }
}

/** class 选择器匹配从自身走到祖先，对齐 Element.closest 的常用路径。 */
function matchClassSelector(start: JsdomLikeElement, selector: string): JsdomLikeElement | null {
  const tokens = selector.split(',').map((part) => part.trim())
  let node: JsdomLikeElement | null = start
  while (node) {
    const classes = new Set(node.className.split(/\s+/).filter(Boolean))
    if (tokens.some((token) => token.startsWith('.') && classes.has(token.slice(1)))) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * 测试用 Element：优先走真实 DOM；Node 下补一个带 closest 的 jsdom 形替身，
 * 让 `instanceof Element` 与 class 选择器可测。
 */
function childInsideClass(className: string): EventTarget {
  if (typeof document !== 'undefined') {
    const root = document.createElement('div')
    root.className = className
    const child = document.createElement('button')
    root.appendChild(child)
    return child
  }

  if (typeof globalThis.Element === 'undefined') {
    Object.defineProperty(globalThis, 'Element', {
      configurable: true,
      value: JsdomLikeElement
    })
  }

  const root = new JsdomLikeElement(className)
  return new JsdomLikeElement('inner', root) as unknown as EventTarget
}

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

describe('overlayConsumesEscape', () => {
  it('斜杠命令板内部节点算 overlay，Esc 不停止 Task 也不关检查器', () => {
    const inner = childInsideClass('slash-command-palette')
    expect(overlayConsumesEscape(inner)).toBe(true)
    expect(
      shouldIgnoreWorkbenchEscape({
        key: 'Escape',
        overlayConsumesEscape: overlayConsumesEscape(inner)
      })
    ).toBe(true)
  })

  it('已有权限卡/确认框仍吃掉 Esc', () => {
    expect(overlayConsumesEscape(childInsideClass('permission-inline-card'))).toBe(true)
    expect(overlayConsumesEscape(childInsideClass('permission-dialog'))).toBe(true)
    expect(overlayConsumesEscape(childInsideClass('modal-backdrop'))).toBe(true)
  })

  it('图片灯箱吃掉 Esc，不停止 Task', () => {
    expect(overlayConsumesEscape(childInsideClass('attachment-image-backdrop'))).toBe(true)
  })

  it('无关节点和空目标不吃掉 Esc', () => {
    expect(overlayConsumesEscape(null)).toBe(false)
    expect(overlayConsumesEscape(childInsideClass('task-composer'))).toBe(false)
    expect(
      shouldIgnoreWorkbenchEscape({
        key: 'Escape',
        overlayConsumesEscape: overlayConsumesEscape(childInsideClass('task-composer'))
      })
    ).toBe(false)
  })
})

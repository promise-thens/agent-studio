import { parseBrowserOrigin } from '../../shared/browser-origin'
import {
  HOST_BROWSER_ACTION_NAMES,
  parseHostBrowserAction,
  type HostBrowserAction,
  type HostBrowserActionName
} from '../../shared/host-browser'

/** 允许附加后调用的 CDP 方法。禁止 evaluate、读 cookie、任意 DOM 序列化。 */
export const HOST_BROWSER_CDP_METHODS = [
  'Accessibility.getFullAXTree',
  'DOM.getContentQuads',
  'DOM.focus',
  'DOM.scrollIntoViewIfNeeded',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText'
] as const

const ALLOWED_CDP = new Set<string>(HOST_BROWSER_CDP_METHODS)
const ACTION_NAME_SET = new Set<string>(HOST_BROWSER_ACTION_NAMES)
const MAX_SNAPSHOT_NODES = 150
const MAX_SNAPSHOT_NAME_CHARS = 200
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SINGLE_TAB_ID = 'tab-1'
/** 弹窗角色：其可见子孙必须压过页面上成片的导航节点，否则关不掉对话框。 */
const DIALOG_AX_ROLES = new Set(['dialog', 'alertdialog'])
/** 可交互角色；无名 button 也收。link 同属此集合，截断时再排到控件后面。 */
const INTERACTIVE_AX_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'slider',
  'tab',
  'menuitem',
  'switch',
  'listbox',
  'option',
  'spinbutton'
])

export type HostBrowserActionErrorCode =
  | 'unknown-action'
  | 'invalid-url'
  | 'invalid-ref'
  | 'expired-ref'
  | 'invalid-input'
  | 'invalid-screenshot'
  | 'unsupported-cdp'
  | 'denied'
  | 'unavailable'
  | 'action-failed'

export type HostBrowserSnapshotNode = {
  ref: string
  role: string
  name: string
  tag: string
}

export type HostBrowserActionData =
  | { kind: 'navigated'; url: string }
  | { kind: 'snapshot'; nodes: HostBrowserSnapshotNode[]; truncated: boolean }
  | {
      kind: 'screenshot'
      mimeType: 'image/png'
      bytes: Buffer
      viewportWidth?: number
      viewportHeight?: number
    }
  | { kind: 'clicked'; viewportX: number; viewportY: number }
  | { kind: 'typed'; viewportX?: number; viewportY?: number }
  | { kind: 'scrolled' }
  | { kind: 'tabs'; tabs: Array<{ tabId: string; title: string; origin: string }> }
  | { kind: 'ok' }

export type HostBrowserActionResult =
  | { ok: true; data: HostBrowserActionData }
  | { ok: false; code: HostBrowserActionErrorCode; message: string }

/** 测试与生产共用的 guest 动作端口。不得把 debugger 句柄放在这个对象上。 */
export interface HostBrowserActionDriver {
  getURL(): string
  getTitle(): string
  loadURL(url: string): Promise<void> | void
  goBack(): Promise<boolean> | boolean
  goForward(): Promise<boolean> | boolean
  reload(): Promise<void> | void
  capturePng(): Promise<Buffer>
  /** 内置页视口 CSS 尺寸；截图与 click_xy 必须用同一套。 */
  getViewportCssSize(): { width: number; height: number } | null
  sendCdp(method: string, params?: Record<string, unknown>): Promise<unknown>
}

interface SnapshotRefRecord {
  backendDOMNodeId: number
  pageUrl: string
}

/**
 * 只把白名单 CDP 交给 guest。未列出的方法在这里截住，避免表达式求值或 cookie 读取漏出去。
 */
export async function sendHostBrowserCdp(
  driver: HostBrowserActionDriver,
  method: string,
  params?: Record<string, unknown>
): Promise<
  { ok: true; value: unknown } | { ok: false; code: HostBrowserActionErrorCode; message: string }
> {
  if (!ALLOWED_CDP.has(method)) {
    return fail('unsupported-cdp', '不允许该调试方法。')
  }
  try {
    const value = await driver.sendCdp(method, params)
    return { ok: true, value }
  } catch {
    return fail('action-failed', '页面动作执行失败。')
  }
}

/**
 * 主进程内的窄动作引擎。ref 只活在这一层，Renderer 拿不到，离开当前 URL 即作废。
 */
export class HostBrowserActionEngine {
  private readonly refs = new Map<string, SnapshotRefRecord>()
  private snapshotUrl = ''

  constructor(private readonly driver: HostBrowserActionDriver) {}

  async perform(raw: unknown): Promise<HostBrowserActionResult> {
    const action = parseHostBrowserAction(raw)
    if (!action) return classifyParseFailure(raw)
    return this.execute(action)
  }

  async execute(action: HostBrowserAction): Promise<HostBrowserActionResult> {
    switch (action.name) {
      case 'browser_navigate':
        return this.navigate(action.url)
      case 'browser_tabs_open':
        return action.url
          ? this.navigate(action.url)
          : fail('invalid-input', '打开标签需要 http(s) 地址。')
      case 'browser_back':
        return this.history('back')
      case 'browser_forward':
        return this.history('forward')
      case 'browser_reload':
        await this.driver.reload()
        this.clearRefs()
        return ok({ kind: 'ok' })
      case 'browser_tabs_list':
        return this.listTabs()
      case 'browser_tabs_select':
        return action.tabId === SINGLE_TAB_ID
          ? ok({ kind: 'ok' })
          : fail('invalid-input', '标签不存在。')
      case 'browser_tabs_close':
        return fail('invalid-input', '不能关闭唯一的内置标签。')
      case 'browser_snapshot':
        return this.snapshot()
      case 'browser_screenshot':
        return this.screenshot()
      case 'browser_click':
        return this.click(action.ref)
      case 'browser_click_xy':
        return this.clickXy(action.x, action.y)
      case 'browser_type':
        return this.type(action.ref, action.text, action.submit === true)
      case 'browser_scroll':
        return this.scroll(action.direction, action.amount ?? 3)
    }
  }

  private async navigate(url: string): Promise<HostBrowserActionResult> {
    await this.driver.loadURL(url)
    this.clearRefs()
    return ok({ kind: 'navigated', url })
  }

  private async history(kind: 'back' | 'forward'): Promise<HostBrowserActionResult> {
    const moved = kind === 'back' ? await this.driver.goBack() : await this.driver.goForward()
    if (moved) this.clearRefs()
    return ok({ kind: 'ok' })
  }

  private listTabs(): HostBrowserActionResult {
    const url = this.driver.getURL()
    const origin = url === 'about:blank' ? '' : (parseBrowserOrigin(url) ?? '')
    return ok({
      kind: 'tabs',
      tabs: [{ tabId: SINGLE_TAB_ID, title: this.driver.getTitle(), origin }]
    })
  }

  private async snapshot(): Promise<HostBrowserActionResult> {
    const sent = await sendHostBrowserCdp(this.driver, 'Accessibility.getFullAXTree')
    if (!sent.ok) return sent
    const pageUrl = this.driver.getURL()
    const { nodes, truncated } = flattenAxTree(sent.value)
    this.refs.clear()
    this.snapshotUrl = pageUrl
    for (const node of nodes) {
      if (node.backendDOMNodeId !== undefined) {
        this.refs.set(node.ref, { backendDOMNodeId: node.backendDOMNodeId, pageUrl })
      }
    }
    return ok({
      kind: 'snapshot',
      truncated,
      nodes: nodes.map(({ ref, role, name, tag }) => ({ ref, role, name, tag }))
    })
  }

  private async screenshot(): Promise<HostBrowserActionResult> {
    let bytes: Buffer
    try {
      bytes = await this.driver.capturePng()
    } catch {
      return fail('invalid-screenshot', '截图失败。')
    }
    if (!isPng(bytes) || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      return fail('invalid-screenshot', '截图必须是有限大小的 PNG。')
    }
    const viewport = this.driver.getViewportCssSize()
    return ok({
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes,
      ...(viewport && viewport.width >= 1 && viewport.height >= 1
        ? { viewportWidth: viewport.width, viewportHeight: viewport.height }
        : {})
    })
  }

  private async click(ref: string): Promise<HostBrowserActionResult> {
    const target = this.lookupRef(ref)
    if (!target.ok) return target
    const scrolled = await sendHostBrowserCdp(this.driver, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: target.record.backendDOMNodeId
    })
    if (!scrolled.ok) return scrolled
    const quads = await sendHostBrowserCdp(this.driver, 'DOM.getContentQuads', {
      backendNodeId: target.record.backendDOMNodeId
    })
    if (!quads.ok) return quads
    const point = quadCenter(quads.value)
    if (!point) return fail('action-failed', '无法定位页面元素。')
    return this.dispatchClickAt(point.x, point.y)
  }

  /**
   * iframe / 无障碍树截断时模型只能靠截图估点。
   * 坐标是顶层视口 CSS，与 screenshot 同一空间；禁止借此跑 JS。
   */
  private async clickXy(x: number, y: number): Promise<HostBrowserActionResult> {
    return this.dispatchClickAt(x, y)
  }

  /** 合成左键单击并把落点交给 overlay；不读系统指针。 */
  private async dispatchClickAt(x: number, y: number): Promise<HostBrowserActionResult> {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      const dispatched = await sendHostBrowserCdp(this.driver, 'Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: 1
      })
      if (!dispatched.ok) return dispatched
    }
    // viewport 点只给主进程画 overlay；MCP 序列化路径必须剥掉。
    return ok({ kind: 'clicked', viewportX: x, viewportY: y })
  }

  private async type(ref: string, text: string, submit: boolean): Promise<HostBrowserActionResult> {
    const target = this.lookupRef(ref)
    if (!target.ok) return target
    const focused = await sendHostBrowserCdp(this.driver, 'DOM.focus', {
      backendNodeId: target.record.backendDOMNodeId
    })
    if (!focused.ok) return focused
    // 取四边形失败不阻断输入；没有点就无法给 overlay 映射。
    const quads = await sendHostBrowserCdp(this.driver, 'DOM.getContentQuads', {
      backendNodeId: target.record.backendDOMNodeId
    })
    const point = quads.ok ? quadCenter(quads.value) : null
    const inserted = await sendHostBrowserCdp(this.driver, 'Input.insertText', { text })
    if (!inserted.ok) return inserted
    if (submit) {
      for (const type of ['keyDown', 'keyUp'] as const) {
        const key = await sendHostBrowserCdp(this.driver, 'Input.dispatchKeyEvent', {
          type,
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        })
        if (!key.ok) return key
      }
    }
    return ok(point ? { kind: 'typed', viewportX: point.x, viewportY: point.y } : { kind: 'typed' })
  }

  private async scroll(
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number
  ): Promise<HostBrowserActionResult> {
    const delta = amount * 80
    const dispatched = await sendHostBrowserCdp(this.driver, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 1,
      y: 1,
      deltaX: direction === 'left' ? -delta : direction === 'right' ? delta : 0,
      deltaY: direction === 'up' ? -delta : direction === 'down' ? delta : 0
    })
    if (!dispatched.ok) return dispatched
    return ok({ kind: 'scrolled' })
  }

  private lookupRef(
    ref: string
  ):
    | { ok: true; record: SnapshotRefRecord }
    | { ok: false; code: HostBrowserActionErrorCode; message: string } {
    const record = this.refs.get(ref)
    if (!record) return fail('invalid-ref', '页面元素引用无效。')
    if (this.driver.getURL() !== record.pageUrl || this.driver.getURL() !== this.snapshotUrl) {
      this.refs.delete(ref)
      return fail('expired-ref', '页面已变化，元素引用已失效。')
    }
    return { ok: true, record }
  }

  private clearRefs(): void {
    this.refs.clear()
    this.snapshotUrl = ''
  }
}

export function rejectUnparsedHostBrowserAction(raw: unknown): HostBrowserActionResult {
  return classifyParseFailure(raw)
}

function classifyParseFailure(raw: unknown): HostBrowserActionResult {
  const name = isRecord(raw) && typeof raw.name === 'string' ? raw.name : ''
  if (!name || !ACTION_NAME_SET.has(name)) {
    return fail('unknown-action', '不支持该浏览器动作。')
  }
  if (name === 'browser_navigate' || name === 'browser_tabs_open') {
    return fail('invalid-url', '只允许 http(s) 网页地址。')
  }
  if (name === 'browser_click' || name === 'browser_type') {
    return fail('invalid-ref', '页面元素引用无效。')
  }
  if (name === 'browser_click_xy' || name === 'browser_click_at') {
    return fail('invalid-input', '视口坐标无效。')
  }
  return fail('invalid-input', '动作参数无效。')
}

/**
 * 把 CDP AX 树收成 snapshot 清单。
 * 先收 dialog/alertdialog 子树（含无名关闭按钮），再收可交互控件，最后才是其余可见节点。
 * 热搜 link 经常远超 150 上限，所以同属可交互时控件（textbox/button 等）仍压过 link。
 */
function flattenAxTree(value: unknown): {
  nodes: Array<HostBrowserSnapshotNode & { backendDOMNodeId?: number }>
  truncated: boolean
} {
  const rawNodes = isRecord(value) && Array.isArray(value.nodes) ? value.nodes : []
  const records = rawNodes.filter(isRecord)
  const byId = new Map<string, Record<string, unknown>>()
  for (const entry of records) {
    if (typeof entry.nodeId === 'string' && entry.nodeId) {
      byId.set(entry.nodeId, entry)
    }
  }

  const dialogSeen = new Set<Record<string, unknown>>()
  const dialogOrder: Record<string, unknown>[] = []
  for (const entry of records) {
    if (!DIALOG_AX_ROLES.has(axString(entry.role))) continue
    collectDialogSubtree(entry, byId, dialogSeen, dialogOrder, new Set())
  }

  const interactiveControls: Record<string, unknown>[] = []
  const interactiveLinks: Record<string, unknown>[] = []
  const rest: Record<string, unknown>[] = []
  for (const entry of records) {
    if (entry.ignored === true || dialogSeen.has(entry)) continue
    const role = axString(entry.role) || 'generic'
    if (role === 'link') interactiveLinks.push(entry)
    else if (INTERACTIVE_AX_ROLES.has(role)) interactiveControls.push(entry)
    else rest.push(entry)
  }

  const ranked = [...dialogOrder, ...interactiveControls, ...interactiveLinks, ...rest]
  const selected = ranked.slice(0, MAX_SNAPSHOT_NODES)
  let truncated = ranked.length > selected.length
  const nodes = selected.map((entry, index) => {
    const role = axString(entry.role) || 'generic'
    const rawName = axString(entry.name)
    if (rawName.length > MAX_SNAPSHOT_NAME_CHARS) truncated = true
    const backendDOMNodeId =
      typeof entry.backendDOMNodeId === 'number' && Number.isSafeInteger(entry.backendDOMNodeId)
        ? entry.backendDOMNodeId
        : undefined
    return {
      ref: `e${index + 1}`,
      role,
      name: truncateName(rawName),
      tag: role,
      backendDOMNodeId
    }
  })
  if (countVisibleAxNodes(rawNodes) > nodes.length) truncated = true
  return { nodes, truncated }
}

/**
 * 沿 childIds 走弹窗子树。ignored 节点不进清单，但仍继续往下找可见关闭按钮。
 */
function collectDialogSubtree(
  entry: Record<string, unknown>,
  byId: Map<string, Record<string, unknown>>,
  seen: Set<Record<string, unknown>>,
  order: Record<string, unknown>[],
  visiting: Set<string>
): void {
  const id = typeof entry.nodeId === 'string' ? entry.nodeId : ''
  if (id) {
    if (visiting.has(id)) return
    visiting.add(id)
  }
  if (entry.ignored !== true && !seen.has(entry)) {
    seen.add(entry)
    order.push(entry)
  }
  const childIds = Array.isArray(entry.childIds) ? entry.childIds : []
  for (const childId of childIds) {
    if (typeof childId !== 'string') continue
    const child = byId.get(childId)
    if (child) collectDialogSubtree(child, byId, seen, order, visiting)
  }
}

function countVisibleAxNodes(nodes: unknown[]): number {
  let count = 0
  for (const entry of nodes) {
    if (isRecord(entry) && entry.ignored !== true) count += 1
  }
  return count
}

function truncateName(name: string): string {
  return name.length <= MAX_SNAPSHOT_NAME_CHARS ? name : name.slice(0, MAX_SNAPSHOT_NAME_CHARS)
}

function axString(value: unknown): string {
  if (typeof value === 'string') return value
  if (isRecord(value) && typeof value.value === 'string') return value.value
  return ''
}

function quadCenter(value: unknown): { x: number; y: number } | null {
  const quads = isRecord(value) && Array.isArray(value.quads) ? value.quads : []
  const quad = quads[0]
  if (!Array.isArray(quad) || quad.length < 8) return null
  const numbers = quad.slice(0, 8).map((item) => (typeof item === 'number' ? item : Number.NaN))
  if (numbers.some((item) => !Number.isFinite(item))) return null
  const x = (numbers[0]! + numbers[2]! + numbers[4]! + numbers[6]!) / 4
  const y = (numbers[1]! + numbers[3]! + numbers[5]! + numbers[7]!) / 4
  return { x, y }
}

function isPng(bytes: Buffer): boolean {
  return bytes.byteLength >= PNG_MAGIC.byteLength && bytes.subarray(0, 8).equals(PNG_MAGIC)
}

function ok(data: HostBrowserActionData): HostBrowserActionResult {
  return { ok: true, data }
}

function fail(
  code: HostBrowserActionErrorCode,
  message: string
): { ok: false; code: HostBrowserActionErrorCode; message: string } {
  return { ok: false, code, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isHostBrowserActionName(value: string): value is HostBrowserActionName {
  return ACTION_NAME_SET.has(value)
}

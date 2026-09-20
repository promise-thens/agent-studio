import { parseBrowserOrigin } from '../../shared/browser-origin'
import {
  HOST_BROWSER_ACTION_NAMES,
  parseHostBrowserAction,
  type HostBrowserAction,
  type HostBrowserActionName
} from '../../shared/host-browser'
import { readPngPixelSize } from './host-browser-screenshot'

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
/** 打开的下拉/菜单必须压过页面上成片的按钮，否则 option 进不了 150 上限。 */
const POPUP_AX_ROLES = new Set(['option', 'listbox', 'menu', 'menuitem'])

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
  /** 视口 CSS 可点盒；取不到 quad 时省略，节点仍保留。 */
  x?: number
  y?: number
  width?: number
  height?: number
}

export type HostBrowserActionData =
  | { kind: 'navigated'; url: string }
  | {
      kind: 'snapshot'
      nodes: HostBrowserSnapshotNode[]
      truncated: boolean
      viewportWidth?: number
      viewportHeight?: number
    }
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
  /** 内置页视口 CSS 尺寸；截图与 click_xy 必须用同一套。允许异步读取 layoutMetrics。 */
  getViewportCssSize():
    { width: number; height: number } | null | Promise<{ width: number; height: number } | null>
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
  /** 最近一次交给模型的 PNG 像素；click_xy 只允许按这个尺寸折到 CSS，禁止猜 0~1000。 */
  private lastScreenshotPixels: { width: number; height: number } | null = null

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
    const viewport = await this.viewportCssSize()
    const publicNodes = await this.attachSnapshotBoxes(nodes, viewport)
    return ok({
      kind: 'snapshot',
      truncated,
      ...(viewport ? { viewportWidth: viewport.width, viewportHeight: viewport.height } : {}),
      nodes: publicNodes
    })
  }

  /**
   * 给 snapshot 节点补视口 CSS 框，让模型选 ref 而不是猜像素。
   * 点击仍现场取 quad；这里的框只给模型看，过期了也不拿来 dispatch。
   * 单个节点失败就省略框，不能让整张 snapshot 垮掉。
   */
  private async attachSnapshotBoxes(
    nodes: Array<HostBrowserSnapshotNode & { backendDOMNodeId?: number }>,
    viewport: { width: number; height: number } | null
  ): Promise<HostBrowserSnapshotNode[]> {
    const publicNodes: HostBrowserSnapshotNode[] = []
    // CDP 没有批处理 getContentQuads；8 路封顶，避免 150 次全串行把 snapshot 拖成秒级。
    const concurrency = 8
    for (let start = 0; start < nodes.length; start += concurrency) {
      const batch = nodes.slice(start, start + concurrency)
      const boxed = await Promise.all(batch.map((node) => this.boxSnapshotNode(node, viewport)))
      publicNodes.push(...boxed)
    }
    return publicNodes
  }

  private async boxSnapshotNode(
    node: HostBrowserSnapshotNode & { backendDOMNodeId?: number },
    viewport: { width: number; height: number } | null
  ): Promise<HostBrowserSnapshotNode> {
    const publicNode: HostBrowserSnapshotNode = {
      ref: node.ref,
      role: node.role,
      name: node.name,
      tag: node.tag
    }
    if (node.backendDOMNodeId === undefined) return publicNode
    const quads = await sendHostBrowserCdp(this.driver, 'DOM.getContentQuads', {
      backendNodeId: node.backendDOMNodeId
    })
    if (!quads.ok) return publicNode
    const box = resolveHostBrowserClickableBox(quads.value, viewport)
    if (!box) return publicNode
    publicNode.x = box.x
    publicNode.y = box.y
    publicNode.width = box.width
    publicNode.height = box.height
    return publicNode
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
    const viewport = await this.viewportCssSize()
    this.lastScreenshotPixels = readPngPixelSize(bytes) ?? null
    return ok({
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes,
      ...(viewport ? { viewportWidth: viewport.width, viewportHeight: viewport.height } : {})
    })
  }

  private async click(ref: string): Promise<HostBrowserActionResult> {
    const target = this.lookupRef(ref)
    if (!target.ok) return target
    const scrolled = await sendHostBrowserCdp(this.driver, 'DOM.scrollIntoViewIfNeeded', {
      backendNodeId: target.record.backendDOMNodeId
    })
    if (!scrolled.ok) return scrolled
    const viewport = await this.viewportCssSize()
    let point: { x: number; y: number } | null = null
    // 滚动后立刻取 quad 可能还在半路；可见点进视口就停，避免固定 36ms 不够也不要空等。
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(16 * attempt)
      const quads = await sendHostBrowserCdp(this.driver, 'DOM.getContentQuads', {
        backendNodeId: target.record.backendDOMNodeId
      })
      if (!quads.ok) return quads
      point = resolveHostBrowserClickablePoint(quads.value, viewport)
      if (point && isHostBrowserPointInViewport(point, viewport)) break
    }
    if (!point) return fail('action-failed', '无法定位页面元素。')
    return this.dispatchClickAt(point.x, point.y)
  }

  /**
   * iframe / 无障碍树截断时模型只能靠截图估点。
   * 坐标是顶层视口 CSS，与 screenshot 同一空间；禁止借此跑 JS，也禁止猜 0~1000。
   */
  private async clickXy(x: number, y: number): Promise<HostBrowserActionResult> {
    const viewport = await this.viewportCssSize()
    // 坐标点击必须建立在当前 CSS 视口存在的前提上，不能在尺寸未知时猜测落点。
    if (!viewport) return fail('unavailable', '无法读取页面视口。')
    const pixels = this.lastScreenshotPixels
    let targetX = x
    let targetY = y
    // 只在「模型看到的 PNG」和当前 CSS 视口不一致时折算，例如 Retina 漏缩。
    if (
      viewport &&
      pixels &&
      pixels.width > 0 &&
      pixels.height > 0 &&
      (pixels.width !== viewport.width || pixels.height !== viewport.height)
    ) {
      targetX = (x / pixels.width) * viewport.width
      targetY = (y / pixels.height) * viewport.height
    }
    // 视口右边和下边是开区间；越界事件会被浏览器丢到别的层，不能回报成功。
    if (!isHostBrowserPointInViewport({ x: targetX, y: targetY }, viewport)) {
      return fail('invalid-input', '点击坐标超出当前页面视口。')
    }
    return this.dispatchClickAt(targetX, targetY)
  }

  /** 合成左键单击并把落点交给 overlay；不读系统指针。 */
  private async dispatchClickAt(x: number, y: number): Promise<HostBrowserActionResult> {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
      const dispatched = await sendHostBrowserCdp(this.driver, 'Input.dispatchMouseEvent', {
        type,
        x,
        y,
        ...(type === 'mouseMoved'
          ? {}
          : {
              button: 'left',
              buttons: type === 'mousePressed' ? 1 : 0,
              clickCount: 1
            })
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
    const viewport = await this.viewportCssSize()
    const point = quads.ok ? resolveHostBrowserClickablePoint(quads.value, viewport) : null
    if (point && isHostBrowserPointInViewport(point, viewport)) {
      // browser_type 会直接 focus + insertText；补发 mouseMoved 让 Guest 的 hover/指针状态同步到同一落点。
      const moved = await sendHostBrowserCdp(this.driver, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y
      })
      if (!moved.ok) return moved
    }
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
    this.lastScreenshotPixels = null
  }

  /** 统一 await，兼容测试里的同步 getViewportCssSize。 */
  private async viewportCssSize(): Promise<{ width: number; height: number } | null> {
    const viewport = await this.driver.getViewportCssSize()
    if (!viewport || viewport.width < 1 || viewport.height < 1) return null
    return viewport
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
 * 热搜 link 经常远超上限，所以同属可交互时控件（textbox/button 等）仍压过 link。
 * 有可交互节点时不再用 generic rest 把名额填满，减少模型读树时间。
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

  const popupControls: Record<string, unknown>[] = []
  const interactiveControls: Record<string, unknown>[] = []
  const interactiveLinks: Record<string, unknown>[] = []
  const rest: Record<string, unknown>[] = []
  for (const entry of records) {
    if (entry.ignored === true || dialogSeen.has(entry)) continue
    const role = axString(entry.role) || 'generic'
    if (POPUP_AX_ROLES.has(role)) popupControls.push(entry)
    else if (role === 'link') interactiveLinks.push(entry)
    else if (INTERACTIVE_AX_ROLES.has(role)) interactiveControls.push(entry)
    else rest.push(entry)
  }

  // 不把 generic 文本节点填满 150：模型读树会变慢。没有可交互节点时才退回 rest。
  const preferred = [...dialogOrder, ...popupControls, ...interactiveControls, ...interactiveLinks]
  const ranked = preferred.length > 0 ? preferred : rest
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

type HostBrowserQuadBox = { minX: number; minY: number; maxX: number; maxY: number }

function parseHostBrowserQuadBoxes(value: unknown): HostBrowserQuadBox[] {
  const quads = isRecord(value) && Array.isArray(value.quads) ? value.quads : []
  const boxes: HostBrowserQuadBox[] = []
  for (const quad of quads) {
    if (!Array.isArray(quad) || quad.length < 8) continue
    const numbers = quad.slice(0, 8).map((item) => (typeof item === 'number' ? item : Number.NaN))
    if (numbers.some((item) => !Number.isFinite(item))) continue
    const xs = [numbers[0]!, numbers[2]!, numbers[4]!, numbers[6]!]
    const ys = [numbers[1]!, numbers[3]!, numbers[5]!, numbers[7]!]
    boxes.push({
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys)
    })
  }
  return boxes
}

function intersectHostBrowserQuadBox(
  box: HostBrowserQuadBox,
  viewport: HostBrowserQuadBox
): HostBrowserQuadBox | null {
  const minX = Math.max(box.minX, viewport.minX)
  const minY = Math.max(box.minY, viewport.minY)
  const maxX = Math.min(box.maxX, viewport.maxX)
  const maxY = Math.min(box.maxY, viewport.maxY)
  if (maxX - minX < 2 || maxY - minY < 2) return null
  return { minX, minY, maxX, maxY }
}

function hostBrowserQuadBoxCenter(box: HostBrowserQuadBox): { x: number; y: number } {
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
}

function hostBrowserQuadBoxArea(box: HostBrowserQuadBox): number {
  return Math.max(0, box.maxX - box.minX) * Math.max(0, box.maxY - box.minY)
}

/**
 * 从 content quads 选出真正可点的 CSS 点。
 * 不用最大面积：侧栏父级外壳中心会落在两项夹缝。优先第一个足够小的可见盒。
 */
function pickHostBrowserClickableBox(
  value: unknown,
  viewport?: { width: number; height: number } | null
): HostBrowserQuadBox | null {
  const boxes = parseHostBrowserQuadBoxes(value)
  if (boxes.length === 0) return null
  const view: HostBrowserQuadBox | null =
    viewport && viewport.width > 0 && viewport.height > 0
      ? { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height }
      : null

  const visible: HostBrowserQuadBox[] = []
  for (const box of boxes) {
    const vis = view ? intersectHostBrowserQuadBox(box, view) : box
    if (vis) visible.push(vis)
  }
  if (visible.length === 0) return boxes[0]!

  const viewportArea = view ? hostBrowserQuadBoxArea(view) : Number.POSITIVE_INFINITY
  const compact = visible.filter((box) => hostBrowserQuadBoxArea(box) <= viewportArea * 0.45)
  return (compact.length > 0 ? compact : visible)[0]!
}

/** snapshot 给模型看的可点盒；和 click(ref) 用同一套选取规则。 */
export function resolveHostBrowserClickableBox(
  value: unknown,
  viewport?: { width: number; height: number } | null
): { x: number; y: number; width: number; height: number } | null {
  const chosen = pickHostBrowserClickableBox(value, viewport)
  if (!chosen) return null
  return {
    x: roundCss(chosen.minX),
    y: roundCss(chosen.minY),
    width: roundCss(chosen.maxX - chosen.minX),
    height: roundCss(chosen.maxY - chosen.minY)
  }
}

export function resolveHostBrowserClickablePoint(
  value: unknown,
  viewport?: { width: number; height: number } | null
): { x: number; y: number } | null {
  const chosen = pickHostBrowserClickableBox(value, viewport)
  if (!chosen) return null
  return hostBrowserQuadBoxCenter(chosen)
}

function roundCss(value: number): number {
  return Math.round(value)
}

export function isHostBrowserPointInViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number } | null
): boolean {
  if (!viewport) return true
  return point.x >= 0 && point.y >= 0 && point.x < viewport.width && point.y < viewport.height
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

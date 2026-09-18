/**
 * 通用 Agent 指针 overlay 协议（宿主页 / 插件 / 未来 Computer Use 共用底座）。
 *
 * pointer 的 x/y 必须已是 overlay 窗口本地 DIP；Renderer 只 translate，不再换算。
 * 本波 host-browser 与配套扩展 browser-plugin 可写入已映射 overlay DIP；
 * 货架 chrome-devtools 仍走 ACP 通道剥离；computer-use 仅类型预留。
 */

/** Overlay 坐标来源；computer-use 本波无任何 producer。 */
export type AgentPointerSurface = 'host-browser' | 'browser-plugin' | 'computer-use'

/** 允许本波 create 的 surface；故意排除 computer-use，避免无 Helper 时伪造指针。 */
export type AgentPointerProducerSurface = 'host-browser' | 'browser-plugin'

export interface AgentPointer {
  x: number
  y: number
}

export interface AgentPointerBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Overlay / HUD 共用快照。pointer 缺省表示映射失败或该 surface 禁止投影。
 * persistWhenUnfocused=false：主窗口失焦须立刻清针，避免 alwaysOnTop 留在别的 App 上。
 */
export interface AgentPointerSnapshot {
  visible: boolean
  surface: AgentPointerSurface
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: AgentPointer
  persistWhenUnfocused: boolean
}

export const HOST_BROWSER_HUD_COPY = 'Grok 正在使用内置浏览器'
export const BROWSER_PLUGIN_HUD_COPY = 'Grok 正在使用浏览器插件'

const MAX_OVERLAY_ID_BYTES = 256

/**
 * 宿主与配套扩展闲置针都只画光标：必须有可停止的 execution 三元组才算进行中。
 * 禁止 visible + browser-plugin 且无三元组冒充 ACP 插件 HUD / 停止芯片。
 */
export function isAgentPointerTurnActive(snapshot: {
  visible: boolean
  surface: AgentPointerSurface
  taskId?: string
  turnId?: string
  executionId?: string
}): boolean {
  if (!snapshot.visible) return false
  if (snapshot.surface === 'computer-use') return false
  return Boolean(snapshot.executionId && snapshot.taskId && snapshot.turnId)
}

/**
 * 接管文案优先；进行中才出 surface 专属停止句。
 * 宿主 Turn 结束后可留闲置光标（turnActive=false）但不挂芯片。
 */
export function resolveAgentPointerHudCopy(input: {
  surface: AgentPointerSurface
  overlayVisible: boolean
  turnActive: boolean
  takeoverCopy: string | null
}): string | null {
  if (input.takeoverCopy) return input.takeoverCopy
  if (!input.overlayVisible || !input.turnActive) return null
  if (input.surface === 'host-browser') return HOST_BROWSER_HUD_COPY
  if (input.surface === 'browser-plugin') return BROWSER_PLUGIN_HUD_COPY
  // computer-use：本波不出现 HUD
  return null
}

/**
 * 把宿主 WebContentsView 内的 viewport CSS 点映射为 overlay 本地 DIP。
 * zoom 非有限或 <=0、坐标非有限、落在 view 的 overlay 矩形外 → undefined（不得发明光标）。
 */
export function mapViewportCssToOverlayDip(input: {
  cssX: number
  cssY: number
  zoomFactor: number
  contentBounds: AgentPointerBounds
  viewBounds: AgentPointerBounds
  overlayBounds: AgentPointerBounds
}): AgentPointer | undefined {
  const { zoomFactor, cssX, cssY } = input
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return undefined
  if (!Number.isFinite(cssX) || !Number.isFinite(cssY)) return undefined

  const screenX = input.contentBounds.x + input.viewBounds.x + cssX / zoomFactor
  const screenY = input.contentBounds.y + input.viewBounds.y + cssY / zoomFactor
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return undefined

  const overlayX = screenX - input.overlayBounds.x
  const overlayY = screenY - input.overlayBounds.y
  if (!Number.isFinite(overlayX) || !Number.isFinite(overlayY)) return undefined

  // view 在 overlay 坐标系下的矩形；点必须落在此矩形内才可画针
  const viewOverlayX = input.contentBounds.x + input.viewBounds.x - input.overlayBounds.x
  const viewOverlayY = input.contentBounds.y + input.viewBounds.y - input.overlayBounds.y
  const viewRight = viewOverlayX + input.viewBounds.width
  const viewBottom = viewOverlayY + input.viewBounds.height
  if (
    !Number.isFinite(viewOverlayX) ||
    !Number.isFinite(viewOverlayY) ||
    !Number.isFinite(viewRight) ||
    !Number.isFinite(viewBottom)
  ) {
    return undefined
  }
  if (
    overlayX < viewOverlayX ||
    overlayY < viewOverlayY ||
    overlayX > viewRight ||
    overlayY > viewBottom
  ) {
    return undefined
  }

  return { x: overlayX, y: overlayY }
}

function intersectionArea(left: AgentPointerBounds, right: AgentPointerBounds): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

function centerDistanceSquared(left: AgentPointerBounds, right: AgentPointerBounds): number {
  const dx = left.x + left.width / 2 - (right.x + right.width / 2)
  const dy = left.y + left.height / 2 - (right.y + right.height / 2)
  return dx * dx + dy * dy
}

function isUsableOverlayBounds(value: AgentPointerBounds): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.width >= 1 &&
    value.height >= 1
  )
}

/**
 * 选主窗交集最大的那块屏覆盖 overlay。
 * 无交集时用中心距，避免窗口拖到副屏后光标仍钉在主屏。
 */
export function resolveOverlayDisplayBounds(input: {
  windowBounds: AgentPointerBounds
  displays: readonly AgentPointerBounds[]
}): AgentPointerBounds | undefined {
  const usable = input.displays.filter(isUsableOverlayBounds)
  if (usable.length === 0 || !isUsableOverlayBounds(input.windowBounds)) return undefined

  let best = usable[0]!
  let bestArea = intersectionArea(input.windowBounds, best)
  let bestDistance = centerDistanceSquared(input.windowBounds, best)
  for (const display of usable.slice(1)) {
    const area = intersectionArea(input.windowBounds, display)
    const distance = centerDistanceSquared(input.windowBounds, display)
    if (area > bestArea || (area === 0 && bestArea === 0 && distance < bestDistance)) {
      best = display
      bestArea = area
      bestDistance = distance
    }
  }
  return best
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function readOverlayId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() !== '' &&
    !value.includes('\0') &&
    value.length <= MAX_OVERLAY_ID_BYTES
    ? value
    : undefined
}

function readFinitePointer(value: unknown): AgentPointer | undefined {
  if (!isPlainRecord(value)) return undefined
  const { x, y } = value
  if (typeof x !== 'number' || typeof y !== 'number') return undefined
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
  return { x, y }
}

/**
 * 构造可序列化指针快照。host-browser 与配套扩展 browser-plugin 只保留有限 DIP；
 * 入参 surface 不含 computer-use，防止本波无 Helper 时伪造该来源。
 */
export function createAgentPointerSnapshot(input: {
  visible: boolean
  surface: AgentPointerProducerSurface
  persistWhenUnfocused?: boolean
  taskId?: string
  turnId?: string
  executionId?: string
  pointer?: AgentPointer
}): AgentPointerSnapshot {
  const snapshot: AgentPointerSnapshot = {
    visible: input.visible,
    surface: input.surface,
    persistWhenUnfocused: input.persistWhenUnfocused === true
  }
  if (input.taskId) snapshot.taskId = input.taskId
  if (input.turnId) snapshot.turnId = input.turnId
  if (input.executionId) snapshot.executionId = input.executionId

  // 无几何不得发明光标；货架 ACP 通道另有剥离，不在这里一刀切丢弃配套扩展针
  if (input.surface === 'host-browser' || input.surface === 'browser-plugin') {
    const pointer = readFinitePointer(input.pointer)
    if (pointer) snapshot.pointer = pointer
  }

  return snapshot
}

/**
 * Preload / overlay 再校验快照：丢掉私有键。
 * host-browser 与配套扩展有限 pointer 可保留；无几何仍丢弃；computer-use 本波拒收。
 */
export function parseAgentPointerSnapshot(value: unknown): AgentPointerSnapshot | null {
  if (!isPlainRecord(value) || (value.visible !== true && value.visible !== false)) return null
  const surface = value.surface
  if (surface !== 'host-browser' && surface !== 'browser-plugin') return null
  if (value.persistWhenUnfocused !== true && value.persistWhenUnfocused !== false) return null

  return createAgentPointerSnapshot({
    visible: value.visible,
    surface,
    persistWhenUnfocused: value.persistWhenUnfocused,
    taskId: readOverlayId(value.taskId),
    turnId: readOverlayId(value.turnId),
    executionId: readOverlayId(value.executionId),
    pointer: value.pointer !== undefined ? readFinitePointer(value.pointer) : undefined
  })
}

/** 无 pointer 时不得在 overlay DOM 留下移动光标节点；配套扩展有限 DIP 与宿主页一样可画。 */
export function shouldRenderAgentPointerCursor(snapshot: AgentPointerSnapshot): boolean {
  return (
    snapshot.visible === true &&
    snapshot.pointer != null &&
    (snapshot.surface === 'host-browser' || snapshot.surface === 'browser-plugin')
  )
}

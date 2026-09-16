import { describe, expect, it } from 'vitest'
import { parseHostBrowserAction } from '../../shared/host-browser'
import {
  HostBrowserActionEngine,
  sendHostBrowserCdp,
  type HostBrowserActionDriver
} from './host-browser-actions'

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function axNode(
  nodeId: string,
  options: {
    ignored?: boolean
    role?: string
    name?: string
    backendDOMNodeId?: number
    childIds?: string[]
  } = {}
): Record<string, unknown> {
  return {
    nodeId,
    ignored: options.ignored === true,
    role: { type: 'role', value: options.role ?? 'generic' },
    name: { type: 'computedString', value: options.name ?? '' },
    backendDOMNodeId: options.backendDOMNodeId ?? Number(nodeId),
    ...(options.childIds ? { childIds: options.childIds } : {})
  }
}

function createDriver(
  options: {
    url?: string
    axNodes?: Record<string, unknown>[]
    png?: Buffer
  } = {}
): HostBrowserActionDriver & {
  loaded: string[]
  cdpMethods: string[]
  setUrl(url: string): void
} {
  let url = options.url ?? 'about:blank'
  const loaded: string[] = []
  const cdpMethods: string[] = []
  const axNodes = options.axNodes ?? [
    axNode('1', { role: 'button', name: 'More information', backendDOMNodeId: 11 })
  ]
  return {
    loaded,
    cdpMethods,
    setUrl(next) {
      url = next
    },
    getURL() {
      return url
    },
    getTitle() {
      return url === 'about:blank' ? '' : 'Example'
    },
    async loadURL(next) {
      loaded.push(next)
      url = next
    },
    async goBack() {
      return false
    },
    async goForward() {
      return false
    },
    async reload() {
      return undefined
    },
    async capturePng() {
      return options.png ?? Buffer.concat([PNG_HEADER, Buffer.from('page')])
    },
    async sendCdp(method, params) {
      void params
      cdpMethods.push(method)
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes }
      if (method === 'DOM.getContentQuads') return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] }
      if (
        method === 'DOM.focus' ||
        method === 'DOM.scrollIntoViewIfNeeded' ||
        method === 'Input.dispatchMouseEvent' ||
        method === 'Input.dispatchKeyEvent' ||
        method === 'Input.insertText'
      ) {
        return {}
      }
      throw new Error(`未允许的 CDP：${method}`)
    }
  }
}

describe('parseHostBrowserAction', () => {
  it('未知动作名拒绝，不把它当成 navigate', () => {
    expect(parseHostBrowserAction({ name: 'evaluate', arguments: { expression: '1' } })).toBeNull()
    expect(parseHostBrowserAction({ name: 'Runtime.evaluate' })).toBeNull()
    expect(
      parseHostBrowserAction({
        name: 'browser_navigate',
        arguments: { url: 'javascript:alert(1)' }
      })
    ).toBeNull()
  })

  it('只接受白名单工具名和有限参数', () => {
    expect(
      parseHostBrowserAction({
        name: 'browser_navigate',
        arguments: { url: 'https://example.com/docs' }
      })
    ).toEqual({
      name: 'browser_navigate',
      url: 'https://example.com/docs'
    })
    expect(parseHostBrowserAction({ name: 'browser_click', arguments: { ref: 'e1' } })).toEqual({
      name: 'browser_click',
      ref: 'e1'
    })
    expect(
      parseHostBrowserAction({
        name: 'browser_type',
        arguments: { ref: 'e1', text: 'hello', submit: true }
      })
    ).toEqual({
      name: 'browser_type',
      ref: 'e1',
      text: 'hello',
      submit: true
    })
    expect(
      parseHostBrowserAction({
        name: 'browser_scroll',
        arguments: { direction: 'down', amount: 4 }
      })
    ).toEqual({
      name: 'browser_scroll',
      direction: 'down',
      amount: 4
    })
  })
})

describe('sendHostBrowserCdp', () => {
  it('未列出的 CDP 方法不得发到 guest，也不回传原始结果', async () => {
    const driver = createDriver()
    const result = await sendHostBrowserCdp(driver, 'Runtime.evaluate', {
      expression: 'document.cookie'
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('unsupported-cdp')
    expect(JSON.stringify(result)).not.toContain('document.cookie')
    expect(driver.cdpMethods).toEqual([])
  })
})

describe('HostBrowserActionEngine', () => {
  it('未知动作与 javascript: 导航都不得 loadURL', async () => {
    const driver = createDriver()
    const engine = new HostBrowserActionEngine(driver)
    const unknown = await engine.perform({ name: 'evaluate_script' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.code).toBe('unknown-action')
    const scripted = await engine.perform({
      name: 'browser_navigate',
      arguments: { url: 'javascript:alert(1)' }
    })
    expect(scripted.ok).toBe(false)
    if (!scripted.ok) expect(scripted.code).toBe('invalid-url')
    expect(driver.loaded).toEqual([])
  })

  it('click 的 ref 必须来自最近一次 snapshot，离开页面即失效', async () => {
    const driver = createDriver({ url: 'https://example.com/' })
    const engine = new HostBrowserActionEngine(driver)
    const missing = await engine.perform({ name: 'browser_click', arguments: { ref: 'e1' } })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('invalid-ref')

    const snapshot = await engine.perform({ name: 'browser_snapshot' })
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok || snapshot.data.kind !== 'snapshot') throw new Error('需要 snapshot')
    const ref = snapshot.data.nodes[0]?.ref
    expect(ref).toBe('e1')

    driver.setUrl('https://example.com/other')
    const expired = await engine.perform({ name: 'browser_click', arguments: { ref } })
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.code).toBe('expired-ref')
    expect(driver.cdpMethods.filter((method) => method.startsWith('Input.'))).toEqual([])
  })

  it('snapshot 超长截断，不把忽略节点或超长 name 原样送出', async () => {
    const nodes = [
      axNode('0', { ignored: true, name: 'x'.repeat(4000) }),
      ...Array.from({ length: 180 }, (_, index) =>
        axNode(String(index + 1), {
          role: 'link',
          name: `item-${index + 1}-${'n'.repeat(300)}`,
          backendDOMNodeId: index + 10
        })
      )
    ]
    const engine = new HostBrowserActionEngine(
      createDriver({ url: 'https://example.com/', axNodes: nodes })
    )
    const snapshot = await engine.perform({ name: 'browser_snapshot' })
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok || snapshot.data.kind !== 'snapshot') throw new Error('需要 snapshot')
    expect(snapshot.data.truncated).toBe(true)
    expect(snapshot.data.nodes).toHaveLength(150)
    expect(snapshot.data.nodes[0]?.name.length).toBeLessThanOrEqual(200)
    expect(snapshot.data.nodes.some((node) => node.name.length > 200)).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('x'.repeat(4000))
  })

  it('热搜 link 占满名额时仍保留末尾搜索框', async () => {
    const nodes = [
      ...Array.from({ length: 200 }, (_, index) =>
        axNode(String(index + 1), {
          role: 'link',
          name: `热搜${index + 1}`,
          backendDOMNodeId: index + 10
        })
      ),
      axNode('201', { role: 'textbox', name: '搜索', backendDOMNodeId: 999 })
    ]
    const snapshot = await new HostBrowserActionEngine(
      createDriver({ url: 'https://example.com/', axNodes: nodes })
    ).perform({ name: 'browser_snapshot' })
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok || snapshot.data.kind !== 'snapshot') throw new Error('需要 snapshot')
    expect(snapshot.data.truncated).toBe(true)
    expect(snapshot.data.nodes.length).toBeLessThanOrEqual(150)
    expect(
      snapshot.data.nodes.some((node) => node.role === 'textbox' && node.name === '搜索')
    ).toBe(true)
  })

  it('alertdialog 子树里的无名 button 排在清单前部', async () => {
    const nodes = [
      ...Array.from({ length: 40 }, (_, index) =>
        axNode(`nav-${index}`, { role: 'link', name: `热搜${index + 1}` })
      ),
      axNode('dlg', { role: 'alertdialog', name: '提示', childIds: ['close'] }),
      axNode('close', { role: 'button', name: '', backendDOMNodeId: 9001 })
    ]
    const snapshot = await new HostBrowserActionEngine(
      createDriver({ url: 'https://example.com/', axNodes: nodes })
    ).perform({ name: 'browser_snapshot' })
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok || snapshot.data.kind !== 'snapshot') throw new Error('需要 snapshot')
    const buttonIndex = snapshot.data.nodes.findIndex(
      (node) => node.role === 'button' && node.name === ''
    )
    expect(buttonIndex).toBeGreaterThanOrEqual(0)
    expect(buttonIndex).toBeLessThan(2)
  })

  it('screenshot 只接受 png 魔数，拒绝 jpeg 伪装', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const rejected = await new HostBrowserActionEngine(
      createDriver({ url: 'https://example.com/', png: jpeg })
    ).perform({ name: 'browser_screenshot' })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('invalid-screenshot')

    const accepted = await new HostBrowserActionEngine(
      createDriver({ url: 'https://example.com/' })
    ).perform({ name: 'browser_screenshot' })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok || accepted.data.kind !== 'screenshot') throw new Error('需要 screenshot')
    expect(accepted.data.mimeType).toBe('image/png')
    expect(accepted.data.bytes.subarray(0, 8).equals(PNG_HEADER)).toBe(true)
  })

  it('合法 click 只走白名单 CDP，不调用 evaluate', async () => {
    const driver = createDriver({ url: 'https://example.com/' })
    const engine = new HostBrowserActionEngine(driver)
    const snapshot = await engine.perform({ name: 'browser_snapshot' })
    if (!snapshot.ok || snapshot.data.kind !== 'snapshot') throw new Error('需要 snapshot')
    const clicked = await engine.perform({
      name: 'browser_click',
      arguments: { ref: snapshot.data.nodes[0]?.ref }
    })
    expect(clicked.ok).toBe(true)
    expect(driver.cdpMethods).not.toContain('Runtime.evaluate')
    expect(driver.cdpMethods).toContain('Input.dispatchMouseEvent')
  })

  it('click 成功后主进程结果带 viewport 点', async () => {
    const driver = createDriver({ url: 'https://example.com/' })
    const engine = new HostBrowserActionEngine(driver)
    const snapshot = await engine.perform({ name: 'browser_snapshot' })
    if (!snapshot.ok || snapshot.data.kind !== 'snapshot') throw new Error('需要 snapshot')
    const clicked = await engine.perform({
      name: 'browser_click',
      arguments: { ref: snapshot.data.nodes[0]?.ref }
    })
    expect(clicked.ok).toBe(true)
    if (!clicked.ok || clicked.data.kind !== 'clicked') throw new Error('需要 clicked')
    expect(clicked.data.viewportX).toBe(10)
    expect(clicked.data.viewportY).toBe(10)
  })

  it('navigate 只 load http(s)；type 成功也不回写输入明文', async () => {
    const driver = createDriver()
    const engine = new HostBrowserActionEngine(driver)
    const navigated = await engine.perform({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/docs' }
    })
    expect(navigated.ok).toBe(true)
    expect(driver.loaded).toEqual(['https://example.com/docs'])

    const snapshot = await engine.perform({ name: 'browser_snapshot' })
    if (!snapshot.ok || snapshot.data.kind !== 'snapshot') throw new Error('需要 snapshot')
    const typed = await engine.perform({
      name: 'browser_type',
      arguments: { ref: snapshot.data.nodes[0]?.ref, text: 's3cret-token', submit: true }
    })
    expect(typed.ok).toBe(true)
    if (!typed.ok || typed.data.kind !== 'typed') throw new Error('需要 typed')
    expect(typed.data.viewportX).toBe(10)
    expect(typed.data.viewportY).toBe(10)
    expect(JSON.stringify(typed)).not.toContain('s3cret-token')
    expect(driver.cdpMethods).toContain('Input.insertText')
    expect(driver.cdpMethods).toContain('Input.dispatchKeyEvent')
  })
})

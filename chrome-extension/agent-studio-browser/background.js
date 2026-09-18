const COOKIE_SYNC_INTERVAL_MS = 30_000
const SNAPSHOT_INTERVAL_MS = 2_000
const MAX_COOKIES = 500

let port = null
let connected = false
let requestSeq = 0
let cookieTimer = 0
let snapshotTimer = 0

function nextId() {
  requestSeq += 1
  return `ext-${requestSeq}`
}

function setConnected(next) {
  connected = next === true
}

function connectNative() {
  if (port) return
  try {
    port = chrome.runtime.connectNative('com.agentstudio.browser')
  } catch {
    port = null
    setConnected(false)
    return
  }
  setConnected(true)
  port.onMessage.addListener(() => {
    setConnected(true)
  })
  port.onDisconnect.addListener(() => {
    port = null
    setConnected(false)
  })
}

function post(command, payload) {
  connectNative()
  if (!port) return
  const message = { id: nextId(), command }
  if (payload !== undefined) message.payload = payload
  try {
    port.postMessage(message)
  } catch {
    port = null
    setConnected(false)
  }
}

function mapSameSite(value) {
  if (value === 'no_restriction' || value === 'lax' || value === 'strict') return value
  return undefined
}

async function syncCookies() {
  const cookies = await chrome.cookies.getAll({})
  post('cookies.sync', {
    cookies: cookies.slice(0, MAX_COOKIES).map((cookie) => {
      const item = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure === true,
        httpOnly: cookie.httpOnly === true
      }
      if (typeof cookie.expirationDate === 'number') item.expirationDate = cookie.expirationDate
      const sameSite = mapSameSite(cookie.sameSite)
      if (sameSite) item.sameSite = sameSite
      return item
    })
  })
}

async function snapshotActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id || tab.windowId == null) {
    post('tabs.snapshot', {})
    return
  }
  let windowScreenBounds
  try {
    const win = await chrome.windows.get(tab.windowId)
    if (typeof win.left === 'number' && typeof win.top === 'number') {
      windowScreenBounds = {
        x: win.left,
        y: win.top,
        width: win.width ?? 0,
        height: win.height ?? 0
      }
    }
  } catch {
    windowScreenBounds = undefined
  }
  let zoom = 1
  try {
    zoom = await chrome.tabs.getZoom(tab.id)
  } catch {
    zoom = 1
  }
  let dpr
  let nodes
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const rect = document.activeElement?.getBoundingClientRect()
        return {
          dpr: window.devicePixelRatio,
          node: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
        }
      }
    })
    const value = injected[0]?.result
    if (value && typeof value.dpr === 'number') dpr = value.dpr
    if (value?.node) nodes = [value.node]
  } catch {
    // chrome:// 等页面没有几何，不得发明节点
  }
  const payload = {}
  if (windowScreenBounds) payload.windowScreenBounds = windowScreenBounds
  if (typeof dpr === 'number') payload.dpr = dpr
  if (typeof zoom === 'number') payload.zoom = zoom
  if (nodes) payload.nodes = nodes
  post('tabs.snapshot', payload)
}

function startLoops() {
  connectNative()
  void syncCookies()
  void snapshotActiveTab()
  if (!cookieTimer) {
    cookieTimer = setInterval(() => {
      void syncCookies()
    }, COOKIE_SYNC_INTERVAL_MS)
  }
  if (!snapshotTimer) {
    snapshotTimer = setInterval(() => {
      void snapshotActiveTab()
    }, SNAPSHOT_INTERVAL_MS)
  }
}

chrome.runtime.onInstalled.addListener(startLoops)
chrome.runtime.onStartup.addListener(startLoops)
chrome.cookies.onChanged.addListener(() => {
  void syncCookies()
})
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'get-status') {
    sendResponse({ connected })
    return true
  }
  return false
})

startLoops()

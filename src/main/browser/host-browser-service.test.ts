import { describe, expect, it, vi } from 'vitest'
import type { HostBrowserBounds } from '../../shared/host-browser'
import { HostBrowserService, type HostBrowserGuest } from './host-browser-service'

function createFakeGuest(projectId: string): HostBrowserGuest & {
  destroyed: boolean
  bounds: HostBrowserBounds | null
  attachedListeners: Array<() => void>
} {
  let url = 'about:blank'
  let title = ''
  const loading = false
  const guest = {
    projectId,
    destroyed: false,
    bounds: null as HostBrowserBounds | null,
    attachedListeners: [] as Array<() => void>,
    loadURL(next: string) {
      url = next
      title = next
      for (const listener of guest.attachedListeners) listener()
    },
    getURL() {
      return url
    },
    getTitle() {
      return title
    },
    isLoading() {
      return loading
    },
    setBounds(bounds: HostBrowserBounds) {
      guest.bounds = bounds
    },
    destroy() {
      guest.destroyed = true
    },
    onChromeChanged(listener: () => void) {
      guest.attachedListeners.push(listener)
    },
    createActionDriver() {
      return {
        getURL: () => guest.getURL(),
        getTitle: () => guest.getTitle(),
        loadURL: async (next: string) => {
          guest.loadURL(next)
        },
        goBack: async () => false,
        goForward: async () => false,
        reload: async () => undefined,
        capturePng: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        sendCdp: async () => ({ nodes: [] })
      }
    }
  }
  return guest
}

describe('HostBrowserService', () => {
  it('按 projectId 隔离 guest，切项目时销毁旧视图', () => {
    const created: HostBrowserGuest[] = []
    const service = new HostBrowserService({
      createGuest: (projectId) => {
        const guest = createFakeGuest(projectId)
        created.push(guest)
        return guest
      },
      attachGuest: vi.fn(),
      detachGuest: vi.fn()
    })

    service.userNavigate('task-1', 'project-a', 'https://example.com')
    service.userNavigate('task-2', 'project-b', 'https://example.org')

    expect(created).toHaveLength(2)
    expect(created[0]?.projectId).toBe('project-a')
    expect((created[0] as ReturnType<typeof createFakeGuest>).destroyed).toBe(true)
    expect(created[1]?.projectId).toBe('project-b')
    expect(created[1]?.getURL()).toBe('https://example.org/')
  })

  it('同一项目复用 guest，javascript: 不得 loadURL', () => {
    const created: HostBrowserGuest[] = []
    const service = new HostBrowserService({
      createGuest: (projectId) => {
        const guest = createFakeGuest(projectId)
        created.push(guest)
        return guest
      },
      attachGuest: vi.fn(),
      detachGuest: vi.fn()
    })

    service.userNavigate('task-1', 'project-a', 'https://example.com/docs')
    service.userNavigate('task-1', 'project-a', 'https://example.com/about')
    expect(created).toHaveLength(1)
    expect(() => service.userNavigate('task-1', 'project-a', 'javascript:alert(1)')).toThrow(
      /只允许 http/
    )
    expect(created[0]?.getURL()).toBe('https://example.com/about')
  })

  it('关闭右栏只 detach，不销毁；有 bounds 后才挂到窗口', () => {
    const attachGuest = vi.fn()
    const detachGuest = vi.fn()
    const guest = createFakeGuest('project-a')
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest,
      detachGuest
    })

    service.userNavigate('task-1', 'project-a', 'https://example.com')
    expect(attachGuest).not.toHaveBeenCalled()
    expect(service.getChrome().open).toBe(true)

    service.updateBounds({ x: 100, y: 40, width: 480, height: 720 })
    expect(attachGuest).toHaveBeenCalledTimes(1)
    expect(guest.bounds).toEqual({ x: 100, y: 40, width: 480, height: 720 })

    const chrome = service.setOpen('task-1', 'project-a', false)
    expect(chrome.open).toBe(false)
    expect(detachGuest).toHaveBeenCalledTimes(1)
    expect(guest.destroyed).toBe(false)
  })

  it('perform 先过 Broker：拒绝时不得 loadURL', async () => {
    const guest = createFakeGuest('project-a')
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: vi.fn(),
      detachGuest: vi.fn(),
      resolvePerformContext: () => ({
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-a',
        environmentId: 'env-a',
        executionRoot: process.cwd()
      }),
      authorizeOperation: async () => ({ ok: false, reason: 'user-denied' })
    })

    const result = await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com' }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('denied')
    expect(guest.getURL()).toBe('about:blank')
  })

  it('perform 允许后才导航，并且打开右栏', async () => {
    const guest = createFakeGuest('project-a')
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: vi.fn(),
      detachGuest: vi.fn(),
      resolvePerformContext: () => ({
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-a',
        environmentId: 'env-a',
        executionRoot: process.cwd()
      }),
      authorizeOperation: async (_intent, execute) => ({
        ok: true,
        value: await execute(_intent as never),
        reason: 'user-allowed',
        scope: 'once'
      })
    })

    const result = await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/docs' }
    })
    expect(result.ok).toBe(true)
    expect(guest.getURL()).toBe('https://example.com/docs')
    expect(service.getChrome().open).toBe(true)
  })

  it('授权意图按 origin 绑定，fingerprint 不含动作名以便 task grant 复用 click', async () => {
    const guest = createFakeGuest('project-a')
    const intents: Array<{ targets: unknown; fingerprint: string; type: string }> = []
    const service = new HostBrowserService({
      createGuest: () => guest,
      attachGuest: vi.fn(),
      detachGuest: vi.fn(),
      resolvePerformContext: () => ({
        taskId: 'task-1',
        turnId: 'turn-1',
        projectId: 'project-a',
        environmentId: 'env-a',
        executionRoot: process.cwd()
      }),
      authorizeOperation: async (intent, execute) => {
        intents.push({
          targets: intent.targets,
          fingerprint: intent.parameterFingerprint,
          type: intent.operationType
        })
        return {
          ok: true,
          value: await execute(intent as never),
          reason: 'user-allowed',
          scope: 'task'
        }
      }
    })

    await service.perform('task-1', {
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/docs' }
    })
    await service.perform('task-1', { name: 'browser_snapshot' })

    expect(intents).toHaveLength(2)
    expect(intents[0]).toEqual({
      type: 'browser',
      fingerprint: 'host-browser:origin:v1',
      targets: [{ kind: 'origin', value: 'https://example.com' }]
    })
    expect(intents[1]).toEqual({
      type: 'browser',
      fingerprint: 'host-browser:origin:v1',
      targets: [{ kind: 'origin', value: 'https://example.com' }]
    })
  })
})

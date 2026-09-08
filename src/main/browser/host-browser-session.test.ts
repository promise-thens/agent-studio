import { describe, it, expect } from 'vitest'
import { createBrowserPartition, createBrowserWebPreferences } from './host-browser-session'

describe('HostBrowserSession', () => {
  it('应当隔离 partition，不同的 projectId 产生不同的 partition', () => {
    expect(createBrowserPartition('proj-1')).toBe('persist:as-browser:proj-1')
    expect(createBrowserPartition('proj-2')).toBe('persist:as-browser:proj-2')
    expect(createBrowserPartition('proj-1')).not.toBe(createBrowserPartition('proj-2'))
  })

  it('拒绝空的 projectId', () => {
    expect(() => createBrowserPartition('')).toThrow('Project ID cannot be empty')
    expect(() => createBrowserPartition('   ')).toThrow('Project ID cannot be empty')
  })

  it('webPreferences 快照不含 preload 和 nodeIntegration，必须有 sandbox 和 contextIsolation', () => {
    const prefs = createBrowserWebPreferences()
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    })
    expect(prefs).not.toHaveProperty('preload')
  })
})

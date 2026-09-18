import { describe, it, expect, vi } from 'vitest'
import {
  clearHostBrowserPartitionData,
  createBrowserPartition,
  createBrowserWebPreferences,
  mapHostBrowserClearDataKindsToStorages,
  resolveHostBrowserClearProjectId
} from './host-browser-session'

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

  it('没有选中 Task 或 project 时不能解析出可清理会话', () => {
    expect(resolveHostBrowserClearProjectId(null, 'proj-1')).toBeNull()
    expect(resolveHostBrowserClearProjectId('task-1', null)).toBeNull()
    expect(resolveHostBrowserClearProjectId('', 'proj-1')).toBeNull()
    expect(resolveHostBrowserClearProjectId('task-1', '   ')).toBeNull()
    expect(resolveHostBrowserClearProjectId('task-1', 'proj-1')).toBe('proj-1')
  })

  it('kinds 映射到 clearStorageData storages，空 project 拒绝擦除', async () => {
    expect(mapHostBrowserClearDataKindsToStorages(['cookies'])).toEqual(['cookies'])
    expect(mapHostBrowserClearDataKindsToStorages(['cache'])).toEqual(['cachestorage'])
    expect(mapHostBrowserClearDataKindsToStorages(['history'])).toEqual(['localstorage', 'indexdb'])
    expect(mapHostBrowserClearDataKindsToStorages(['downloads'])).toEqual(['filesystem'])
    expect(
      mapHostBrowserClearDataKindsToStorages(['cookies', 'cache', 'history', 'downloads'])
    ).toEqual(['cookies', 'cachestorage', 'localstorage', 'indexdb', 'filesystem'])

    const clearStorageData = vi.fn(async () => undefined)
    await expect(clearHostBrowserPartitionData('', ['cookies'], clearStorageData)).rejects.toThrow(
      '没有可清理的内置浏览器会话。'
    )
    expect(clearStorageData).not.toHaveBeenCalled()

    await clearHostBrowserPartitionData('proj-1', ['cookies', 'cache'], clearStorageData)
    expect(clearStorageData).toHaveBeenCalledWith('persist:as-browser:proj-1', [
      'cookies',
      'cachestorage'
    ])
  })
})

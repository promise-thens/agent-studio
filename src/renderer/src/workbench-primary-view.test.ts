import { describe, expect, it } from 'vitest'
import {
  applyOpenPlugins,
  isWorkbenchPrimaryView,
  resolveExecutionSurfaceBanner,
  resolveWorkbenchPrimaryView
} from './workbench-primary-view'

describe('主列视图契约', () => {
  it('识别合法主列视图，未知值回退到 conversation', () => {
    expect(isWorkbenchPrimaryView('conversation')).toBe(true)
    expect(isWorkbenchPrimaryView('plugins')).toBe(true)
    expect(isWorkbenchPrimaryView('settings')).toBe(false)
    expect(isWorkbenchPrimaryView(null)).toBe(false)
    expect(isWorkbenchPrimaryView(undefined)).toBe(false)
    expect(isWorkbenchPrimaryView(1)).toBe(false)

    expect(resolveWorkbenchPrimaryView('plugins')).toBe('plugins')
    expect(resolveWorkbenchPrimaryView('conversation')).toBe('conversation')
    expect(resolveWorkbenchPrimaryView('unknown')).toBe('conversation')
    expect(resolveWorkbenchPrimaryView(null)).toBe('conversation')
    expect(resolveWorkbenchPrimaryView(undefined)).toBe('conversation')
  })

  it('打开插件页不取消、不清 selectedTaskId', () => {
    expect(applyOpenPlugins({ selectedTaskId: 'task-a', activeExecutionTaskId: 'task-a' })).toEqual(
      { primaryView: 'plugins', selectedTaskId: 'task-a', cancelTurn: false }
    )
  })

  it('打开插件页时 activeExecutionTaskId 只作不取消的见证，不进入返回值', () => {
    expect(applyOpenPlugins({ selectedTaskId: 'task-b', activeExecutionTaskId: null })).toEqual({
      primaryView: 'plugins',
      selectedTaskId: 'task-b',
      cancelTurn: false
    })
  })
})

describe('执行表面条契约', () => {
  it('插件页且等待审批时显示 waiting-permission 条', () => {
    expect(
      resolveExecutionSurfaceBanner({
        primaryView: 'plugins',
        activeExecution: { taskId: 'task-a', state: 'waiting-permission' }
      })
    ).toEqual({ kind: 'waiting-permission', taskId: 'task-a' })
  })

  it('插件页且运行中时显示 running 条', () => {
    expect(
      resolveExecutionSurfaceBanner({
        primaryView: 'plugins',
        activeExecution: { taskId: 'task-a', state: 'running' }
      })
    ).toEqual({ kind: 'running', taskId: 'task-a' })
  })

  it('对话页不显示执行条', () => {
    expect(
      resolveExecutionSurfaceBanner({
        primaryView: 'conversation',
        activeExecution: { taskId: 'task-a', state: 'running' }
      })
    ).toEqual({ kind: 'none' })
  })

  it('无活动执行或其他状态时不显示执行条', () => {
    expect(
      resolveExecutionSurfaceBanner({
        primaryView: 'plugins',
        activeExecution: null
      })
    ).toEqual({ kind: 'none' })

    expect(
      resolveExecutionSurfaceBanner({
        primaryView: 'plugins',
        activeExecution: { taskId: 'task-a', state: 'queued' }
      })
    ).toEqual({ kind: 'none' })

    expect(
      resolveExecutionSurfaceBanner({
        primaryView: 'plugins',
        activeExecution: { taskId: 'task-a', state: 'cancelling' }
      })
    ).toEqual({ kind: 'none' })

    expect(
      resolveExecutionSurfaceBanner({
        primaryView: 'plugins',
        activeExecution: { taskId: 'task-a', state: 'completed' }
      })
    ).toEqual({ kind: 'none' })
  })
})

import { describe, expect, it } from 'vitest'
import { createProjectSelectionCoordinator } from './project-selection-coordinator'

describe('Project 选择协调器', () => {
  it('A/B 乱序完成时只有最新代次能提交并释放门禁', () => {
    const pendingStates: boolean[] = []
    const committed: string[] = []
    const coordinator = createProjectSelectionCoordinator((pending) => pendingStates.push(pending))
    const selectionA = coordinator.begin()
    const selectionB = coordinator.begin()

    expect(coordinator.isPending()).toBe(true)
    expect(coordinator.isCurrent(selectionA)).toBe(false)
    expect(coordinator.commit(selectionA, () => committed.push('A'))).toBe(false)
    expect(coordinator.finish(selectionA)).toBe(false)
    expect(coordinator.isPending()).toBe(true)
    expect(coordinator.isCurrent(selectionB)).toBe(true)
    expect(coordinator.commit(selectionB, () => committed.push('B'))).toBe(true)
    expect(coordinator.finish(selectionB)).toBe(true)
    expect(coordinator.isPending()).toBe(false)
    expect(committed).toEqual(['B'])
    expect(pendingStates).toEqual([true, false])
  })

  it('失效动作会阻止旧成功或失败请求继续提交副作用', () => {
    const coordinator = createProjectSelectionCoordinator()
    const errors: string[] = []
    const selection = coordinator.begin()

    coordinator.invalidate()

    expect(coordinator.isCurrent(selection)).toBe(false)
    expect(coordinator.commit(selection, () => errors.push('旧请求失败'))).toBe(false)
    expect(coordinator.finish(selection)).toBe(false)
    expect(coordinator.isPending()).toBe(false)
    expect(errors).toEqual([])
  })
})

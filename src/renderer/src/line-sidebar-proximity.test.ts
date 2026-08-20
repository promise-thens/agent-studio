import { describe, expect, it } from 'vitest'
import {
  TASK_LIST_LINE_METRICS,
  advanceEffects,
  computeProximityTargets,
  pointerYInList,
  proximityFromDistance,
  seedEffects,
  staticEffect,
  stepToward
} from './line-sidebar-proximity'

describe('侧栏近距衰减', () => {
  it('贴着条目中心时线性近距为 1，超出半径为 0', () => {
    expect(proximityFromDistance(0, 100, 'linear')).toBe(1)
    expect(proximityFromDistance(100, 100, 'linear')).toBe(0)
    expect(proximityFromDistance(150, 100, 'linear')).toBe(0)
    expect(proximityFromDistance(50, 100, 'linear')).toBe(0.5)
  })

  it('smooth 在半半径处仍是 0.5，sharp 更靠近中心才抬升', () => {
    expect(proximityFromDistance(50, 100, 'smooth')).toBe(0.5)
    expect(proximityFromDistance(50, 100, 'sharp')).toBeCloseTo(0.125)
  })

  it('半径无效时不当成无限近', () => {
    expect(proximityFromDistance(0, 0, 'linear')).toBe(0)
    expect(proximityFromDistance(0, -10, 'smooth')).toBe(0)
  })
})

describe('侧栏近距目标值', () => {
  it('选中项即使指针离开也保持满效果', () => {
    expect(
      computeProximityTargets(null, [{ offsetTop: 0, offsetHeight: 32, selected: true }], {
        radius: 64,
        falloff: 'smooth'
      })
    ).toEqual([1])
    expect(staticEffect(true)).toBe(1)
    expect(staticEffect(false)).toBe(0)
  })

  it('指针按列表内容坐标计算，滚动后不会错位到可见区域顶部', () => {
    expect(pointerYInList(200, 100, 40)).toBe(140)
    const items = [
      { offsetTop: 0, offsetHeight: 32, selected: false },
      { offsetTop: 32, offsetHeight: 32, selected: false }
    ]
    const atFirst = computeProximityTargets(16, items, { radius: 32, falloff: 'linear' })
    const atSecond = computeProximityTargets(48, items, { radius: 32, falloff: 'linear' })
    expect(atFirst[0]).toBe(1)
    expect(atFirst[1]).toBe(0)
    expect(atSecond[0]).toBe(0)
    expect(atSecond[1]).toBe(1)
  })

  it('效果数组长度对不上时按选中态重铺，避免选中行从 0 闪到 1', () => {
    expect(seedEffects([], [false, true])).toEqual([0, 1])
    expect(seedEffects([0.4, 1], [false, true])).toEqual([0.4, 1])
    expect(seedEffects([1], [false, true])).toEqual([0, 1])
  })

  it('插值到达阈值内视为静止，避免 rAF 空转', () => {
    expect(stepToward(0, 1, 1)).toEqual({ value: 1, settled: true })
    expect(stepToward(0, 1, 0.5)).toEqual({ value: 0.5, settled: false })
    const almost = stepToward(0.999, 1, 0.9)
    expect(almost.settled).toBe(true)
    expect(almost.value).toBe(1)
    const { next, moving } = advanceEffects([0, 1], [1, 1], 1)
    expect(next).toEqual([1, 1])
    expect(moving).toBe(false)
  })
})

describe('220px 侧栏刻度', () => {
  it('标记和位移按窄栏收敛，不沿用 Vue Bits 默认 60/30', () => {
    expect(TASK_LIST_LINE_METRICS.markerLength).toBe(24)
    expect(TASK_LIST_LINE_METRICS.maxShift).toBe(8)
    expect(TASK_LIST_LINE_METRICS.proximityRadius).toBeLessThan(100)
    expect(TASK_LIST_LINE_METRICS.falloff).toBe('smooth')
  })
})

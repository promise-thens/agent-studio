/** Vue Bits LineSidebar 的近距衰减；逻辑留下，样式改走现有主题 token。 */
export type LineSidebarFalloff = 'linear' | 'smooth' | 'sharp'

/** 220px 侧栏不能沿用官网默认 60/30，否则中文标题会被挤没。 */
export const TASK_LIST_LINE_METRICS = {
  proximityRadius: 64,
  maxShift: 8,
  markerLength: 24,
  smoothingMs: 100,
  falloff: 'smooth' as const
}

export interface LineSidebarItemGeometry {
  offsetTop: number
  offsetHeight: number
  selected: boolean
}

const FALLOFF_CURVES: Record<LineSidebarFalloff, (progress: number) => number> = {
  linear: (progress) => progress,
  smooth: (progress) => progress * progress * (3 - 2 * progress),
  sharp: (progress) => progress * progress * progress
}

/**
 * 把指针到条目中心的距离映射成 0..1 近距。
 * 半径无效时返回 0，避免除零后整列被当成「贴着指针」。
 */
export function proximityFromDistance(
  distance: number,
  radius: number,
  falloff: LineSidebarFalloff
): number {
  if (!(radius > 0)) return 0
  const linear = Math.max(0, 1 - Math.max(0, distance) / radius)
  return (FALLOFF_CURVES[falloff] ?? FALLOFF_CURVES.linear)(linear)
}

/** 减少动效时不做插值，只让选中行亮起。 */
export function staticEffect(selected: boolean): number {
  return selected ? 1 : 0
}

/**
 * 行数变了才按选中态重铺。
 * 长度一致时保留当前插值，避免选中行每帧从 0 闪到 1。
 */
export function seedEffects(current: readonly number[], selected: readonly boolean[]): number[] {
  if (current.length === selected.length) return current.slice()
  return selected.map((isSelected) => staticEffect(isSelected))
}

/** 列表可能滚动，必须用内容坐标，不能只用可视区域 clientY。 */
export function pointerYInList(clientY: number, listTop: number, scrollTop: number): number {
  return clientY - listTop + scrollTop
}

/**
 * 计算每一行的目标效果：近距和选中取较大值。
 * pointerY 为 null 表示指针已离开，未选中行回到 0。
 */
export function computeProximityTargets(
  pointerY: number | null,
  items: readonly LineSidebarItemGeometry[],
  options: { radius: number; falloff: LineSidebarFalloff }
): number[] {
  return items.map((item) => {
    const proximity =
      pointerY == null
        ? 0
        : proximityFromDistance(
            Math.abs(pointerY - (item.offsetTop + item.offsetHeight / 2)),
            options.radius,
            options.falloff
          )
    return Math.max(proximity, item.selected ? 1 : 0)
  })
}

/** 一帧指数逼近；足够接近时钉在目标上，让 rAF 停下来。 */
export function stepToward(
  current: number,
  target: number,
  gain: number
): { value: number; settled: boolean } {
  const next = current + (target - current) * gain
  const settled = Math.abs(target - next) < 0.0015
  return { value: settled ? target : next, settled }
}

export function advanceEffects(
  current: readonly number[],
  targets: readonly number[],
  gain: number
): { next: number[]; moving: boolean } {
  const next: number[] = []
  let moving = false
  const count = Math.max(current.length, targets.length)
  for (let index = 0; index < count; index += 1) {
    const stepped = stepToward(current[index] || 0, targets[index] || 0, gain)
    next[index] = stepped.value
    if (!stepped.settled) moving = true
  }
  return { next, moving }
}

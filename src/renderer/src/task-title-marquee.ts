/** 两段标题之间的空隙，接循环时才不会粘在一起。 */
export const TASK_TITLE_MARQUEE_GAP_PX = 40
/** 大约阅读速度；再快会看不清中文。 */
export const TASK_TITLE_MARQUEE_PX_PER_SECOND = 28

/** 1px 内的差值多半是亚像素，不当成长标题。 */
export function titleNeedsMarquee(textWidth: number, clipWidth: number, slack = 1): boolean {
  return textWidth - clipWidth > slack
}

export function marqueeDistancePx(textWidth: number, gapPx = TASK_TITLE_MARQUEE_GAP_PX): number {
  return Math.max(0, textWidth) + gapPx
}

/**
 * 滚完「文本 + 间隔」需要的秒数。
 * 很短的溢出也至少 6 秒，避免一闪而过。
 */
export function marqueeDurationSeconds(
  distancePx: number,
  pxPerSecond = TASK_TITLE_MARQUEE_PX_PER_SECOND
): number {
  if (!(distancePx > 0) || !(pxPerSecond > 0)) return 0
  return Math.max(6, distancePx / pxPerSecond)
}

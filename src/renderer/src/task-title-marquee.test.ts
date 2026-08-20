import { describe, expect, it } from 'vitest'
import {
  TASK_TITLE_MARQUEE_GAP_PX,
  marqueeDistancePx,
  marqueeDurationSeconds,
  titleNeedsMarquee
} from './task-title-marquee'

describe('侧栏长标题单行滚动', () => {
  it('只有比裁剪盒多出超过 1px 才滚动，贴边不算溢出', () => {
    expect(titleNeedsMarquee(120, 120)).toBe(false)
    expect(titleNeedsMarquee(121, 120)).toBe(false)
    expect(titleNeedsMarquee(122, 120)).toBe(true)
    expect(titleNeedsMarquee(80, 120)).toBe(false)
  })

  it('循环距离是文本宽加间隔，时长随距离变长但不飞得太快', () => {
    expect(marqueeDistancePx(100)).toBe(100 + TASK_TITLE_MARQUEE_GAP_PX)
    expect(marqueeDistancePx(0)).toBe(TASK_TITLE_MARQUEE_GAP_PX)
    expect(marqueeDurationSeconds(280, 28)).toBe(10)
    expect(marqueeDurationSeconds(40, 28)).toBe(6)
    expect(marqueeDurationSeconds(0)).toBe(0)
  })
})

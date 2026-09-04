import { describe, expect, it } from 'vitest'
import { describeHistoryTruncation } from './task-history'

describe('describeHistoryTruncation', () => {
  it('按截断原因给出短标签和详情，缺原因时仍说明容量限制', () => {
    expect(describeHistoryTruncation('event-count')).toEqual({
      shortLabel: '历史已截断 · 本轮事件过多',
      detail: '本轮事件条数达到上限，后续过程只实时显示、不写入历史。'
    })
    expect(describeHistoryTruncation('event-bytes')).toEqual({
      shortLabel: '历史已截断 · 单条过大',
      detail: '单条事件过大，本轮后续历史已停止保存。'
    })
    expect(describeHistoryTruncation('turn-bytes')).toEqual({
      shortLabel: '历史已截断 · 本轮体积过大',
      detail: '本轮历史体积达到上限，后续过程只实时显示、不写入历史。'
    })
    expect(describeHistoryTruncation()).toEqual({
      shortLabel: '历史已截断',
      detail: '部分执行历史因容量限制不可用。'
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  parseBrowserFocusIntent,
  parseBrowserFocusSnapshot,
  type BrowserFocusSnapshot
} from './browser-focus-overlay'

describe('浏览器专注浮层操作契约', () => {
  it('Stop 必须携带点击时看到的完整执行身份', () => {
    const stop = {
      kind: 'stop' as const,
      projectionId: 'projection-1',
      revision: 3,
      execution: { executionId: 'execution-1', taskId: 'task-1', turnId: 'turn-1' }
    }

    expect(parseBrowserFocusIntent(stop)).toEqual(stop)
    expect(parseBrowserFocusIntent({ ...stop, execution: undefined })).toBeNull()
    expect(
      parseBrowserFocusIntent({
        ...stop,
        execution: { ...stop.execution, unexpected: 'secret' }
      })
    ).toBeNull()
  })

  it('Send 与 Expand 不接受伪造的执行身份', () => {
    const base = { projectionId: 'projection-1', revision: 3 }
    const execution = { executionId: 'execution-1', taskId: 'task-1', turnId: 'turn-1' }

    expect(parseBrowserFocusIntent({ ...base, kind: 'send', execution })).toBeNull()
    expect(parseBrowserFocusIntent({ ...base, kind: 'expand', execution })).toBeNull()
  })
})

describe('浏览器专注浮层快照数据契约', () => {
  const validSnapshot: BrowserFocusSnapshot = {
    projectionId: 'proj-1',
    taskId: 'task-1',
    revision: 1,
    draftAck: 0,
    visible: true,
    draft: '草稿',
    taskTitle: '任务标题',
    status: '就绪',
    modelLabel: 'grok-3',
    attachmentCount: 0,
    canSend: true,
    textareaDisabled: false,
    execution: null,
    theme: 'dark',
    browserBounds: { x: 0, y: 0, width: 800, height: 600 },
    latestAssistantMessage: '模型回复内容'
  }

  it('支持最新模型回复为字符串或 null', () => {
    expect(parseBrowserFocusSnapshot(validSnapshot)).toEqual(validSnapshot)
    expect(parseBrowserFocusSnapshot({ ...validSnapshot, latestAssistantMessage: null })).toEqual({
      ...validSnapshot,
      latestAssistantMessage: null
    })
  })

  it('拒绝包含空字符或超过 32KB 的模型回复', () => {
    expect(
      parseBrowserFocusSnapshot({ ...validSnapshot, latestAssistantMessage: '带有\0空字符' })
    ).toBeNull()
    const tooLong = 'a'.repeat(32 * 1024 + 1)
    expect(
      parseBrowserFocusSnapshot({ ...validSnapshot, latestAssistantMessage: tooLong })
    ).toBeNull()
  })
})

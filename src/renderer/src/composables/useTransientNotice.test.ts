import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTransientNotice } from './useTransientNotice'

const appSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../App.vue'), 'utf8')
const modelSelectorSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../components/ModelSelector.vue'),
  'utf8'
)

afterEach(() => {
  vi.useRealTimers()
})

describe('useTransientNotice', () => {
  it('展示后在到期时自动清空，新提示会顶掉旧定时器', () => {
    vi.useFakeTimers()
    const notice = useTransientNotice(4_000)
    notice.show('第一次失败')
    expect(notice.message.value).toBe('第一次失败')
    vi.advanceTimersByTime(2_000)
    notice.show('第二次失败')
    vi.advanceTimersByTime(3_999)
    expect(notice.message.value).toBe('第二次失败')
    vi.advanceTimersByTime(1)
    expect(notice.message.value).toBeNull()
  })
})

describe('瞬时错误提示接线', () => {
  it('模型切换失败走顶部短提示，不写进对话', () => {
    expect(appSource).toContain('useTransientNotice')
    expect(appSource).toMatch(
      /function handleModelError\(message: string\): void \{\s*showTransientNotice\(readRendererErrorMessage\(message, '模型切换失败。'\)\)\s*\}/
    )
    expect(appSource).not.toContain("appendMessage('error', message)")
  })

  it('选择模型失败关闭菜单，错误正文先剥 IPC 外壳', () => {
    expect(modelSelectorSource).toContain('readRendererErrorMessage')
    expect(modelSelectorSource).toMatch(
      /catch \(error\) \{\s*closeMenu\(true\)\s*emit\('error', errorMessage\(error\)\)/
    )
  })
})

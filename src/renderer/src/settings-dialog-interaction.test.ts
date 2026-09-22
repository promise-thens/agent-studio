import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { effectScope, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  canLeaveSettingsPane,
  reportSettingsPaneState,
  settingsPaneFeedback,
  type SettingsPaneState
} from './settings-dialog-interaction'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')
const settingsDialogSource = readFileSync(
  join(rendererDir, 'components/SettingsDialog.vue'),
  'utf8'
)

/** 离开保护只依据交互摘要，失败不能替用户丢掉草稿。 */
describe('设置页离开保护', () => {
  it('保存期间不弹丢弃确认，也不允许清洁页提前卸载', () => {
    const confirmDiscard = vi.fn(() => true)
    for (const dirty of [false, true]) {
      expect(canLeaveSettingsPane({ dirty, saving: true, error: '' }, confirmDiscard)).toBe(false)
    }
    expect(confirmDiscard).not.toHaveBeenCalled()
  })

  it('清洁页直接离开；失败草稿必须取得明确丢弃确认', () => {
    const confirmDiscard = vi.fn(() => false)
    expect(canLeaveSettingsPane({ dirty: false, saving: false, error: '' }, confirmDiscard)).toBe(
      true
    )
    expect(confirmDiscard).not.toHaveBeenCalled()
    const failedDraft = { dirty: true, saving: false, error: '本地受控保存失败' }
    expect(canLeaveSettingsPane(failedDraft, confirmDiscard)).toBe(false)
    confirmDiscard.mockReturnValueOnce(true)
    expect(canLeaveSettingsPane(failedDraft, confirmDiscard)).toBe(true)
    expect(confirmDiscard).toHaveBeenCalledTimes(2)
  })
})

/** 设置里的 Runtime 快捷动作必须等模态卸载、Composer 恢复焦点后才能发送。 */
describe('设置快捷动作启动时序', () => {
  it('关闭设置并等待卸载后才聚焦 Composer 和发送 Prompt', () => {
    const requestSource = settingsDialogSource.match(/function requestStartTurn[\s\S]*?\n}\n/)?.[0]
    expect(requestSource).toBeTruthy()
    expect(requestSource!.indexOf('canLeaveSettingsPane')).toBeLessThan(
      requestSource!.indexOf("emit('start-turn', command)")
    )

    const source = appSource.match(/async function startSettingsGrokAction[\s\S]*?\n}\n/)?.[0]
    expect(source).toBeTruthy()
    const closeIndex = source!.indexOf('closeSettingsDialog()')
    const unmountIndex = source!.indexOf('await nextTick()')
    const focusIndex = source!.indexOf('taskComposer.value?.focus()')
    const promptIndex = source!.indexOf('prompt.value = command')
    const sendIndex = source!.indexOf('await sendPrompt()')

    expect(closeIndex).toBeGreaterThan(-1)
    expect(unmountIndex).toBeGreaterThan(closeIndex)
    expect(focusIndex).toBeGreaterThan(unmountIndex)
    expect(promptIndex).toBeGreaterThan(focusIndex)
    expect(sendIndex).toBeGreaterThan(promptIndex)
  })
})

/** 异步保存结束之前不能展示旧成功消息，失败与未保存必须清晰可区分。 */
describe('设置页状态反馈', () => {
  it('保存中和失败优先于上一轮成功消息', () => {
    const state: SettingsPaneState = {
      dirty: true,
      saving: true,
      error: '本地受控保存失败',
      message: '上一轮已保存'
    }
    expect(settingsPaneFeedback(state)).toContain('正在处理')
    state.saving = false
    expect(settingsPaneFeedback(state)).toContain('未保存的更改仍保留')
    state.dirty = false
    expect(settingsPaneFeedback(state)).toContain('重试')
    expect(settingsPaneFeedback(state)).not.toContain(state.message)
  })

  it('即时项沿用确认结果，未保存内容不会被旧成功消息覆盖', () => {
    expect(
      settingsPaneFeedback({ dirty: false, saving: false, error: '', message: '外观已保存' })
    ).toBe('外观已保存')
    expect(
      settingsPaneFeedback({ dirty: true, saving: false, error: '', message: '外观已保存' })
    ).toContain('有未保存的更改')
    expect(settingsPaneFeedback({ dirty: false, saving: false, error: '' })).toContain('没有未保存')
  })
})

/** 同一事件循环里的 blur/save 与 click/leave 必须看到最新状态，卸载后不再汇报。 */
describe('设置子页同步汇报', () => {
  it('立即汇报初始状态，同步拦住紧接保存的离开，并在作用域结束时清理', () => {
    const saving = ref(false)
    const dirty = ref(true)
    const report = vi.fn<(state: SettingsPaneState) => void>()
    const scope = effectScope()
    scope.run(() =>
      reportSettingsPaneState(
        () => ({ dirty: dirty.value, saving: saving.value, error: '' }),
        report
      )
    )
    expect(report.mock.calls.at(-1)?.[0]).toEqual({ dirty: true, saving: false, error: '' })
    saving.value = true
    const latest = report.mock.calls.at(-1)![0]
    expect(canLeaveSettingsPane(latest, () => true)).toBe(false)
    dirty.value = false
    expect(report.mock.calls.at(-1)?.[0]).toEqual({ dirty: false, saving: true, error: '' })
    scope.stop()
    const count = report.mock.calls.length
    saving.value = false
    expect(report).toHaveBeenCalledTimes(count)
  })

  it('显式取消订阅后不再向已卸载设置壳回写状态', () => {
    const dirty = ref(false)
    const report = vi.fn()
    const stop = reportSettingsPaneState(
      () => ({ dirty: dirty.value, saving: false, error: '' }),
      report
    )
    stop()
    dirty.value = true
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('失败草稿纠正为已保存值后必须回到清洁反馈，不能残留旧错误', () => {
    expect(
      settingsPaneFeedback({
        dirty: true,
        saving: false,
        error: '黑名单格式无效'
      })
    ).toContain('未保存的更改仍保留')
    expect(
      settingsPaneFeedback({
        dirty: false,
        saving: false,
        error: ''
      })
    ).toBe('当前没有未保存的更改。')
  })
})

import { describe, expect, it } from 'vitest'
import { describeProjectFolderRevealFailure } from './project-folder-reveal'

describe('打开已删除项目目录', () => {
  it('目录不可用时给出明确提示，不把失败写进对话', () => {
    expect(
      describeProjectFolderRevealFailure({
        displayName: 'agen-studio',
        availabilityState: 'unavailable'
      })
    ).toEqual({
      title: '无法打开文件夹',
      description: '“agen-studio”的本地目录已删除或无法访问。'
    })
    expect(
      describeProjectFolderRevealFailure({
        displayName: 'demo',
        errorCode: 'project-unavailable'
      })
    ).toMatchObject({ title: '无法打开文件夹' })
  })
})

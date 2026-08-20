export interface ProjectFolderRevealNotice {
  title: string
  description: string
}

/**
 * 打开文件夹失败时给侧栏看的提示。
 * 目录已删或不在时说清楚，不把失败写进对话流。
 */
export function describeProjectFolderRevealFailure(input: {
  displayName: string
  availabilityState?: string
  errorCode?: string
}): ProjectFolderRevealNotice {
  const name = input.displayName.trim() || '该项目'
  const unavailable =
    input.availabilityState === 'unavailable' ||
    input.availabilityState === 'version-unsupported' ||
    input.errorCode === 'project-unavailable' ||
    input.errorCode === 'project-not-found'
  return {
    title: '无法打开文件夹',
    description: unavailable
      ? `“${name}”的本地目录已删除或无法访问。`
      : `无法打开“${name}”的文件夹。`
  }
}

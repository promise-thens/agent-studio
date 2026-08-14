export interface ProjectSelectionToken {
  generation: number
}

export interface ProjectSelectionCoordinator {
  begin(): ProjectSelectionToken
  invalidate(): void
  isCurrent(token: ProjectSelectionToken): boolean
  commit(token: ProjectSelectionToken, action: () => void): boolean
  finish(token: ProjectSelectionToken): boolean
  isPending(): boolean
}

/**
 * 管理 Project 选择代次和过渡门禁；旧异步请求只能结束自己的代次，不能释放新请求的门禁。
 */
export function createProjectSelectionCoordinator(
  onPendingChange: (pending: boolean) => void = () => undefined
): ProjectSelectionCoordinator {
  let generation = 0
  let pending = false

  function setPending(next: boolean): void {
    if (pending === next) return
    pending = next
    onPendingChange(next)
  }

  return {
    begin() {
      generation += 1
      setPending(true)
      return { generation }
    },
    invalidate() {
      generation += 1
      setPending(false)
    },
    isCurrent(token) {
      return token.generation === generation
    },
    commit(token, action) {
      if (token.generation !== generation) return false
      action()
      return true
    },
    finish(token) {
      if (token.generation !== generation) return false
      setPending(false)
      return true
    },
    isPending() {
      return pending
    }
  }
}

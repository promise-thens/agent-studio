import type { AgentRuntimeTurnRef } from './agent-runtime-adapter'

/** 单执行槽拒绝第二个活动 Turn 时使用的有限错误。 */
export class TaskExecutionConflictError extends Error {
  readonly code = 'invalid-state' as const

  constructor(message = '已有 Turn 正在执行，请等待完成或先取消当前 Turn。') {
    super(message)
    this.name = 'TaskExecutionConflictError'
  }
}

function isSameTurn(left: AgentRuntimeTurnRef, right: AgentRuntimeTurnRef): boolean {
  return (
    left.taskId === right.taskId &&
    left.turnId === right.turnId &&
    left.runtimeSessionId === right.runtimeSessionId
  )
}

/**
 * 首版只维护一个活动 Turn 槽。
 * Controller 不拥有 Task 或 Runtime session 注册表，只负责并发门禁与幂等收束。
 */
export class TaskExecutionController {
  private activeTurn: AgentRuntimeTurnRef | null = null
  private cancelRequested = false

  getActiveTurn(): AgentRuntimeTurnRef | null {
    return this.activeTurn ? { ...this.activeTurn } : null
  }

  hasActiveTurn(): boolean {
    return this.activeTurn !== null
  }

  isCancellationRequested(): boolean {
    return this.activeTurn !== null && this.cancelRequested
  }

  /**
   * 原子占用唯一执行槽并运行 Turn；finally 只释放同一引用，
   * 防止旧异步调用结束时清空后来建立的新 Turn。
   */
  async execute<T>(turn: AgentRuntimeTurnRef, operation: () => Promise<T>): Promise<T> {
    if (this.activeTurn) throw new TaskExecutionConflictError()

    const reservedTurn = { ...turn }
    this.activeTurn = reservedTurn
    this.cancelRequested = false

    try {
      return await operation()
    } finally {
      this.release(reservedTurn)
    }
  }

  /**
   * 取消只会对当前活动 Turn 调用一次 Runtime；重复点击直接复用已发出的取消意图。
   * 若 Runtime 明确拒绝取消，则恢复门禁，允许用户再次尝试。
   */
  async cancel(operation: (turn: AgentRuntimeTurnRef) => Promise<void>): Promise<void> {
    const activeTurn = this.activeTurn
    if (!activeTurn || this.cancelRequested) return

    this.cancelRequested = true
    try {
      await operation({ ...activeTurn })
    } catch (error) {
      if (this.activeTurn && isSameTurn(this.activeTurn, activeTurn)) {
        this.cancelRequested = false
      }
      throw error
    }
  }

  /** 断开或 Runtime 崩溃时可强制释放完全匹配的旧槽；重复调用安全无副作用。 */
  release(turn: AgentRuntimeTurnRef): void {
    if (!this.activeTurn || !isSameTurn(this.activeTurn, turn)) return
    this.activeTurn = null
    this.cancelRequested = false
  }
}

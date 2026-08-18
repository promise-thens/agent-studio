import type { TaskExecutionSnapshot } from '../../shared/task-execution'

export interface TaskExecutionConsumerOptions {
  getSnapshot: () => Promise<TaskExecutionSnapshot>
  subscribe: (listener: (snapshot: TaskExecutionSnapshot) => void) => () => void
  onSnapshot: (snapshot: TaskExecutionSnapshot) => void
}

/**
 * Renderer 先监听再查询，以 epoch/revision watermark 消除查询与 Push 之间的丢事件窗口。
 * 跳号或 epoch 变化时只保留一个 resync，请求完成前继续缓冲增量。
 */
export function createTaskExecutionConsumer(options: TaskExecutionConsumerOptions): {
  start(): Promise<TaskExecutionSnapshot>
  accept(snapshot: TaskExecutionSnapshot): void
  dispose(): void
} {
  let disposed = false
  let started = false
  let baseline: TaskExecutionSnapshot | null = null
  let buffered: TaskExecutionSnapshot[] = []
  let resync: Promise<void> | null = null
  let resyncGeneration = 0
  let cleanup: (() => void) | null = null

  function isNewerOrDifferentEpoch(
    snapshot: TaskExecutionSnapshot,
    current: TaskExecutionSnapshot | null
  ): boolean {
    return (
      !current ||
      snapshot.executorEpoch !== current.executorEpoch ||
      snapshot.executionRevision > current.executionRevision
    )
  }

  function publish(snapshot: TaskExecutionSnapshot): void {
    baseline = snapshot
    options.onSnapshot(snapshot)
  }

  /** 连续增量立即重放；仍有跳号时保留缓冲，等待重查或缺失 Push 补齐。 */
  function drainBuffered(): void {
    if (!baseline || !buffered.length) return
    const pending = buffered
    buffered = []
    for (const item of pending.sort(
      (left, right) => left.executionRevision - right.executionRevision
    )) {
      if (item.executorEpoch !== baseline.executorEpoch) {
        buffered.push(item)
        continue
      }
      if (item.executionRevision <= baseline.executionRevision) continue
      if (item.executionRevision === baseline.executionRevision + 1) {
        publish(item)
        continue
      }
      buffered.push(item)
    }
  }

  function accept(snapshot: TaskExecutionSnapshot): void {
    if (disposed) return
    if (!baseline) {
      buffered.push(snapshot)
      return
    }
    if (snapshot.executorEpoch !== baseline.executorEpoch) {
      buffered.push(snapshot)
      void requestResync()
      return
    }
    if (snapshot.executionRevision <= baseline.executionRevision) return
    if (snapshot.executionRevision !== baseline.executionRevision + 1) {
      buffered.push(snapshot)
      void requestResync()
      return
    }
    publish(snapshot)
    drainBuffered()
    if (buffered.length) void requestResync()
  }

  async function requestResync(): Promise<void> {
    if (disposed || resync) return resync ?? Promise.resolve()
    const generation = ++resyncGeneration
    resync = (async () => {
      const previous = baseline
      let fetched: TaskExecutionSnapshot | null = null
      try {
        const snapshot = await options.getSnapshot()
        if (disposed || generation !== resyncGeneration) return
        if (!isNewerOrDifferentEpoch(snapshot, baseline)) return
        fetched = snapshot
        publish(snapshot)
        drainBuffered()
      } finally {
        resync = null
        if (
          !disposed &&
          buffered.length &&
          fetched &&
          (!previous ||
            fetched.executorEpoch !== previous.executorEpoch ||
            fetched.executionRevision > previous.executionRevision)
        ) {
          // 本轮重查取得了新事实但仍缺 revision，再做一次；无进展时等待后续 Push，避免自旋。
          void requestResync()
        }
      }
    })()
    return resync
  }

  return {
    async start(): Promise<TaskExecutionSnapshot> {
      if (started) return baseline ?? options.getSnapshot()
      started = true
      cleanup = options.subscribe(accept)
      const snapshot = await options.getSnapshot()
      if (disposed) return snapshot
      publish(snapshot)
      drainBuffered()
      if (buffered.length) void requestResync()
      return baseline ?? snapshot
    },
    accept,
    dispose(): void {
      disposed = true
      resyncGeneration += 1
      buffered = []
      cleanup?.()
      cleanup = null
    }
  }
}

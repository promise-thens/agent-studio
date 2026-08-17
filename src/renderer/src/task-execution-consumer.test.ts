import { describe, expect, it, vi } from 'vitest'
import type { TaskExecutionSnapshot } from '../../shared/task-execution'
import { createTaskExecutionConsumer } from './task-execution-consumer'

const EMPTY: TaskExecutionSnapshot = {
  executorEpoch: 'epoch-1',
  executionRevision: 0,
  execution: null
}

describe('Task execution consumer', () => {
  it('先监听后查询，并按 watermark 应用查询期间的增量', async () => {
    let listener: ((snapshot: TaskExecutionSnapshot) => void) | null = null
    const query = deferred<TaskExecutionSnapshot>()
    const published: number[] = []
    const consumer = createTaskExecutionConsumer({
      getSnapshot: () => query.promise,
      subscribe: (next) => {
        listener = next
        return () => undefined
      },
      onSnapshot: (snapshot) => published.push(snapshot.executionRevision)
    })

    const emit = (snapshot: TaskExecutionSnapshot): void => {
      if (!listener) throw new Error('listener 尚未注册。')
      listener(snapshot)
    }

    const start = consumer.start()
    emit({ ...EMPTY, executionRevision: 2 })
    query.resolve({ ...EMPTY, executionRevision: 1 })
    await start

    expect(published).toEqual([1, 2])
  })

  it('重复和倒序 revision 被忽略', async () => {
    let listener: ((snapshot: TaskExecutionSnapshot) => void) | null = null
    const onSnapshot = vi.fn()
    const consumer = createTaskExecutionConsumer({
      getSnapshot: async () => ({ ...EMPTY, executionRevision: 2 }),
      subscribe: (next) => {
        listener = next
        return () => undefined
      },
      onSnapshot
    })
    const emit = (snapshot: TaskExecutionSnapshot): void => {
      if (!listener) throw new Error('listener 尚未注册。')
      listener(snapshot)
    }
    await consumer.start()

    emit({ ...EMPTY, executionRevision: 2 })
    emit({ ...EMPTY, executionRevision: 1 })
    expect(onSnapshot).toHaveBeenCalledTimes(1)
  })

  it('Push 已到 R2 时忽略迟到的 admission R1', async () => {
    const published: number[] = []
    const consumer = createTaskExecutionConsumer({
      getSnapshot: async () => ({ ...EMPTY, executionRevision: 1 }),
      subscribe: () => () => undefined,
      onSnapshot: (snapshot) => published.push(snapshot.executionRevision)
    })
    await consumer.start()

    consumer.accept({ ...EMPTY, executionRevision: 2 })
    consumer.accept({ ...EMPTY, executionRevision: 1 })

    expect(published).toEqual([1, 2])
  })

  it('revision 跳号只发起一个 resync，并应用重查后的事实', async () => {
    let listener: ((snapshot: TaskExecutionSnapshot) => void) | null = null
    const resync = deferred<TaskExecutionSnapshot>()
    let queryCount = 0
    const published: number[] = []
    const consumer = createTaskExecutionConsumer({
      getSnapshot: () => {
        queryCount += 1
        return queryCount === 1 ? Promise.resolve(EMPTY) : resync.promise
      },
      subscribe: (next) => {
        listener = next
        return () => undefined
      },
      onSnapshot: (snapshot) => published.push(snapshot.executionRevision)
    })
    const emit = (snapshot: TaskExecutionSnapshot): void => {
      if (!listener) throw new Error('listener 尚未注册。')
      listener(snapshot)
    }
    await consumer.start()

    emit({ ...EMPTY, executionRevision: 3 })
    emit({ ...EMPTY, executionRevision: 4 })
    expect(queryCount).toBe(2)
    resync.resolve({ ...EMPTY, executionRevision: 4 })
    await vi.waitFor(() => expect(published.at(-1)).toBe(4))
    expect(queryCount).toBe(2)
  })

  it('首次 resync 仍缺 revision 时继续重查，直到覆盖缓冲的最新事实', async () => {
    const firstResync = deferred<TaskExecutionSnapshot>()
    const secondResync = deferred<TaskExecutionSnapshot>()
    const published: number[] = []
    let queryCount = 0
    const consumer = createTaskExecutionConsumer({
      getSnapshot: () => {
        queryCount += 1
        if (queryCount === 1) return Promise.resolve(EMPTY)
        return queryCount === 2 ? firstResync.promise : secondResync.promise
      },
      subscribe: () => () => undefined,
      onSnapshot: (snapshot) => published.push(snapshot.executionRevision)
    })
    await consumer.start()

    consumer.accept({ ...EMPTY, executionRevision: 4 })
    firstResync.resolve({ ...EMPTY, executionRevision: 2 })
    await vi.waitFor(() => expect(queryCount).toBe(3))
    secondResync.resolve({ ...EMPTY, executionRevision: 4 })
    await vi.waitFor(() => expect(published.at(-1)).toBe(4))

    expect(published).toEqual([0, 2, 4])
  })

  it('resync 无进展时停止自旋，缺失 Push 到达后再继续补齐缓冲', async () => {
    let queryCount = 0
    const published: number[] = []
    const consumer = createTaskExecutionConsumer({
      getSnapshot: async () => {
        queryCount += 1
        return EMPTY
      },
      subscribe: () => () => undefined,
      onSnapshot: (snapshot) => published.push(snapshot.executionRevision)
    })
    await consumer.start()

    consumer.accept({ ...EMPTY, executionRevision: 3 })
    await vi.waitFor(() => expect(queryCount).toBe(2))
    await Promise.resolve()
    expect(queryCount).toBe(2)

    consumer.accept({ ...EMPTY, executionRevision: 1 })
    consumer.accept({ ...EMPTY, executionRevision: 2 })
    expect(published).toEqual([0, 0, 1, 2, 3])
  })

  it('epoch 变化触发全量替换，dispose 后忽略迟到响应', async () => {
    let listener: ((snapshot: TaskExecutionSnapshot) => void) | null = null
    const resync = deferred<TaskExecutionSnapshot>()
    const onSnapshot = vi.fn()
    let queryCount = 0
    const consumer = createTaskExecutionConsumer({
      getSnapshot: () => {
        queryCount += 1
        return queryCount === 1 ? Promise.resolve(EMPTY) : resync.promise
      },
      subscribe: (next) => {
        listener = next
        return vi.fn()
      },
      onSnapshot
    })
    const emit = (snapshot: TaskExecutionSnapshot): void => {
      if (!listener) throw new Error('listener 尚未注册。')
      listener(snapshot)
    }
    await consumer.start()
    emit({ ...EMPTY, executorEpoch: 'epoch-2', executionRevision: 1 })
    consumer.dispose()
    resync.resolve({ ...EMPTY, executorEpoch: 'epoch-2', executionRevision: 1 })
    await Promise.resolve()

    expect(onSnapshot).toHaveBeenCalledTimes(1)
  })
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

import { join } from 'node:path'
import { isTaskPermissionMode, type TaskPermissionMode } from '../../shared/task-takeover'
import { AtomicJsonWriter } from '../storage/atomic-json-file'

export interface PermissionPreferenceSnapshot {
  schemaVersion: 1
  mode: TaskPermissionMode
  takeoverConfirmed: boolean
}

/** 应用级权限只存有限枚举；缺失或损坏默认询问，不从旧 Task 的高权限推断授权。 */
export class PermissionPreferences {
  private snapshot: PermissionPreferenceSnapshot = {
    schemaVersion: 1, mode: 'ask', takeoverConfirmed: false
  }
  private loading?: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private readonly path: string

  constructor(userDataPath: string, private readonly writer = new AtomicJsonWriter()) {
    this.path = join(userDataPath, 'permission-preferences.json')
  }

  /** 读盘失败保持低权限；异常内容和原始文件路径不向 Renderer 传播。 */
  async read(): Promise<PermissionPreferenceSnapshot> {
    this.loading ??= (async () => {
      try {
        const value = await this.writer.read(this.path, 4096)
        if (!value || typeof value !== 'object') return
        const record = value as Record<string, unknown>
        if (record.schemaVersion !== 1 || !isTaskPermissionMode(record.mode)) return
        if (record.mode === 'takeover' && record.takeoverConfirmed !== true) return
        this.snapshot = {
          schemaVersion: 1, mode: record.mode, takeoverConfirmed: record.takeoverConfirmed === true
        }
      } catch {
        // 不恢复旧 Task 授权，损坏配置不能导致静默完全访问。
      }
    })()
    await this.loading
    return { ...this.snapshot }
  }

  /** 写入与授权确认串行化，只有原子写成功才发布新偏好。 */
  async set(mode: TaskPermissionMode, confirmed = false): Promise<PermissionPreferenceSnapshot> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      const previous = await this.read()
      if (!isTaskPermissionMode(mode)) throw new Error('批准模式无效。')
      if (mode === 'takeover' && !confirmed && !previous.takeoverConfirmed) {
        throw new Error('打开完全访问前必须确认所有对话的授权范围。')
      }
      const next: PermissionPreferenceSnapshot = {
        schemaVersion: 1, mode,
        takeoverConfirmed: previous.takeoverConfirmed || (mode === 'takeover' && confirmed)
      }
      try {
        await this.writer.write(this.path, next)
      } catch {
        throw new Error('权限偏好保存失败，原选择未改变，请重试。')
      }
      this.snapshot = next
      return { ...next }
    })
    this.queue = operation
    return operation
  }
}

/** Session 级斜杠命令项；只保留可展示字段，不拷贝协议 _meta。 */
export interface AgentAvailableCommand {
  name: string
  description: string
  inputHint?: string
}

/**
 * 绑定到某个 Task 的可用命令快照。
 * revision 由主进程单调递增，供 Renderer 丢弃乱序推送。
 */
export interface AgentAvailableCommandSnapshot {
  taskId: string
  revision: number
  commands: AgentAvailableCommand[]
}

/** 单次快照最多保留的有效命令数，防止 IPC 膨胀。 */
export const MAX_AVAILABLE_COMMANDS = 200

/**
 * ACP 斜杠命令 name 约束：字母数字开头，后续可含 : _ -，最长 64 字符。
 * 与协议广告对齐，拒绝空格与奇怪前缀。
 */
export const AVAILABLE_COMMAND_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/

/** 单字段 UTF-8 上限：安全边界，避免异常长字符串进入 Renderer。 */
const MAX_FIELD_UTF8_BYTES = 4 * 1024

const textEncoder = new TextEncoder()

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 将单条未知命令投影为产品形状；非法项返回 null 由调用方跳过。
 * 超长字段、非法 name、缺 description、残缺 inputHint 均整项丢弃，不拖垮整份快照。
 */
function parseAvailableCommand(value: unknown): AgentAvailableCommand | null {
  if (!isPlainRecord(value)) return null

  const { name, description, inputHint } = value
  if (typeof name !== 'string' || !AVAILABLE_COMMAND_NAME_PATTERN.test(name)) return null
  if (utf8ByteLength(name) > MAX_FIELD_UTF8_BYTES) return null

  if (typeof description !== 'string') return null
  if (utf8ByteLength(description) > MAX_FIELD_UTF8_BYTES) return null

  // inputHint 缺省可省略；一旦出现必须是非空字符串且不超过字节上限
  if (inputHint !== undefined) {
    if (typeof inputHint !== 'string' || inputHint.length === 0) return null
    if (utf8ByteLength(inputHint) > MAX_FIELD_UTF8_BYTES) return null
    return { name, description, inputHint }
  }

  return { name, description }
}

/**
 * Preload / IPC 入口：结构失败返回 null（调用方丢弃事件）；
 * 单项瑕疵只跳过该命令。commands 缺失或非数组视为已同步的空列表。
 */
export function parseAvailableCommandSnapshot(
  value: unknown
): AgentAvailableCommandSnapshot | null {
  if (!isPlainRecord(value)) return null

  const { taskId, revision, commands: rawCommands } = value
  if (typeof taskId !== 'string' || taskId.length === 0) return null
  if (utf8ByteLength(taskId) > MAX_FIELD_UTF8_BYTES) return null
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return null

  const commands: AgentAvailableCommand[] = []
  if (Array.isArray(rawCommands)) {
    for (const item of rawCommands) {
      if (commands.length >= MAX_AVAILABLE_COMMANDS) break
      const parsed = parseAvailableCommand(item)
      if (parsed) commands.push(parsed)
    }
  }

  return { taskId, revision, commands }
}

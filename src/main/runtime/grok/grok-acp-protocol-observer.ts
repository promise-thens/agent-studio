import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

/**
 * GACP-01 协议观察记录。只允许字段名、枚举、布尔和计数，禁止 payload、密钥和真实 sessionId。
 */
export type GrokAcpObservationRecord =
  | {
      kind: 'initialize'
      protocolVersion: number | 'absent'
      protocolVersionMatches: boolean | 'absent'
      hasAgentInfoName: boolean
      hasAgentInfoVersion: boolean
      loadSession: boolean | 'absent'
      resumeDeclared: boolean
      closeDeclared: boolean
      promptImage: boolean | 'absent'
      promptAudio: boolean | 'absent'
      promptEmbeddedContext: boolean | 'absent'
      hasAuth: boolean
      hasProviders: boolean
      hasMeta: boolean
    }
  | {
      kind: 'set-model'
      accepted: boolean
      responseShape: 'object' | 'null' | 'missing' | 'failed'
    }
  | {
      kind: 'session-op'
      method: 'new' | 'resume' | 'load' | 'close'
      sessionIdShape: 'uuid' | 'opaque-nonempty' | 'empty'
      ok: boolean
      errorCode?: string
    }
  | {
      kind: 'session-update'
      sessionUpdate: string
      contentType?: string
      hasMessageId?: boolean
      toolKind?: string
      status?: string
      hasLocations?: boolean
      locationHasPath?: boolean
      planEntryCount?: number
      planHasPriority?: boolean
      planHasStatus?: boolean
      hasUsed?: boolean
      hasSize?: boolean
      hasCost?: boolean
    }
  | {
      kind: 'prompt-stop'
      stopReason: string
    }
  | {
      kind: 'permission'
      optionKinds: string[]
      uniqueAllowOnce: boolean
      uniqueRejectOnce: boolean
      toolCallKind: string | 'absent'
      hasLocationPath: boolean
      hasDiffContent: boolean
      hasRawInput: boolean
      hasRawOutput: boolean
      hasName: boolean
      hasMeta: boolean
    }
  | {
      kind: 'stderr'
      hasText: boolean
    }

export interface GrokAcpProtocolObserver {
  record(record: GrokAcpObservationRecord): void
  flush?(): Promise<void>
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** 只描述 sessionId 形态，绝不回传真实标识。 */
export function describeSessionIdShape(
  sessionId: string | undefined
): 'uuid' | 'opaque-nonempty' | 'empty' {
  if (!sessionId) return 'empty'
  return UUID_SHAPE.test(sessionId) ? 'uuid' : 'opaque-nonempty'
}

/**
 * 从 ACP initialize 响应抽出可进 Git 的握手字段。调用方必须传入已经过类型收窄的对象。
 */
export function summarizeInitializeResponse(
  response: Record<string, unknown>,
  expectedProtocolVersion: number
): Extract<GrokAcpObservationRecord, { kind: 'initialize' }> {
  const agentInfo = asRecord(response.agentInfo)
  const agentCapabilities = asRecord(response.agentCapabilities)
  const sessionCapabilities = asRecord(agentCapabilities?.sessionCapabilities)
  const promptCapabilities = asRecord(agentCapabilities?.promptCapabilities)
  const protocolVersion =
    typeof response.protocolVersion === 'number' ? response.protocolVersion : 'absent'

  return {
    kind: 'initialize',
    protocolVersion,
    protocolVersionMatches:
      protocolVersion === 'absent' ? 'absent' : protocolVersion === expectedProtocolVersion,
    hasAgentInfoName: typeof agentInfo?.name === 'string' && agentInfo.name.trim().length > 0,
    hasAgentInfoVersion:
      typeof agentInfo?.version === 'string' && agentInfo.version.trim().length > 0,
    loadSession:
      agentCapabilities && 'loadSession' in agentCapabilities
        ? agentCapabilities.loadSession === true
        : 'absent',
    resumeDeclared: sessionCapabilities?.resume != null,
    closeDeclared: sessionCapabilities?.close != null,
    promptImage: presenceFlag(promptCapabilities, 'image'),
    promptAudio: presenceFlag(promptCapabilities, 'audio'),
    promptEmbeddedContext: presenceFlag(promptCapabilities, 'embeddedContext'),
    hasAuth: Array.isArray(response.authMethods) && response.authMethods.length > 0,
    hasProviders: agentCapabilities != null && 'providers' in agentCapabilities,
    hasMeta: '_meta' in response || Boolean(agentInfo && '_meta' in agentInfo)
  }
}

/** 从 session/update 抽出类型与少量布尔，不复制 content / path / raw 正文。 */
export function summarizeSessionUpdate(
  update: Record<string, unknown>
): Extract<GrokAcpObservationRecord, { kind: 'session-update' }> {
  const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : 'unknown'
  const content = asRecord(update.content)
  const locations = Array.isArray(update.locations) ? update.locations : undefined
  const entries = Array.isArray(update.entries) ? update.entries : undefined
  const contentItems = Array.isArray(update.content) ? update.content : undefined

  return {
    kind: 'session-update',
    sessionUpdate,
    ...(content && typeof content.type === 'string' ? { contentType: content.type } : {}),
    ...('messageId' in update ? { hasMessageId: update.messageId != null } : {}),
    ...(typeof update.kind === 'string' ? { toolKind: update.kind } : {}),
    ...(typeof update.status === 'string' ? { status: update.status } : {}),
    ...(locations
      ? {
          hasLocations: locations.length > 0,
          locationHasPath: locations.some(
            (item) => typeof asRecord(item)?.path === 'string' && String(asRecord(item)?.path)
          )
        }
      : {}),
    ...(entries
      ? {
          planEntryCount: entries.length,
          planHasPriority: entries.every((item) => asRecord(item)?.priority != null),
          planHasStatus: entries.every((item) => asRecord(item)?.status != null)
        }
      : {}),
    ...(sessionUpdate === 'usage_update'
      ? {
          hasUsed: 'used' in update,
          hasSize: 'size' in update,
          hasCost: update.cost != null
        }
      : {}),
    ...(contentItems
      ? {
          hasDiffContent: contentItems.some((item) => asRecord(item)?.type === 'diff')
        }
      : {})
  }
}

/** 权限 option 只记 kind 集合和是否唯一，不记 optionId。 */
export function summarizePermissionRequest(
  params: Record<string, unknown>
): Extract<GrokAcpObservationRecord, { kind: 'permission' }> {
  const options = Array.isArray(params.options) ? params.options : []
  const optionKinds = options.flatMap((item) => {
    const kind = asRecord(item)?.kind
    return typeof kind === 'string' ? [kind] : []
  })
  const toolCall = asRecord(params.toolCall)
  const locations = Array.isArray(toolCall?.locations) ? toolCall.locations : []
  const content = Array.isArray(toolCall?.content) ? toolCall.content : []

  return {
    kind: 'permission',
    optionKinds: [...new Set(optionKinds)].sort(),
    uniqueAllowOnce: countKind(options, 'allow_once') === 1,
    uniqueRejectOnce: countKind(options, 'reject_once') === 1,
    toolCallKind: typeof toolCall?.kind === 'string' ? toolCall.kind : 'absent',
    hasLocationPath: locations.some(
      (item) => typeof asRecord(item)?.path === 'string' && String(asRecord(item)?.path)
    ),
    hasDiffContent: content.some((item) => asRecord(item)?.type === 'diff'),
    hasRawInput: toolCall != null && 'rawInput' in toolCall && toolCall.rawInput != null,
    hasRawOutput: toolCall != null && 'rawOutput' in toolCall && toolCall.rawOutput != null,
    hasName: typeof toolCall?.name === 'string' && toolCall.name.length > 0,
    hasMeta: Boolean(toolCall && '_meta' in toolCall) || '_meta' in params
  }
}

/** 把观察记录串行写入隔离 JSONL；生产路径不得创建该文件。 */
export function createGrokAcpFileObserver(filePath: string): GrokAcpProtocolObserver {
  let queue = Promise.resolve()
  return {
    record(record) {
      const line = `${JSON.stringify(record)}\n`
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          await fs.mkdir(dirname(filePath), { recursive: true })
          await fs.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 })
        })
    },
    flush() {
      return queue.catch(() => undefined)
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function presenceFlag(
  record: Record<string, unknown> | undefined,
  key: string
): boolean | 'absent' {
  if (!record || !(key in record)) return 'absent'
  return record[key] === true
}

function countKind(options: unknown[], kind: string): number {
  return options.filter((item) => asRecord(item)?.kind === kind).length
}

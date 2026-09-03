import { promises as fs } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { AgentContextUsage } from '../../../shared/agent'

/** signals.json 只承载运行时指标；读取上限避免异常文件进入主进程内存。 */
const MAX_SIGNALS_FILE_BYTES = 64 * 1024
const MAX_WORKSPACE_BYTES = 4 * 1024
const MAX_SESSION_ID_BYTES = 256

export interface GrokSessionSignalsInput {
  /** App 专属 Managed GROK_HOME；禁止传入用户默认 ~/.grok。 */
  grokHome: string
  workspace: string
  runtimeSessionId: string
}

interface GrokSessionSignalsShape {
  contextTokensUsed?: unknown
  contextWindowTokens?: unknown
  contextWindowUsage?: unknown
}

/**
 * 从当前 Grok session 的 signals.json 投影上下文用量。
 * 这是 Runtime 内部补充事实，失败时静默返回 null，不把路径、原始 JSON 或其它字段带出主进程。
 */
export async function readGrokSessionContextUsage(
  input: GrokSessionSignalsInput
): Promise<AgentContextUsage | null> {
  if (!isBoundedText(input.grokHome, MAX_WORKSPACE_BYTES)) return null
  if (!isBoundedText(input.workspace, MAX_WORKSPACE_BYTES)) return null
  if (!isSafeRuntimeSessionId(input.runtimeSessionId)) return null

  const managedHome = resolve(input.grokHome)
  const signalsPath = resolve(
    managedHome,
    'sessions',
    encodeURIComponent(input.workspace),
    input.runtimeSessionId,
    'signals.json'
  )
  if (!isPathInside(signalsPath, managedHome)) return null

  try {
    const [homeRealPath, signalsRealPath] = await Promise.all([
      fs.realpath(managedHome),
      fs.realpath(signalsPath)
    ])
    if (!isPathInside(signalsRealPath, homeRealPath)) return null

    const handle = await fs.open(signalsRealPath, 'r')
    try {
      const fileStat = await handle.stat()
      if (!fileStat.isFile() || fileStat.size > MAX_SIGNALS_FILE_BYTES) return null

      // 读取时多申请一个字节，防止文件在 stat 后增长导致无界 readFile 分配。
      const buffer = Buffer.allocUnsafe(MAX_SIGNALS_FILE_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_SIGNALS_FILE_BYTES) return null
      return projectContextUsage(
        JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as GrokSessionSignalsShape
      )
    } finally {
      await handle.close().catch(() => undefined)
    }
  } catch {
    // 文件不存在、并发写入中的半 JSON、权限错误和路径竞态均按“暂未观测”处理。
    return null
  }
}

function projectContextUsage(value: GrokSessionSignalsShape): AgentContextUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const usedTokens = readNonNegativeSafeInteger(value.contextTokensUsed)
  const limitTokens = readPositiveSafeInteger(value.contextWindowTokens)
  if (usedTokens == null || limitTokens == null || usedTokens > limitTokens) return null

  if (value.contextWindowUsage !== undefined) {
    const percentage = value.contextWindowUsage
    if (
      typeof percentage !== 'number' ||
      !Number.isFinite(percentage) ||
      percentage < 0 ||
      percentage > 100
    ) {
      return null
    }
  }

  return {
    scope: 'context',
    usedTokens,
    limitTokens
  }
}

function readNonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function readPositiveSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\u0000') &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
  )
}

function isSafeRuntimeSessionId(value: unknown): value is string {
  return (
    isBoundedText(value, MAX_SESSION_ID_BYTES) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

function isPathInside(candidate: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate))
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
}

/** 仅供测试/诊断复用的路径构造；不返回给 Renderer。 */
export function buildGrokSessionSignalsPath(input: GrokSessionSignalsInput): string {
  return join(
    resolve(input.grokHome),
    'sessions',
    encodeURIComponent(input.workspace),
    input.runtimeSessionId,
    'signals.json'
  )
}

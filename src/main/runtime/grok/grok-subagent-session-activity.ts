import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { AgentToolStatus } from '../../../shared/agent'

/** 子代理工具来自 Grok 子 session 落盘，不是父 ACP 时间线。 */
export type GrokSubagentActivitySource = 'grok-session' | 'missing'

export interface GrokSubagentSessionToolRow {
  toolCallId: string
  title: string
  status: AgentToolStatus | 'unknown'
}

export interface GrokSubagentSessionResult {
  text: string
  truncated: boolean
}

export interface GrokSubagentSessionActivity {
  source: GrokSubagentActivitySource
  tools: GrokSubagentSessionToolRow[]
  result?: GrokSubagentSessionResult
}

const MAX_JSONL_BYTES = 8 * 1024 * 1024
const MAX_TOOLS = 200
const MAX_TITLE_BYTES = 4 * 1024
const MAX_TOOL_CALL_ID_BYTES = 256
const MAX_RESULT_BYTES = 32 * 1024
const CHILD_ID_RE = /^[A-Za-z0-9_-]{8,80}$/
const SHORT_ID_RE = /^[A-Za-z0-9_-]{6,32}$/
const TOOL_STATUSES = new Set<AgentToolStatus>([
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled'
])

export function isGrokSubagentShortId(value: string): boolean {
  return SHORT_ID_RE.test(value)
}

/** Grok 把 workspace 编进 sessions 目录名，规则是 encodeURIComponent。 */
export function encodeGrokSessionWorkspaceDir(workspacePath: string): string {
  return encodeURIComponent(workspacePath)
}

/**
 * 从子 session 的 ACP 形 JSONL 抽出工具行。
 * 只认 session/update 的 tool_call / tool_call_update；丢掉 rawInput 和思想块。
 */
export function parseGrokSubagentSessionUpdates(
  jsonl: string,
  redactText: (text: string) => string = (text) => text
): GrokSubagentSessionToolRow[] {
  return parseGrokSubagentSessionActivityUpdates(jsonl, redactText).tools
}

/**
 * 同一遍扫描只保留工具事实与最后一段连续 Agent 文本。
 * 工具、思想或新的过程活动出现后会清空候选，避免把过程播报误当最终结果。
 */
export function parseGrokSubagentSessionActivityUpdates(
  jsonl: string,
  redactText: (text: string) => string = (text) => text
): { tools: GrokSubagentSessionToolRow[]; result?: GrokSubagentSessionResult } {
  const tools = new Map<string, GrokSubagentSessionToolRow>()
  const order: string[] = []
  let resultChunks: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    const parsed = parseJsonObject(line)
    if (!parsed || parsed.method !== 'session/update') continue
    const params = asRecord(parsed.params)
    const update = asRecord(params?.update)
    const sessionUpdate = update?.sessionUpdate
    if (sessionUpdate === 'agent_message_chunk') {
      const content = asRecord(update?.content)
      const text = content?.type === 'text' ? readBoundedText(content.text, MAX_JSONL_BYTES) : null
      if (text) resultChunks.push(text)
      continue
    }
    if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') {
      if (sessionUpdate === 'agent_thought_chunk') resultChunks = []
      continue
    }
    resultChunks = []
    const toolCallId = readBoundedText(update?.toolCallId, MAX_TOOL_CALL_ID_BYTES)
    if (!toolCallId) continue
    const current = tools.get(toolCallId) ?? {
      toolCallId,
      title: toolCallId,
      status: 'unknown' as const
    }
    const title = readBoundedText(update?.title, MAX_TITLE_BYTES)
    if (title) current.title = redactText(title)
    const status = mapToolStatus(update?.status)
    if (status) current.status = status
    if (!tools.has(toolCallId)) {
      if (order.length >= MAX_TOOLS) continue
      order.push(toolCallId)
    }
    tools.set(toolCallId, current)
  }
  const orderedTools = order
    .map((id) => tools.get(id))
    .filter((row): row is GrokSubagentSessionToolRow => Boolean(row))
  const rawResult = resultChunks.join('')
  const boundedResult = rawResult.trim()
    ? truncateUtf8(redactText(rawResult), MAX_RESULT_BYTES)
    : null
  return {
    tools: orderedTools,
    ...(boundedResult?.text.trim() ? { result: boundedResult } : {})
  }
}

/** 只在当前 Task 的父 Runtime session 下定位孩子，避免跨 Task 命中旧会话。 */
export async function readGrokSubagentSessionActivity(input: {
  grokHome: string
  workspacePath: string
  parentRuntimeSessionId: string
  shortId: string
  redactText?: (text: string) => string
}): Promise<GrokSubagentSessionActivity> {
  const empty: GrokSubagentSessionActivity = { source: 'missing', tools: [] }
  if (!isGrokSubagentShortId(input.shortId) || !CHILD_ID_RE.test(input.parentRuntimeSessionId)) {
    return empty
  }
  const grokHome = (await realPathIfExists(resolve(input.grokHome))) ?? resolve(input.grokHome)
  const sessionsDir = join(grokHome, 'sessions', encodeGrokSessionWorkspaceDir(input.workspacePath))
  if (!(await isSafeDirectory(sessionsDir, grokHome))) return empty
  const child = await findChildSession(
    sessionsDir,
    input.parentRuntimeSessionId,
    input.shortId,
    grokHome
  )
  if (!child) return empty
  const updatesPath = join(sessionsDir, child.childId, 'updates.jsonl')
  if (!(await isSafeFile(updatesPath, grokHome))) return empty
  const jsonl = await readBoundedUtf8(updatesPath, MAX_JSONL_BYTES)
  const parsed = parseGrokSubagentSessionActivityUpdates(jsonl.text, input.redactText)
  const terminal = child.status === 'completed' || child.status === 'failed'
  return {
    source: 'grok-session',
    tools: parsed.tools,
    ...(!jsonl.truncated && terminal && parsed.result ? { result: parsed.result } : {})
  }
}

async function findChildSession(
  sessionsDir: string,
  parentRuntimeSessionId: string,
  shortId: string,
  grokHome: string
): Promise<{ childId: string; status?: string } | null> {
  const parentDir = join(sessionsDir, parentRuntimeSessionId)
  if (!(await isSafeDirectory(parentDir, grokHome))) return null
  const subagentsDir = join(parentDir, 'subagents')
  if (!(await isSafeDirectory(subagentsDir, grokHome))) return null
  const childEntries = await fs.readdir(subagentsDir, { withFileTypes: true })
  for (const child of childEntries) {
    if (!child.isDirectory() || !CHILD_ID_RE.test(child.name) || !child.name.startsWith(shortId)) {
      continue
    }
    const metaPath = join(subagentsDir, child.name, 'meta.json')
    if (!(await isSafeFile(metaPath, grokHome))) continue
    const metaText = await readBoundedUtf8(metaPath, 64 * 1024)
    if (metaText.truncated) continue
    const meta = parseJsonObject(metaText.text)
    const childId = readChildIdFromMeta(meta, shortId)
    const status = readBoundedText(meta?.status, 32) ?? undefined
    if (childId && (await isSafeDirectory(join(sessionsDir, childId), grokHome))) {
      return { childId, ...(status ? { status } : {}) }
    }
  }
  return null
}

function readChildIdFromMeta(meta: Record<string, unknown> | null, shortId: string): string | null {
  const childSessionId = readBoundedText(meta?.child_session_id, 80)
  const subagentId = readBoundedText(meta?.subagent_id, 80)
  for (const candidate of [childSessionId, subagentId]) {
    if (candidate && CHILD_ID_RE.test(candidate) && candidate.startsWith(shortId)) return candidate
  }
  return null
}

function mapToolStatus(value: unknown): AgentToolStatus | 'unknown' | undefined {
  if (typeof value !== 'string') return undefined
  if (TOOL_STATUSES.has(value as AgentToolStatus)) return value as AgentToolStatus
  return 'unknown'
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return asRecord(value)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readBoundedText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return null
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return null
  return value
}

async function readBoundedUtf8(
  path: string,
  maxBytes: number
): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(path, 'r')
  try {
    const stat = await handle.stat()
    const size = Math.min(Math.max(0, stat.size), maxBytes)
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, 0)
    return { text: buffer.toString('utf8'), truncated: stat.size > maxBytes }
  } finally {
    await handle.close()
  }
}

/** 按 UTF-8 字节截断，避免把多字节字符切成乱码。 */
function truncateUtf8(text: string, maxBytes: number): GrokSubagentSessionResult {
  const chunks: string[] = []
  let bytes = 0
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > maxBytes) {
      return { text: chunks.join(''), truncated: true }
    }
    chunks.push(character)
    bytes += characterBytes
  }
  return { text, truncated: false }
}

async function isSafeDirectory(path: string, grokHome: string): Promise<boolean> {
  const real = await realPathIfExists(path)
  if (!real) return false
  try {
    const stat = await fs.lstat(path)
    return stat.isDirectory() && isPathInsideRoot(grokHome, real)
  } catch {
    return false
  }
}

async function isSafeFile(path: string, grokHome: string): Promise<boolean> {
  const real = await realPathIfExists(path)
  if (!real) return false
  try {
    const stat = await fs.lstat(path)
    return stat.isFile() && isPathInsideRoot(grokHome, real)
  } catch {
    return false
  }
}

async function realPathIfExists(path: string): Promise<string | null> {
  try {
    return await fs.realpath(path)
  } catch {
    return null
  }
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep
  return candidate === root || candidate.startsWith(prefix)
}

#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- fixture 必须作为无构建的 ESM 脚本由 ELECTRON_RUN_AS_NODE 直接执行。 */
/**
 * 受控 ACP Runtime Electron E2E fixture。
 * stdout 只承载官方 ACP NDJSON；测试同步信息只写入隔离 trace，绝不记录 Prompt、环境或 Provider 配置。
 */
import { promises as fs, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import * as acp from '@agentclientprotocol/sdk'

const SCENARIOS = new Set([
  'E2E:FIFO',
  'E2E:TOOLCALL_CANCEL',
  'E2E:TURN_CANCEL',
  'E2E:EXECUTE_UNSUPPORTED',
  'E2E:LONG_RUNNING',
  'E2E:PERMISSION_WAIT',
  'E2E:IGNORE_CANCEL',
  'E2E:RUNTIME_CRASH'
])
const TEMPORARY_USER_DATA_PREFIX = 'agent-studio-controlled-acp-e2e-'
const DIRECTORIES = {
  workspace: 'controlled-acp-e2e-workspace',
  trace: 'controlled-acp-e2e-trace',
  barriers: 'controlled-acp-e2e-barriers'
}
const MARKER_FILE = 'permission-e2e-marker.txt'
const TRACE_FILE = 'fixture-trace.jsonl'
const MAX_ARGUMENT_BYTES = 16 * 1024
const SESSION_ID = 'controlled-acp-session'
const RAW_INPUT_SENTINEL = 'E2E_RAW_INPUT_MUST_NOT_DISPLAY'

const configuration = readConfiguration(process.argv.slice(2))
if (!configuration) {
  process.exitCode = 1
} else {
  await run(configuration).catch(() => {
    // fixture 失败只用退出码表达；stderr 不携带路径、Prompt、环境或 Provider 内容。
    process.exitCode = 1
  })
}

/** 夹具只接受 Adapter 传入的固定场景与临时 userData，目录全部自行派生，绝不解释自由路径。 */
function readConfiguration(argv) {
  if (
    argv.length !== 4 ||
    argv[0] !== '--scenario' ||
    argv[2] !== '--user-data' ||
    typeof argv[1] !== 'string' ||
    typeof argv[3] !== 'string'
  ) {
    return null
  }
  const scenario = argv[1]
  const userDataPath = argv[3]
  if (!scenario || !SCENARIOS.has(scenario) || !isSafeAbsolutePath(userDataPath)) {
    return null
  }
  return { scenario, userDataPath: resolve(userDataPath) }
}

function isSafeAbsolutePath(value) {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_ARGUMENT_BYTES
  )
}

async function run({ scenario, userDataPath }) {
  const { workspace, traceDirectory, barrierDirectory } =
    await resolveControlledLayout(userDataPath)

  const trace = createTraceWriter(traceDirectory, scenario)
  const sessions = new Map()
  let sessionSequence = 0
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
  const app = acp
    .agent({ name: 'controlled-acp-runtime-e2e' })
    .onRequest('initialize', async () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      agentInfo: { name: 'controlled-acp-runtime-e2e', version: '1.0.0' }
    }))
    .onRequest('session/new', async () => {
      sessionSequence += 1
      const sessionId = sessionSequence === 1 ? SESSION_ID : `${SESSION_ID}-${sessionSequence}`
      sessions.set(sessionId, { cancellation: null })
      await trace({ event: 'session-created', sessionId })
      return { sessionId }
    })
    // GrokAcpAdapter 会绑定 App 私有模型别名；fixture 只确认协议往返，不读取模型或 Provider 内容。
    .onRequest('session/set_model', createSetModelParser(), async () => ({}))
    .onRequest('session/load', async (context) => {
      if (!sessions.has(context.params.sessionId)) throw new Error('unknown-session')
      await trace({ event: 'session-loaded', sessionId: context.params.sessionId })
      return {}
    })
    .onRequest('session/resume', async (context) => {
      if (!sessions.has(context.params.sessionId)) throw new Error('unknown-session')
      await trace({ event: 'session-resumed', sessionId: context.params.sessionId })
      return {}
    })
    .onRequest('session/prompt', async (context) => {
      const session = sessions.get(context.params.sessionId)
      if (!session) throw new Error('unknown-session')
      const cancellation = new AbortController()
      session.cancellation = cancellation
      await trace({ event: 'prompt-started', sessionId: context.params.sessionId })
      try {
        const stopReason = await runScenario({
          scenario,
          sessionId: context.params.sessionId,
          workspace,
          barrierDirectory,
          client: context.client,
          signal: cancellation.signal,
          trace
        })
        await trace({ event: 'prompt-finished', sessionId: context.params.sessionId, stopReason })
        return { stopReason }
      } finally {
        session.cancellation = null
      }
    })
    .onNotification('session/cancel', async (context) => {
      const session = sessions.get(context.params.sessionId)
      await trace({
        event: 'session-cancelled',
        sessionId: context.params.sessionId,
        ignored: scenario === 'E2E:IGNORE_CANCEL'
      })
      if (scenario === 'E2E:IGNORE_CANCEL') return
      session?.cancellation?.abort()
    })

  app.connect(stream)
}

/** 临时目录必须位于系统 tmp 的固定直接子树；fixture 不可被单独调用去触碰任意工作区。 */
async function resolveControlledLayout(userDataPath) {
  const resolvedUserDataPath = resolve(userDataPath)
  const canonicalTemporaryDirectory = await fs.realpath(tmpdir())
  const userDataStats = await fs.lstat(resolvedUserDataPath)
  if (
    !userDataStats.isDirectory() ||
    userDataStats.isSymbolicLink() ||
    !isPrivateEnough(userDataStats.mode)
  ) {
    throw new Error('invalid-user-data')
  }
  const canonicalUserDataPath = await fs.realpath(resolvedUserDataPath)
  if (
    canonicalUserDataPath !== resolvedUserDataPath ||
    dirname(canonicalUserDataPath) !== canonicalTemporaryDirectory ||
    !basename(canonicalUserDataPath).startsWith(TEMPORARY_USER_DATA_PREFIX)
  ) {
    throw new Error('invalid-user-data')
  }
  const [workspace, traceDirectory, barrierDirectory] = await Promise.all([
    assertDirectChildDirectory(canonicalUserDataPath, DIRECTORIES.workspace),
    assertDirectChildDirectory(canonicalUserDataPath, DIRECTORIES.trace),
    assertDirectChildDirectory(canonicalUserDataPath, DIRECTORIES.barriers)
  ])
  await assertMarker(workspace)
  return { workspace, traceDirectory, barrierDirectory }
}

/** 所有 fixture 可写目录均必须是临时 userData 下的固定普通目录，拒绝符号链接。 */
async function assertDirectChildDirectory(parent, name) {
  const expected = join(parent, name)
  const stats = await fs.lstat(expected)
  if (!stats.isDirectory() || stats.isSymbolicLink() || !isPrivateEnough(stats.mode)) {
    throw new Error('invalid-directory')
  }
  const canonical = await fs.realpath(expected)
  if (canonical !== expected || dirname(canonical) !== parent) throw new Error('invalid-directory')
  return canonical
}

function createSetModelParser() {
  return {
    parse(value) {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof value.sessionId !== 'string' ||
        typeof value.modelId !== 'string'
      ) {
        throw new Error('invalid-set-model')
      }
      return { sessionId: value.sessionId, modelId: value.modelId }
    }
  }
}

async function runScenario(context) {
  switch (context.scenario) {
    case 'E2E:FIFO':
      return runFifoScenario(context)
    case 'E2E:TOOLCALL_CANCEL':
      return runToolCallCancellationScenario(context)
    case 'E2E:TURN_CANCEL':
      return runTurnCancellationScenario(context)
    case 'E2E:EXECUTE_UNSUPPORTED':
      return runExecuteUnsupportedScenario(context)
    case 'E2E:LONG_RUNNING':
      return runLongRunningScenario(context)
    case 'E2E:PERMISSION_WAIT':
      return runPermissionWaitScenario(context)
    case 'E2E:IGNORE_CANCEL':
      return runIgnoreCancelScenario(context)
    case 'E2E:RUNTIME_CRASH':
      return runRuntimeCrashScenario(context)
  }
}

/** 长任务只等待固定 barrier，供窗口 reload、Task/Project 浏览和后台终态测试使用。 */
async function runLongRunningScenario(context) {
  await context.trace({ event: 'long-running-waiting' })
  await waitForBarrier(context.barrierDirectory, 'long-running-release', context.signal)
  return context.signal.aborted ? 'cancelled' : 'end_turn'
}

/** 审批保持未决直到真实 UI 响应；允许后只写固定 marker。 */
async function runPermissionWaitScenario(context) {
  const response = await requestPermission(context, 'lifecycle-permission', '写入生命周期 marker')
  await context.trace({
    event: 'permission-resolved',
    request: 'lifecycle',
    outcome: outcomeName(response)
  })
  if (isAllowed(response, 'allow-lifecycle-permission')) {
    await writeMarker(context.workspace, 'P')
  }
  return context.signal.aborted ? 'cancelled' : 'end_turn'
}

/** Runtime 明确收到 cancel 但故意不收束，验证 Main 的取消 deadline 与强制断开。 */
async function runIgnoreCancelScenario(context) {
  await context.trace({ event: 'ignore-cancel-waiting' })
  await waitForBarrier(context.barrierDirectory, 'ignore-cancel-release')
  return 'end_turn'
}

/** barrier 释放后先落固定 trace，再以非零退出码模拟 Runtime 崩溃。 */
async function runRuntimeCrashScenario(context) {
  await context.trace({ event: 'runtime-crash-waiting' })
  await waitForBarrier(context.barrierDirectory, 'runtime-crash', context.signal)
  await context.trace({ event: 'runtime-crash-exit', code: 17 })
  process.exit(17)
}

/** 两个 ACP request 在首项未决时发出；fixture 不提前解析或执行用户 Prompt。 */
async function runFifoScenario(context) {
  const requestA = requestPermission(context, 'fifo-A', '写入受控 marker A')
  await context.trace({ event: 'permission-dispatched', request: 'A', toolCallId: 'fifo-A' })
  const requestB = requestPermission(context, 'fifo-B', '写入受控 marker B')
  await context.trace({ event: 'permission-dispatched', request: 'B', toolCallId: 'fifo-B' })
  await context.trace({ event: 'both-permissions-dispatched' })

  const [responseA, responseB] = await Promise.all([requestA, requestB])
  await context.trace({
    event: 'permission-resolved',
    request: 'A',
    outcome: outcomeName(responseA)
  })
  await context.trace({
    event: 'permission-resolved',
    request: 'B',
    outcome: outcomeName(responseB)
  })
  if (isAllowed(responseA, 'allow-fifo-A')) await writeMarker(context.workspace, 'A')
  return context.signal.aborted ? 'cancelled' : 'end_turn'
}

/** A 终态由 barrier 精确触发；B 的 ACP request 始终保留给真实 UI 响应。 */
async function runToolCallCancellationScenario(context) {
  const requestA = requestPermission(context, 'toolcall-A', '写入受控 marker A')
  await context.trace({ event: 'permission-dispatched', request: 'A', toolCallId: 'toolcall-A' })
  const requestB = requestPermission(context, 'toolcall-B', '写入受控 marker B')
  await context.trace({ event: 'permission-dispatched', request: 'B', toolCallId: 'toolcall-B' })
  await context.trace({ event: 'both-permissions-dispatched' })

  await waitForBarrier(context.barrierDirectory, 'toolcall-cancel-A', context.signal)
  await context.client.notify(acp.methods.client.session.update, {
    sessionId: context.sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'toolcall-A', status: 'completed' }
  })
  await context.trace({ event: 'toolcall-completed', request: 'A', toolCallId: 'toolcall-A' })

  const responseA = await requestA
  await context.trace({
    event: 'permission-resolved',
    request: 'A',
    outcome: outcomeName(responseA)
  })
  const responseB = await requestB
  await context.trace({
    event: 'permission-resolved',
    request: 'B',
    outcome: outcomeName(responseB)
  })
  if (isAllowed(responseB, 'allow-toolcall-B')) await writeMarker(context.workspace, 'B')
  return context.signal.aborted ? 'cancelled' : 'end_turn'
}

/** Turn 取消后继续等待同一 session 的 ACP cancel，避免 request 本地取消抢先伪造终态。 */
async function runTurnCancellationScenario(context) {
  const responseRequest = requestExecutePermission(context, 'turn-cancel-execute', true)
  await context.trace({
    event: 'permission-dispatched',
    request: 'execute',
    toolCallId: 'turn-cancel-execute'
  })
  const response = await responseRequest
  await context.trace({
    event: 'permission-resolved',
    request: 'execute',
    outcome: outcomeName(response)
  })
  if (!context.signal.aborted) await waitForAbort(context.signal)
  return 'cancelled'
}

/** 合法 execute 先走 UI，后续缺失或重复 allow_once 必须由 Adapter→Broker 自动安全取消。 */
async function runExecuteUnsupportedScenario(context) {
  const legal = await requestExecutePermission(context, 'execute-legal', true)
  await context.trace({
    event: 'permission-resolved',
    request: 'legal-execute',
    outcome: outcomeName(legal)
  })

  const missing = await context.client.request(acp.methods.client.session.requestPermission, {
    sessionId: context.sessionId,
    toolCall: executeToolCall('execute-missing-allow-once'),
    options: [{ optionId: 'reject-missing', name: '拒绝一次', kind: 'reject_once' }]
  })
  await context.trace({
    event: 'permission-resolved',
    request: 'missing-allow-once',
    outcome: outcomeName(missing)
  })

  const duplicated = await context.client.request(acp.methods.client.session.requestPermission, {
    sessionId: context.sessionId,
    toolCall: executeToolCall('execute-duplicate-allow-once'),
    options: [
      { optionId: 'allow-duplicate-A', name: '允许一次 A', kind: 'allow_once' },
      { optionId: 'allow-duplicate-B', name: '允许一次 B', kind: 'allow_once' },
      { optionId: 'reject-duplicate', name: '拒绝一次', kind: 'reject_once' }
    ]
  })
  await context.trace({
    event: 'permission-resolved',
    request: 'duplicate-allow-once',
    outcome: outcomeName(duplicated)
  })
  return context.signal.aborted ? 'cancelled' : 'end_turn'
}

function requestPermission(context, toolCallId, title) {
  return context.client.request(acp.methods.client.session.requestPermission, {
    sessionId: context.sessionId,
    toolCall: {
      toolCallId,
      title,
      kind: 'edit',
      status: 'pending',
      locations: [{ path: join(context.workspace, MARKER_FILE) }]
    },
    options: [
      { optionId: `allow-${toolCallId}`, name: '允许一次', kind: 'allow_once' },
      { optionId: `reject-${toolCallId}`, name: '拒绝一次', kind: 'reject_once' }
    ]
  })
}

function requestExecutePermission(context, toolCallId, includeAllowOnce) {
  return context.client.request(acp.methods.client.session.requestPermission, {
    sessionId: context.sessionId,
    toolCall: executeToolCall(toolCallId),
    options: includeAllowOnce
      ? [
          { optionId: `allow-${toolCallId}`, name: '允许一次', kind: 'allow_once' },
          { optionId: `reject-${toolCallId}`, name: '拒绝一次', kind: 'reject_once' }
        ]
      : [{ optionId: `reject-${toolCallId}`, name: '拒绝一次', kind: 'reject_once' }]
  })
}

function executeToolCall(toolCallId) {
  return {
    toolCallId,
    title: '执行受控命令',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: RAW_INPUT_SENTINEL }
  }
}

function isAllowed(response, optionId) {
  return response?.outcome?.outcome === 'selected' && response.outcome.optionId === optionId
}

function outcomeName(response) {
  return response?.outcome?.outcome === 'selected'
    ? `selected:${response.outcome.optionId}`
    : 'cancelled'
}

/** 所有 trace 字段均为固定枚举、固定 session 或 option 结果，绝不写入 Prompt/环境/Provider。 */
function createTraceWriter(traceDirectory, scenario) {
  const tracePath = join(traceDirectory, TRACE_FILE)
  let sequence = 0
  let queue = Promise.resolve()
  return (entry) => {
    const record = JSON.stringify({ sequence: ++sequence, scenario, ...entry })
    queue = queue.then(() =>
      fs.appendFile(tracePath, `${record}\n`, { encoding: 'utf8', mode: 0o600 })
    )
    return queue
  }
}

/** barrier 通过文件系统事件与二次检查同步，测试不依赖固定 sleep 猜测竞态。 */
async function waitForBarrier(directory, name, signal) {
  const barrierPath = join(directory, `${name}.ready`)
  if (signal?.aborted) throw new Error('cancelled')
  if (await isRegularFile(barrierPath)) return
  await new Promise((resolveBarrier, rejectBarrier) => {
    let settled = false
    let watcher
    const finish = (complete) => {
      if (settled) return
      settled = true
      watcher?.close()
      signal?.removeEventListener('abort', abort)
      complete()
    }
    const abort = () => finish(() => rejectBarrier(new Error('cancelled')))
    try {
      watcher = watch(directory, { persistent: false }, () => {
        void isRegularFile(barrierPath).then(
          (available) => {
            if (available) finish(resolveBarrier)
          },
          (error) => finish(() => rejectBarrier(error))
        )
      })
      watcher.once('error', (error) => finish(() => rejectBarrier(error)))
    } catch (error) {
      finish(() => rejectBarrier(error))
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    void isRegularFile(barrierPath).then(
      (available) => {
        if (available) finish(resolveBarrier)
      },
      (error) => finish(() => rejectBarrier(error))
    )
  })
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolveAbort) =>
    signal.addEventListener('abort', resolveAbort, { once: true })
  )
}

async function assertMarker(workspace) {
  const markerPath = join(workspace, MARKER_FILE)
  const stats = await fs.lstat(markerPath)
  if (!stats.isFile() || stats.isSymbolicLink() || !isPrivateEnough(stats.mode)) {
    throw new Error('invalid-marker')
  }
}

async function isRegularFile(path) {
  try {
    const stats = await fs.lstat(path)
    return stats.isFile() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

/** fixture 只会覆盖已验证的固定 marker，不会执行或写入任何用户提供的命令、路径。 */
async function writeMarker(workspace, value) {
  await assertMarker(workspace)
  await fs.writeFile(join(workspace, MARKER_FILE), `${value}\n`, { encoding: 'utf8', mode: 0o600 })
}

/** Unix 上只接受 owner 私有目录或文件；Windows 仍由 ACL 和当前 Electron 用户上下文约束。 */
function isPrivateEnough(mode) {
  return process.platform === 'win32' || (mode & 0o077) === 0
}

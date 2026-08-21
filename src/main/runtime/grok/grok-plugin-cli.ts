import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { AGENT_STUDIO_MODEL_API_KEY_ENV } from '../../provider/grok-provider-config'
import { redactSensitiveText } from '../../security/sensitive-redaction'

const LEADER_SOCKET_FILE = 'studio-plugin.sock'
const LEADER_SOCKET_FLAG = '--leader-socket'
const ERROR_MESSAGE_LIMIT_BYTES = 2 * 1024
const STREAM_CAPTURE_LIMIT = 8 * 1024

/**
 * 返回桌面 plugin CLI 专用的 leader socket 路径。
 * 必须落在 App grok-home 内，禁止默认连上用户 ~/.grok/leader.sock。
 */
export function grokPluginLeaderSocket(grokHome: string): string {
  return join(grokHome, LEADER_SOCKET_FILE)
}

/**
 * 在 App grok-home 下执行 `grok plugin …`。
 * 自动注入受管 `--leader-socket`，覆盖 `GROK_HOME`，不附加 `--trust`（由调用方决定）。
 * 调用方若自带 `--leader-socket` 或 `args[0]` 不是 `plugin`，拒绝 spawn。
 * 子进程环境会剥掉 `AGENT_STUDIO_MODEL_API_KEY`，且不得改写全局 `process.env`。
 */
export async function runGrokPlugin(input: {
  grokHome: string
  grokBinary: string
  args: string[]
  timeoutMs: number
}): Promise<{ ok: true; stdout: string } | { ok: false; message: string }> {
  const grokHome = isNonEmptyPath(input.grokHome) ? input.grokHome : ''
  try {
    if (!isNonEmptyPath(input.grokHome) || !isNonEmptyPath(input.grokBinary)) {
      return failure('Grok plugin 命令无效。', grokHome)
    }
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
      return failure('Grok plugin 命令无效。', grokHome)
    }
    if (!Array.isArray(input.args) || !input.args.every((arg) => isSafeCliArg(arg))) {
      return failure('Grok plugin 命令无效。', grokHome)
    }
    if (input.args[0] !== 'plugin') {
      return failure('Grok plugin 命令无效。', grokHome)
    }
    if (includesCallerLeaderSocket(input.args)) {
      return failure('禁止指定自定义 leader-socket。', grokHome)
    }

    const socket = grokPluginLeaderSocket(input.grokHome)
    const argv = ['plugin', LEADER_SOCKET_FLAG, socket, ...input.args.slice(1)]
    const env = buildPluginCliEnvironment(input.grokHome, process.env)

    let child: ChildProcess
    try {
      child = spawn(input.grokBinary, argv, {
        cwd: input.grokHome,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch {
      return failure('无法启动 Grok plugin 命令。', grokHome)
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout = appendLimited(stdout, chunk, STREAM_CAPTURE_LIMIT)
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendLimited(stderr, chunk, STREAM_CAPTURE_LIMIT)
    })

    const outcome = await waitForPluginProcess(child, input.timeoutMs)
    if (outcome.timedOut) {
      return failure('Grok plugin 命令超时。', grokHome)
    }
    if (outcome.spawnError) {
      return failure('无法启动 Grok plugin 命令。', grokHome)
    }
    if (outcome.exitCode !== 0) {
      return { ok: false, message: toFailureMessage(stdout, stderr, grokHome) }
    }

    const apiKey = process.env[AGENT_STUDIO_MODEL_API_KEY_ENV]
    return {
      ok: true,
      stdout: apiKey ? redactSensitiveText(stdout, [apiKey]) : stdout
    }
  } catch {
    return failure('Grok plugin 命令失败。', grokHome)
  }
}

/**
 * 构造 plugin CLI 子进程环境：强制 GROK_HOME 为 App grok-home，
 * 并剥离模型 Key，避免安装流程把宿主密钥写进 argv 或错误文本。
 */
function buildPluginCliEnvironment(
  grokHome: string,
  sourceEnvironment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...sourceEnvironment }
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === AGENT_STUDIO_MODEL_API_KEY_ENV) {
      delete environment[name]
    }
  }
  environment.GROK_HOME = grokHome
  return environment
}

/**
 * 超时后杀掉整个进程组。Unix 必须在独立 process group 里 spawn，
 * 否则 `kill(-pid)` 会误伤 vitest / Electron 主进程。
 */
function killGrokPluginProcessGroup(child: ChildProcess): void {
  const pid = child.pid
  if (process.platform === 'win32') {
    if (pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        // 进程可能已经退出。
      }
    }
    return
  }

  if (pid) {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // 回退到杀当前子进程。
    }
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 进程可能已经退出。
  }
}

function waitForPluginProcess(
  child: ChildProcess,
  timeoutMs: number
): Promise<{ timedOut: boolean; spawnError: Error | null; exitCode: number | null }> {
  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    let spawnError: Error | null = null
    let exitCode: number | null = null
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      resolve({ timedOut, spawnError, exitCode })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGrokPluginProcessGroup(child)
      // 等进程组真正退出后再返回，避免调用方读到仍存活的 pid。
      graceTimer = setTimeout(finish, 1000)
    }, timeoutMs)

    child.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error('spawn failed')
      finish()
    })
    child.once('close', (code) => {
      exitCode = code
      finish()
    })
  })
}

function includesCallerLeaderSocket(args: string[]): boolean {
  return args.some((arg) => arg === LEADER_SOCKET_FLAG || arg.startsWith(`${LEADER_SOCKET_FLAG}=`))
}

function collectKnownSecrets(grokHome: string): string[] {
  const secrets: string[] = []
  if (grokHome) secrets.push(grokHome)
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase() === AGENT_STUDIO_MODEL_API_KEY_ENV && value) {
      secrets.push(value)
    }
  }
  return secrets
}

function failure(message: string, grokHome: string): { ok: false; message: string } {
  return {
    ok: false,
    message: truncateUtf8(
      redactSensitiveText(message, collectKnownSecrets(grokHome)),
      ERROR_MESSAGE_LIMIT_BYTES
    )
  }
}

function toFailureMessage(stdout: string, stderr: string, grokHome: string): string {
  const combined = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join('\n')
  const redacted = redactSensitiveText(combined, collectKnownSecrets(grokHome))
  const truncated = truncateUtf8(redacted, ERROR_MESSAGE_LIMIT_BYTES).trim()
  return truncated || 'Grok plugin 命令失败。'
}

function appendLimited(current: string, chunk: string, maxChars: number): string {
  if (current.length >= maxChars) return current
  const next = current + chunk
  return next.length <= maxChars ? next : next.slice(0, maxChars)
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  return buffer.subarray(0, maxBytes).toString('utf8')
}

function isNonEmptyPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

function isSafeCliArg(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0')
}

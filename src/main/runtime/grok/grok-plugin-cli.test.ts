import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_STUDIO_MODEL_API_KEY_ENV } from '../../provider/grok-provider-config'
import { grokPluginLeaderSocket, runGrokPlugin } from './grok-plugin-cli'

const FAKE_API_KEY = 'sk-agent-studio-fake-plugin-cli-key-not-real'
const PLANTED_NPM_TOKEN = 'planted-npm-token-not-real'
const PLANTED_XAI_API_KEY = 'planted-xai-api-key-not-real'
const PLANTED_GIT_SSH_COMMAND = 'ssh -i /secret/id_rsa'
const SECRET_STDERR_PATH = '/Users/secret/project/file.ts'
const SECRET_STDERR_URL = 'https://evil.example/repo.git'
const SPAWN_DUMP_FILE = 'grok-plugin-spawn-dump.json'
const USER_LEADER_SOCKET = join(homedir(), '.grok', 'leader.sock')

const temporaryDirectories: string[] = []
const originalModelApiKey = process.env[AGENT_STUDIO_MODEL_API_KEY_ENV]
const originalNpmToken = process.env.NPM_TOKEN
const originalXaiApiKey = process.env.XAI_API_KEY
const originalGitSshCommand = process.env.GIT_SSH_COMMAND
const originalGitAskpass = process.env.GIT_ASKPASS

interface SpawnDump {
  argv: string[]
  cwd: string
  grokHome: string | null
  hasModelApiKey: boolean
  modelApiKey: string | null
  npmToken: string | null
  xaiApiKey: string | null
  gitSshCommand: string | null
  gitAskpass: string | null
  pid: number
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  temporaryDirectories.push(path)
  return path
}

function restoreEnvVar(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = original
}

function restoreHostEnvironment(): void {
  restoreEnvVar(AGENT_STUDIO_MODEL_API_KEY_ENV, originalModelApiKey)
  restoreEnvVar('NPM_TOKEN', originalNpmToken)
  restoreEnvVar('XAI_API_KEY', originalXaiApiKey)
  restoreEnvVar('GIT_SSH_COMMAND', originalGitSshCommand)
  restoreEnvVar('GIT_ASKPASS', originalGitAskpass)
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPidBestEffort(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 进程组可能已经退出，或不存在。
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 单进程可能已经退出。
  }
}

afterEach(async () => {
  restoreHostEnvironment()

  for (const directory of temporaryDirectories) {
    try {
      const dump = await readSpawnDump(join(directory, 'grok-home'))
      if (typeof dump.pid === 'number' && dump.pid > 0 && isPidAlive(dump.pid)) {
        killPidBestEffort(dump.pid)
      }
    } catch {
      // 未 spawn 或 dump 尚未写出。
    }
  }

  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createGrokHome(): Promise<string> {
  const root = await createTemporaryDirectory('agent-studio-plugin-cli-')
  const grokHome = join(root, 'grok-home')
  await mkdir(grokHome, { recursive: true })
  return realpath(grokHome)
}

async function writeFakeGrok(mode: 'ok' | 'fail' | 'sleep'): Promise<{
  grokHome: string
  grokBinary: string
}> {
  const grokHome = await createGrokHome()
  const grokBinary = join(grokHome, '..', `fake-grok-${mode}`)
  const script = `#!${process.execPath}
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const MODE = ${JSON.stringify(mode)}
const FAIL_KEY = ${JSON.stringify(FAKE_API_KEY)}
const dump = {
  argv: process.argv,
  cwd: process.cwd(),
  grokHome: process.env.GROK_HOME ?? null,
  hasModelApiKey: Object.prototype.hasOwnProperty.call(
    process.env,
    ${JSON.stringify(AGENT_STUDIO_MODEL_API_KEY_ENV)}
  ),
  modelApiKey: process.env[${JSON.stringify(AGENT_STUDIO_MODEL_API_KEY_ENV)}] ?? null,
  npmToken: process.env.NPM_TOKEN ?? null,
  xaiApiKey: process.env.XAI_API_KEY ?? null,
  gitSshCommand: process.env.GIT_SSH_COMMAND ?? null,
  gitAskpass: process.env.GIT_ASKPASS ?? null,
  pid: process.pid
}
writeFileSync(join(process.cwd(), ${JSON.stringify(SPAWN_DUMP_FILE)}), JSON.stringify(dump), 'utf8')
if (MODE === 'sleep') {
  setInterval(() => {}, 1 << 30)
} else if (MODE === 'fail') {
  process.stderr.write(
    'plugin-cli-fixture-failed cwd=' +
      process.cwd() +
      ' grokHome=' +
      String(process.env.GROK_HOME ?? '') +
      ' key=' +
      FAIL_KEY +
      ' ' +
      ${JSON.stringify(SECRET_STDERR_PATH)} +
      ' ' +
      ${JSON.stringify(SECRET_STDERR_URL)} +
      '\\n'
  )
  process.stderr.write('E'.repeat(4000) + '\\n')
  process.exit(7)
} else {
  process.stdout.write('plugin-ok\\n')
}
`
  await writeFile(grokBinary, script, { encoding: 'utf8', mode: 0o755 })
  if (process.platform !== 'win32') {
    await chmod(grokBinary, 0o755)
  }
  return { grokHome, grokBinary: await realpath(grokBinary) }
}

async function readSpawnDump(grokHome: string): Promise<SpawnDump> {
  const raw = await readFile(join(grokHome, SPAWN_DUMP_FILE), 'utf8')
  return JSON.parse(raw) as SpawnDump
}

function pluginArgv(argv: string[]): string[] {
  const index = argv.indexOf('plugin')
  expect(index).toBeGreaterThanOrEqual(0)
  return argv.slice(index)
}

async function expectNoSpawn(grokHome: string): Promise<void> {
  await expect(readFile(join(grokHome, SPAWN_DUMP_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('grokPluginLeaderSocket', () => {
  it('落在 grok-home 内的 studio-plugin.sock，而不是用户 ~/.grok/leader.sock', () => {
    const grokHome = '/tmp/agent-studio-managed-grok-home'
    const socket = grokPluginLeaderSocket(grokHome)

    expect(socket).toBe(join(grokHome, 'studio-plugin.sock'))
    expect(socket).not.toBe(USER_LEADER_SOCKET)
    expect(socket).not.toContain(join(homedir(), '.grok'))
  })
})

describe('runGrokPlugin', () => {
  it('注入 plugin 与受管 leader-socket，覆盖 GROK_HOME，且不带 --trust 或用户 leader', async () => {
    const { grokHome, grokBinary } = await writeFakeGrok('ok')
    process.env[AGENT_STUDIO_MODEL_API_KEY_ENV] = FAKE_API_KEY
    const socket = grokPluginLeaderSocket(grokHome)

    const result = await runGrokPlugin({
      grokHome,
      grokBinary,
      args: ['plugin', 'install', 'chrome-devtools'],
      timeoutMs: 10_000
    })

    expect(result).toEqual({ ok: true, stdout: 'plugin-ok\n' })
    expect(process.env[AGENT_STUDIO_MODEL_API_KEY_ENV]).toBe(FAKE_API_KEY)

    const dump = await readSpawnDump(grokHome)
    const argv = pluginArgv(dump.argv)
    expect(argv[0]).toBe('plugin')
    expect(argv).toContain('--leader-socket')
    expect(argv[argv.indexOf('--leader-socket') + 1]).toBe(socket)
    expect(argv).toEqual(['plugin', '--leader-socket', socket, 'install', 'chrome-devtools'])
    expect(argv).not.toContain('--trust')
    expect(argv.join('\0')).not.toContain(USER_LEADER_SOCKET)
    expect(argv.join('\0')).not.toContain(join(homedir(), '.grok', 'leader.sock'))
    expect(dump.cwd).toBe(grokHome)
    expect(dump.grokHome).toBe(grokHome)
    expect(dump.hasModelApiKey).toBe(false)
    expect(dump.modelApiKey).toBeNull()
    expect(JSON.stringify(dump)).not.toContain(FAKE_API_KEY)
  })

  it('子进程环境走 allowlist，不继承宿主 NPM_TOKEN / XAI_API_KEY / GIT_SSH_COMMAND', async () => {
    const { grokHome, grokBinary } = await writeFakeGrok('ok')
    process.env[AGENT_STUDIO_MODEL_API_KEY_ENV] = FAKE_API_KEY
    process.env.NPM_TOKEN = PLANTED_NPM_TOKEN
    process.env.XAI_API_KEY = PLANTED_XAI_API_KEY
    process.env.GIT_SSH_COMMAND = PLANTED_GIT_SSH_COMMAND
    process.env.GIT_ASKPASS = '/secret/askpass'

    const result = await runGrokPlugin({
      grokHome,
      grokBinary,
      args: ['plugin', 'install', 'chrome-devtools'],
      timeoutMs: 10_000
    })

    expect(result).toEqual({ ok: true, stdout: 'plugin-ok\n' })
    expect(process.env.NPM_TOKEN).toBe(PLANTED_NPM_TOKEN)
    expect(process.env.XAI_API_KEY).toBe(PLANTED_XAI_API_KEY)

    const dump = await readSpawnDump(grokHome)
    expect(dump.grokHome).toBe(grokHome)
    expect(dump.hasModelApiKey).toBe(false)
    expect(dump.modelApiKey).toBeNull()
    expect(dump.npmToken).toBeNull()
    expect(dump.xaiApiKey).toBeNull()
    expect(dump.gitSshCommand).toBeNull()
    expect(dump.gitAskpass).toBeNull()
    expect(JSON.stringify(dump)).not.toContain(PLANTED_NPM_TOKEN)
    expect(JSON.stringify(dump)).not.toContain(PLANTED_XAI_API_KEY)
    expect(JSON.stringify(dump)).not.toContain(PLANTED_GIT_SSH_COMMAND)
    expect(JSON.stringify(dump)).not.toContain(FAKE_API_KEY)
  })

  it('失败输出脱敏绝对路径和 API Key，且不把 Key 传给子进程', async () => {
    const { grokHome, grokBinary } = await writeFakeGrok('fail')
    process.env[AGENT_STUDIO_MODEL_API_KEY_ENV] = FAKE_API_KEY

    const result = await runGrokPlugin({
      grokHome,
      grokBinary,
      args: ['plugin', 'install', 'chrome-devtools'],
      timeoutMs: 10_000
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.message).toContain('plugin-cli-fixture-failed')
    expect(result.message).toContain('[REDACTED]')
    expect(result.message).not.toContain(grokHome)
    expect(result.message).not.toContain(FAKE_API_KEY)
    expect(result.message).not.toContain(SECRET_STDERR_PATH)
    expect(result.message).not.toContain('/Users/secret')
    expect(result.message).not.toContain(SECRET_STDERR_URL)
    expect(result.message).not.toContain('evil.example')
    expect(Buffer.byteLength(result.message, 'utf8')).toBeLessThanOrEqual(2048)
    expect(process.env[AGENT_STUDIO_MODEL_API_KEY_ENV]).toBe(FAKE_API_KEY)

    const dump = await readSpawnDump(grokHome)
    expect(dump.hasModelApiKey).toBe(false)
    expect(dump.modelApiKey).toBeNull()
    expect(dump.argv.join('\0')).not.toContain(FAKE_API_KEY)
  })

  it('args[0] 不是 plugin 时不 spawn', async () => {
    const { grokHome, grokBinary } = await writeFakeGrok('ok')

    const result = await runGrokPlugin({
      grokHome,
      grokBinary,
      args: ['install', 'chrome-devtools'],
      timeoutMs: 10_000
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.message).not.toContain(grokHome)
    expect(result.message).not.toContain(FAKE_API_KEY)
    await expectNoSpawn(grokHome)
  })

  it('调用方自带 --leader-socket 时拒绝且不 spawn', async () => {
    const { grokHome, grokBinary } = await writeFakeGrok('ok')

    const result = await runGrokPlugin({
      grokHome,
      grokBinary,
      args: ['plugin', '--leader-socket', USER_LEADER_SOCKET, 'install', 'chrome-devtools'],
      timeoutMs: 10_000
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.message).not.toContain(USER_LEADER_SOCKET)
    expect(result.message).not.toContain(grokHome)
    await expectNoSpawn(grokHome)
  })

  it('超时杀死进程组并返回失败', async () => {
    const { grokHome, grokBinary } = await writeFakeGrok('sleep')

    const result = await runGrokPlugin({
      grokHome,
      grokBinary,
      args: ['plugin', 'install', 'chrome-devtools'],
      timeoutMs: 2_000
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.message).not.toContain(grokHome)
    expect(result.message).not.toContain(FAKE_API_KEY)

    const dump = await readSpawnDump(grokHome)
    const deadline = Date.now() + 1000
    while (Date.now() < deadline && isPidAlive(dump.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(isPidAlive(dump.pid)).toBe(false)
  }, 15_000)
})

import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const ARGUMENT_PREFIX = '--agent-studio-gacp01-observe'
const USER_DATA_ARGUMENT = `${ARGUMENT_PREFIX}-user-data`
const TEMPORARY_USER_DATA_PREFIX = 'agent-studio-gacp01-observe-'
const MAX_PATH_BYTES = 16 * 1024

export const GACP01_OBSERVE_DIRECTORIES = {
  workspace: 'gacp01-observe-workspace',
  observation: 'gacp01-observe-log'
} as const

export const GACP01_OBSERVE_PROTOCOL_FILE = 'protocol.jsonl'

/** 仅由 Main 在锁定 userData 前使用，不进入 IPC 或 Renderer。 */
export interface Gacp01ObserveBootstrap {
  readonly userDataPath: string
  readonly workspacePath: string
  readonly observationFilePath: string
}

export interface ResolveGacp01ObserveBootstrapOptions {
  readonly argv?: readonly string[]
  readonly development: boolean
  readonly packaged: boolean
  readonly temporaryDirectory?: string
}

/** 真机观察参数残缺或越过隔离边界时统一失败关闭。 */
export class Gacp01ObserveBootstrapError extends Error {
  constructor() {
    super('GACP-01 真机观察启动配置无效。')
    this.name = 'Gacp01ObserveBootstrapError'
  }
}

/**
 * 解析可选真机观察启动参数。
 * 不替换 Grok 二进制，不读取真实 userData，也不接受 API Key。
 */
export function resolveGacp01ObserveBootstrap(
  options: ResolveGacp01ObserveBootstrapOptions
): Gacp01ObserveBootstrap | null {
  const argv = options.argv ?? process.argv
  const ownedArguments = argv.filter((argument) => argument.startsWith(ARGUMENT_PREFIX))
  if (ownedArguments.length === 0) return null
  if (!options.development || options.packaged) throw new Gacp01ObserveBootstrapError()

  const userDataPath = resolveTemporaryUserData(
    readSingleArgument(argv),
    options.temporaryDirectory ?? tmpdir()
  )
  const workspacePath = assertDirectChildDirectory(
    userDataPath,
    GACP01_OBSERVE_DIRECTORIES.workspace
  )
  const observationDirectory = assertDirectChildDirectory(
    userDataPath,
    GACP01_OBSERVE_DIRECTORIES.observation
  )

  return {
    userDataPath,
    workspacePath,
    observationFilePath: join(observationDirectory, GACP01_OBSERVE_PROTOCOL_FILE)
  }
}

function readSingleArgument(argv: readonly string[]): string {
  const expectedPrefix = `${USER_DATA_ARGUMENT}=`
  const values = argv
    .filter((argument) => argument.startsWith(expectedPrefix))
    .map((argument) => argument.slice(expectedPrefix.length))
  const ownsUnknownArgument = argv.some(
    (argument) => argument.startsWith(ARGUMENT_PREFIX) && !argument.startsWith(expectedPrefix)
  )
  if (ownsUnknownArgument || values.length !== 1 || !values[0]) {
    throw new Gacp01ObserveBootstrapError()
  }
  return values[0]
}

function resolveTemporaryUserData(value: string, temporaryDirectory: string): string {
  if (!isSafeAbsolutePath(value)) throw new Gacp01ObserveBootstrapError()
  const canonicalTemporaryDirectory = canonicalDirectory(temporaryDirectory)
  const canonicalUserData = canonicalDirectory(value, true)
  if (
    dirname(canonicalUserData) !== canonicalTemporaryDirectory ||
    !basename(canonicalUserData).startsWith(TEMPORARY_USER_DATA_PREFIX)
  ) {
    throw new Gacp01ObserveBootstrapError()
  }
  return canonicalUserData
}

function assertDirectChildDirectory(parent: string, name: string): string {
  const expected = join(parent, name)
  const canonical = canonicalDirectory(expected, true)
  if (canonical !== expected || dirname(canonical) !== parent) {
    throw new Gacp01ObserveBootstrapError()
  }
  return canonical
}

function canonicalDirectory(path: string, requireOwnerPrivate = false): string {
  try {
    if (!isSafeAbsolutePath(path)) throw new Gacp01ObserveBootstrapError()
    const resolved = resolve(path)
    const stats = lstatSync(resolved)
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (requireOwnerPrivate && !isPrivateEnough(stats.mode))
    ) {
      throw new Gacp01ObserveBootstrapError()
    }
    return realpathSync(resolved)
  } catch (error) {
    if (error instanceof Gacp01ObserveBootstrapError) throw error
    throw new Gacp01ObserveBootstrapError()
  }
}

function isPrivateEnough(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0
}

function isSafeAbsolutePath(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES &&
    !value.includes('\0') &&
    isAbsolute(value)
  )
}

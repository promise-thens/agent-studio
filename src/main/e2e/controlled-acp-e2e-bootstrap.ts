import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProviderConfigInput } from '../../shared/provider'
import {
  CONTROLLED_ACP_E2E_DIRECTORIES,
  CONTROLLED_ACP_E2E_FIXTURE_FILE,
  CONTROLLED_ACP_E2E_MARKER_FILE,
  CONTROLLED_ACP_E2E_MODEL_ID,
  CONTROLLED_ACP_E2E_SCENARIOS,
  type ControlledAcpFixtureLaunch,
  type ControlledAcpFixtureScenario
} from '../runtime/grok/controlled-acp-fixture'

const E2E_ARGUMENT_PREFIX = '--agent-studio-controlled-acp-e2e'
const SCENARIO_ARGUMENT = `${E2E_ARGUMENT_PREFIX}-scenario`
const USER_DATA_ARGUMENT = `${E2E_ARGUMENT_PREFIX}-user-data`
const PROVIDER_PORT_ARGUMENT = `${E2E_ARGUMENT_PREFIX}-provider-port`
const TEMPORARY_USER_DATA_PREFIX = 'agent-studio-controlled-acp-e2e-'
const MAX_PATH_BYTES = 16 * 1024

/** 仅由 Main 在锁定 userData 前使用的受控 E2E 启动信息，不进入 IPC 或 Renderer。 */
export interface ControlledAcpE2eBootstrap {
  readonly userDataPath: string
  readonly workspacePath: string
  readonly secondaryWorkspacePath: string
  readonly markerPath: string
  readonly providerConfig: ProviderConfigInput
  readonly fixture: ControlledAcpFixtureLaunch
}

export interface ResolveControlledAcpE2eBootstrapOptions {
  readonly argv?: readonly string[]
  readonly development: boolean
  readonly packaged: boolean
  readonly temporaryDirectory?: string
  /** 必须由 Main 从构建后模块位置反推并校验，不能以 process.cwd() 作为可控 fixture 根。 */
  readonly repositoryRoot: string
}

/** 受控 E2E 参数不完整或越过隔离边界时统一失败关闭，绝不回退真实 Profile。 */
export class ControlledAcpE2eBootstrapError extends Error {
  constructor() {
    super('受控 ACP Runtime E2E 配置无效。')
    this.name = 'ControlledAcpE2eBootstrapError'
  }
}

/**
 * 解析并校验受控 ACP Runtime Electron E2E 的唯一启动形态。
 * 任意同前缀的残缺参数都会报错，避免开发期开关误读真实 userData 或 Provider 配置。
 */
export function resolveControlledAcpE2eBootstrap(
  options: ResolveControlledAcpE2eBootstrapOptions
): ControlledAcpE2eBootstrap | null {
  const argv = options.argv ?? process.argv
  const ownedArguments = argv.filter((argument) => argument.startsWith(E2E_ARGUMENT_PREFIX))
  if (ownedArguments.length === 0) return null
  if (!options.development || options.packaged) throw new ControlledAcpE2eBootstrapError()

  const scenario = readControlledScenario(argv)
  const userDataPath = resolveTemporaryUserData(
    readSingleArgument(argv, USER_DATA_ARGUMENT),
    options.temporaryDirectory ?? tmpdir()
  )
  const workspacePath = assertDirectChildDirectory(
    userDataPath,
    CONTROLLED_ACP_E2E_DIRECTORIES.workspace
  )
  const secondaryWorkspacePath = assertDirectChildDirectory(
    userDataPath,
    CONTROLLED_ACP_E2E_DIRECTORIES.secondaryWorkspace
  )
  const traceDirectory = assertDirectChildDirectory(
    userDataPath,
    CONTROLLED_ACP_E2E_DIRECTORIES.trace
  )
  const barrierDirectory = assertDirectChildDirectory(
    userDataPath,
    CONTROLLED_ACP_E2E_DIRECTORIES.barriers
  )
  const runtimeHomeDirectory = assertDirectChildDirectory(
    userDataPath,
    CONTROLLED_ACP_E2E_DIRECTORIES.runtimeHome
  )
  const markerPath = assertRegularFile(join(workspacePath, CONTROLLED_ACP_E2E_MARKER_FILE))
  const repositoryRootPath = canonicalDirectory(options.repositoryRoot)
  const fixturePath = resolveFixturePath(repositoryRootPath)
  const providerPort = parseProviderPort(readSingleArgument(argv, PROVIDER_PORT_ARGUMENT))

  return {
    userDataPath,
    workspacePath,
    secondaryWorkspacePath,
    markerPath,
    providerConfig: {
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      authMode: 'none',
      modelId: CONTROLLED_ACP_E2E_MODEL_ID
    },
    fixture: {
      scenario,
      repositoryRootPath,
      userDataPath,
      fixturePath,
      traceDirectory,
      barrierDirectory,
      runtimeHomeDirectory
    }
  }
}

function readControlledScenario(argv: readonly string[]): ControlledAcpFixtureScenario {
  const value = readSingleArgument(argv, SCENARIO_ARGUMENT)
  if (!CONTROLLED_ACP_E2E_SCENARIOS.includes(value as ControlledAcpFixtureScenario)) {
    throw new ControlledAcpE2eBootstrapError()
  }
  return value as ControlledAcpFixtureScenario
}

/** 只接受每个已知参数恰好一次，拒绝自行拼出的同前缀参数。 */
function readSingleArgument(argv: readonly string[], name: string): string {
  const expectedPrefix = `${name}=`
  const values = argv
    .filter((argument) => argument.startsWith(expectedPrefix))
    .map((argument) => argument.slice(expectedPrefix.length))
  const ownsUnknownArgument = argv.some(
    (argument) =>
      argument.startsWith(E2E_ARGUMENT_PREFIX) &&
      ![SCENARIO_ARGUMENT, USER_DATA_ARGUMENT, PROVIDER_PORT_ARGUMENT].some((known) =>
        argument.startsWith(`${known}=`)
      )
  )
  if (ownsUnknownArgument || values.length !== 1 || !values[0]) {
    throw new ControlledAcpE2eBootstrapError()
  }
  return values[0]
}

/** 临时 userData 必须是系统临时目录的直接、私有、非链接子目录。 */
function resolveTemporaryUserData(value: string, temporaryDirectory: string): string {
  if (!isSafeAbsolutePath(value)) throw new ControlledAcpE2eBootstrapError()

  const canonicalTemporaryDirectory = canonicalDirectory(temporaryDirectory)
  const canonicalUserData = canonicalDirectory(value, true)
  if (
    dirname(canonicalUserData) !== canonicalTemporaryDirectory ||
    !basename(canonicalUserData).startsWith(TEMPORARY_USER_DATA_PREFIX)
  ) {
    throw new ControlledAcpE2eBootstrapError()
  }
  return canonicalUserData
}

/** 派生目录不接受独立参数，并要求自身不是符号链接或宽权限目录。 */
function assertDirectChildDirectory(parent: string, name: string): string {
  const expected = join(parent, name)
  const canonical = canonicalDirectory(expected, true)
  if (canonical !== expected || dirname(canonical) !== parent) {
    throw new ControlledAcpE2eBootstrapError()
  }
  return canonical
}

/** marker 必须由测试预先创建为固定普通文件，fixture 不会接收任意写入目标。 */
function assertRegularFile(path: string, requireOwnerPrivate = true): string {
  try {
    const resolved = resolve(path)
    const stats = lstatSync(resolved)
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (requireOwnerPrivate && !isPrivateEnough(stats.mode))
    ) {
      throw new ControlledAcpE2eBootstrapError()
    }
    const canonical = realpathSync(resolved)
    if (canonical !== resolved) throw new ControlledAcpE2eBootstrapError()
    return canonical
  } catch (error) {
    if (error instanceof ControlledAcpE2eBootstrapError) throw error
    throw new ControlledAcpE2eBootstrapError()
  }
}

/** 普通源码目录可读但不得是链接；只有临时 userData 及其子目录要求 owner 私有权限。 */
function canonicalDirectory(path: string, requireOwnerPrivate = false): string {
  try {
    if (!isSafeAbsolutePath(path)) throw new ControlledAcpE2eBootstrapError()
    const resolved = resolve(path)
    const stats = lstatSync(resolved)
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (requireOwnerPrivate && !isPrivateEnough(stats.mode))
    ) {
      throw new ControlledAcpE2eBootstrapError()
    }
    return realpathSync(resolved)
  } catch (error) {
    if (error instanceof ControlledAcpE2eBootstrapError) throw error
    throw new ControlledAcpE2eBootstrapError()
  }
}

/** Unix 上只接受 owner 私有目录或文件；Windows 交由 ACL 和 Electron 用户上下文约束。 */
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

/** fixture 只能是仓库 tests/e2e 下的固定普通文件，禁止开发时以链接替换。 */
function resolveFixturePath(canonicalRepositoryRoot: string): string {
  const fixtureDirectory = join(canonicalRepositoryRoot, 'tests', 'e2e')
  const canonicalFixtureDirectory = canonicalDirectory(fixtureDirectory)
  const fixturePath = assertRegularFile(
    join(canonicalFixtureDirectory, CONTROLLED_ACP_E2E_FIXTURE_FILE),
    false
  )
  if (dirname(fixturePath) !== canonicalFixtureDirectory) throw new ControlledAcpE2eBootstrapError()
  return fixturePath
}

function parseProviderPort(value: string): number {
  if (!/^\d{2,5}$/.test(value)) throw new ControlledAcpE2eBootstrapError()
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new ControlledAcpE2eBootstrapError()
  }
  return port
}

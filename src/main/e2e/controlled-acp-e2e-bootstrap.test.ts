import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ControlledAcpE2eBootstrapError,
  resolveControlledAcpE2eBootstrap,
  type ControlledAcpE2eBootstrap,
  type ResolveControlledAcpE2eBootstrapOptions
} from './controlled-acp-e2e-bootstrap'
import {
  CONTROLLED_ACP_E2E_DIRECTORIES,
  CONTROLLED_ACP_E2E_MARKER_FILE
} from '../runtime/grok/controlled-acp-fixture'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveControlledAcpE2eBootstrap', () => {
  it('只接受开发态下预先创建的私有临时目录和固定 127.0.0.1 Provider', async () => {
    const fixture = await createFixtureRoot()

    const result = resolveBootstrap(fixture.userDataPath)

    expect(result).toMatchObject({
      userDataPath: fixture.userDataPath,
      workspacePath: join(fixture.userDataPath, CONTROLLED_ACP_E2E_DIRECTORIES.workspace),
      markerPath: join(
        fixture.userDataPath,
        CONTROLLED_ACP_E2E_DIRECTORIES.workspace,
        CONTROLLED_ACP_E2E_MARKER_FILE
      ),
      providerConfig: {
        baseUrl: 'http://127.0.0.1:43123/v1',
        authMode: 'none',
        modelId: 'controlled-acp-e2e-model'
      },
      fixture: { scenario: 'E2E:FIFO' }
    })
    expect(result?.fixture.fixturePath).toBe(
      join(process.cwd(), 'tests', 'e2e', 'controlled-acp-runtime.mjs')
    )
  })

  it.each([
    ['缺失场景', ['--agent-studio-controlled-acp-e2e-user-data=/tmp/unused']],
    ['未知同前缀参数', ['--agent-studio-controlled-acp-e2e-unexpected=1']],
    ['不支持的场景', ['--agent-studio-controlled-acp-e2e-scenario=E2E:OTHER']]
  ])('%s 时失败关闭', async (_name, extraArguments) => {
    const fixture = await createFixtureRoot()
    const argv = [
      ...extraArguments,
      `--agent-studio-controlled-acp-e2e-user-data=${fixture.userDataPath}`,
      '--agent-studio-controlled-acp-e2e-provider-port=43123'
    ]

    expect(() => resolveBootstrap(fixture.userDataPath, argv)).toThrow(
      ControlledAcpE2eBootstrapError
    )
  })

  it('在非开发态、已打包或符号链接目录时拒绝启动', async () => {
    const fixture = await createFixtureRoot()
    const options = resolveOptions(fixture.userDataPath)

    expect(() => resolveControlledAcpE2eBootstrap({ ...options, development: false })).toThrow(
      ControlledAcpE2eBootstrapError
    )
    expect(() => resolveControlledAcpE2eBootstrap({ ...options, packaged: true })).toThrow(
      ControlledAcpE2eBootstrapError
    )

    const outside = await mkdtemp(
      join(await realpath(tmpdir()), 'agent-studio-controlled-acp-e2e-link-')
    )
    roots.push(outside)
    await rm(join(fixture.userDataPath, CONTROLLED_ACP_E2E_DIRECTORIES.workspace), {
      recursive: true,
      force: true
    })
    await symlink(outside, join(fixture.userDataPath, CONTROLLED_ACP_E2E_DIRECTORIES.workspace))

    expect(() => resolveControlledAcpE2eBootstrap(options)).toThrow(ControlledAcpE2eBootstrapError)
  })

  it('没有受控前缀时保持普通启动路径', () => {
    expect(
      resolveControlledAcpE2eBootstrap({
        argv: ['electron', 'out/main/index.js'],
        development: false,
        packaged: true,
        repositoryRoot: process.cwd()
      })
    ).toBeNull()
  })
})

/** 创建与 Playwright 相同的最小临时目录布局；所有可写位置均由 bootstrap 派生。 */
async function createFixtureRoot(): Promise<{ userDataPath: string }> {
  const temporaryDirectory = await realpath(tmpdir())
  const userDataPath = await mkdtemp(join(temporaryDirectory, 'agent-studio-controlled-acp-e2e-'))
  roots.push(userDataPath)
  await chmod(userDataPath, 0o700)
  await Promise.all(
    Object.values(CONTROLLED_ACP_E2E_DIRECTORIES).map(async (name) => {
      const path = join(userDataPath, name)
      await mkdir(path, { mode: 0o700 })
      await chmod(path, 0o700)
    })
  )
  const marker = join(
    userDataPath,
    CONTROLLED_ACP_E2E_DIRECTORIES.workspace,
    CONTROLLED_ACP_E2E_MARKER_FILE
  )
  await writeFile(marker, 'unchanged\n', { encoding: 'utf8', mode: 0o600 })
  await chmod(marker, 0o600)
  return { userDataPath }
}

function resolveBootstrap(
  userDataPath: string,
  argv: readonly string[] = controlledArguments(userDataPath)
): ControlledAcpE2eBootstrap | null {
  return resolveControlledAcpE2eBootstrap(resolveOptions(userDataPath, argv))
}

function resolveOptions(
  userDataPath: string,
  argv: readonly string[] = controlledArguments(userDataPath)
): ResolveControlledAcpE2eBootstrapOptions {
  return {
    argv,
    development: true,
    packaged: false,
    temporaryDirectory: tmpdir(),
    repositoryRoot: process.cwd()
  }
}

function controlledArguments(userDataPath: string): string[] {
  return [
    'electron',
    'out/main/index.js',
    '--agent-studio-controlled-acp-e2e-scenario=E2E:FIFO',
    `--agent-studio-controlled-acp-e2e-user-data=${userDataPath}`,
    '--agent-studio-controlled-acp-e2e-provider-port=43123'
  ]
}

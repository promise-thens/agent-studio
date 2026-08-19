import { realpathSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GACP01_OBSERVE_DIRECTORIES,
  GACP01_OBSERVE_PROTOCOL_FILE,
  Gacp01ObserveBootstrapError,
  resolveGacp01ObserveBootstrap
} from './gacp01-observe-bootstrap'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveGacp01ObserveBootstrap', () => {
  it('只接受开发态下预先创建的私有临时目录，不接收 Provider Key', async () => {
    const userDataPath = await createObserveRoot()
    const canonicalRoot = realpathSync(userDataPath)

    const result = resolveGacp01ObserveBootstrap({
      argv: [`--agent-studio-gacp01-observe-user-data=${userDataPath}`],
      development: true,
      packaged: false,
      temporaryDirectory: tmpdir()
    })

    expect(result).toMatchObject({
      userDataPath: canonicalRoot,
      workspacePath: join(canonicalRoot, GACP01_OBSERVE_DIRECTORIES.workspace),
      observationFilePath: join(
        canonicalRoot,
        GACP01_OBSERVE_DIRECTORIES.observation,
        GACP01_OBSERVE_PROTOCOL_FILE
      )
    })
    expect(JSON.stringify(result)).not.toContain('apiKey')
    expect(JSON.stringify(result)).not.toContain('sk-')
  })

  it('没有观察参数时返回 null', () => {
    expect(
      resolveGacp01ObserveBootstrap({
        argv: ['electron', '.'],
        development: true,
        packaged: false
      })
    ).toBeNull()
  })

  it('残缺参数或打包态失败关闭', async () => {
    const userDataPath = await createObserveRoot()
    const options = {
      argv: [`--agent-studio-gacp01-observe-user-data=${userDataPath}`],
      development: true,
      packaged: false,
      temporaryDirectory: tmpdir()
    }

    expect(() =>
      resolveGacp01ObserveBootstrap({
        ...options,
        argv: ['--agent-studio-gacp01-observe-unexpected=1']
      })
    ).toThrow(Gacp01ObserveBootstrapError)
    expect(() => resolveGacp01ObserveBootstrap({ ...options, development: false })).toThrow(
      Gacp01ObserveBootstrapError
    )
    expect(() => resolveGacp01ObserveBootstrap({ ...options, packaged: true })).toThrow(
      Gacp01ObserveBootstrapError
    )
  })
})

async function createObserveRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-studio-gacp01-observe-'))
  roots.push(root)
  await chmod(root, 0o700)
  await mkdir(join(root, GACP01_OBSERVE_DIRECTORIES.workspace), { mode: 0o700 })
  await mkdir(join(root, GACP01_OBSERVE_DIRECTORIES.observation), { mode: 0o700 })
  await chmod(join(root, GACP01_OBSERVE_DIRECTORIES.workspace), 0o700)
  await chmod(join(root, GACP01_OBSERVE_DIRECTORIES.observation), 0o700)
  return root
}

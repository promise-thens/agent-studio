import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationIntent } from '../../shared/agent'
import {
  PermissionPolicyError,
  createLocalEnvironmentId,
  createOperationGrantKey,
  evaluatePermissionPolicy,
  resolveOperationIntentTargets
} from './permission-policy'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('Permission 风险策略', () => {
  it('只读自动允许，写入和命令允许精确 Task 授权，高风险只允许单次', () => {
    expect(evaluatePermissionPolicy(createIntent('read-project'))).toEqual({
      kind: 'allow',
      risk: 'L0',
      allowedScopes: []
    })
    expect(evaluatePermissionPolicy(createIntent('write-file'))).toMatchObject({
      kind: 'approval',
      risk: 'L1',
      allowedScopes: ['once', 'task']
    })
    expect(evaluatePermissionPolicy(createIntent('execute-command'))).toMatchObject({
      kind: 'approval',
      risk: 'L2',
      allowedScopes: ['once', 'task']
    })
    expect(evaluatePermissionPolicy(createIntent('delete-path'))).toMatchObject({
      kind: 'approval',
      risk: 'L3',
      allowedScopes: ['once']
    })
  })

  it('调用方只能提高风险，未知操作按 L3，未接入能力直接拒绝', () => {
    expect(
      evaluatePermissionPolicy({ ...createIntent('write-file'), minimumRisk: 'L3' })
    ).toMatchObject({ kind: 'approval', risk: 'L3', allowedScopes: ['once'] })
    expect(evaluatePermissionPolicy(createIntent('unknown'))).toMatchObject({
      kind: 'approval',
      risk: 'L3',
      allowedScopes: ['once']
    })
    expect(evaluatePermissionPolicy(createIntent('screen'))).toEqual({
      kind: 'deny',
      risk: 'L3',
      reason: 'unsupported',
      allowedScopes: []
    })
  })

  it('危险 Git 类别无需 minimumRisk 也固定为 L3，仅普通 Git 修改可按 Task 授权', () => {
    expect(
      evaluatePermissionPolicy({
        ...createIntent('git-mutate'),
        initiator: { kind: 'app', service: 'git' },
        targets: [{ kind: 'git', value: ' FORCE-RESET ' }]
      })
    ).toMatchObject({ kind: 'approval', risk: 'L3', allowedScopes: ['once'] })
    expect(
      evaluatePermissionPolicy({
        ...createIntent('git-mutate'),
        initiator: { kind: 'app', service: 'git' },
        targets: [{ kind: 'git', value: 'commit' }]
      })
    ).toMatchObject({ kind: 'approval', risk: 'L2', allowedScopes: ['once', 'task'] })
  })

  it('App service 只能提交其职责内操作，通用服务不能冒充命令、Git 或 Worktree', () => {
    const validIntents: OperationIntent[] = [
      {
        ...createIntent('execute-command'),
        initiator: { kind: 'app', service: 'command-runner' }
      },
      {
        ...createIntent('git-read'),
        initiator: { kind: 'app', service: 'git' },
        targets: [{ kind: 'git', value: 'status' }]
      },
      {
        ...createIntent('worktree-remove'),
        initiator: { kind: 'app', service: 'worktree' },
        targets: [
          { kind: 'worktree', value: 'managed-worktree' },
          { kind: 'path', value: 'managed/worktree' }
        ]
      },
      {
        ...createIntent('network-egress'),
        initiator: { kind: 'app', service: 'other' }
      }
    ]
    validIntents.forEach((intent) => expect(() => evaluatePermissionPolicy(intent)).not.toThrow())

    const invalidIntents: OperationIntent[] = [
      {
        ...createIntent('git-mutate'),
        initiator: { kind: 'app', service: 'command-runner' },
        targets: [{ kind: 'git', value: 'commit' }]
      },
      {
        ...createIntent('execute-command'),
        initiator: { kind: 'app', service: 'git' }
      },
      {
        ...createIntent('worktree-create'),
        initiator: { kind: 'app', service: 'other' },
        targets: [
          { kind: 'worktree', value: 'managed-worktree' },
          { kind: 'project', value: 'project-1' }
        ]
      }
    ]
    for (const intent of invalidIntents) {
      expect(() => evaluatePermissionPolicy(intent)).toThrowError(PermissionPolicyError)
    }
  })

  it('Local 环境 ID 对相同身份稳定，对 Project 或 root 变化隔离', () => {
    const first = createLocalEnvironmentId('project-1', '/tmp/project')
    expect(first).toBe(createLocalEnvironmentId('project-1', '/tmp/project'))
    expect(first).not.toBe(createLocalEnvironmentId('project-2', '/tmp/project'))
    expect(first).not.toBe(createLocalEnvironmentId('project-1', '/tmp/project-other'))
  })
})

describe('Permission 路径边界', () => {
  it('接受 root 内相对、绝对和不存在叶子，并生成精确授权键', async () => {
    const root = await fs.realpath(await createTemporaryDirectory('policy-root-'))
    await fs.mkdir(join(root, 'src'))
    await fs.writeFile(join(root, 'src', 'index.ts'), 'export {}')
    const canonicalRoot = await fs.realpath(root)

    const relativeIntent = createIntent('write-file', root, [
      { kind: 'path', value: 'src/index.ts' }
    ])
    const absoluteIntent = createIntent('write-file', root, [
      { kind: 'path', value: join(root, 'src', 'new.ts') }
    ])
    const resolvedRelative = await resolveOperationIntentTargets(relativeIntent)
    const resolvedAbsolute = await resolveOperationIntentTargets(absoluteIntent)

    expect(resolvedRelative.targets).toEqual([
      { kind: 'path', value: join(canonicalRoot, 'src', 'index.ts') }
    ])
    expect(resolvedAbsolute.targets).toEqual([
      { kind: 'path', value: join(canonicalRoot, 'src', 'new.ts') }
    ])
    expect(createOperationGrantKey(resolvedRelative)).not.toBe(
      createOperationGrantKey(resolvedAbsolute)
    )
    expect(createOperationGrantKey(resolvedRelative)).not.toBe(
      createOperationGrantKey({ ...resolvedRelative, taskId: 'task-2' })
    )
  })

  it('网络只接受纯 HTTP(S) origin，并固定 Git 与 Worktree 的目标形状', async () => {
    const root = await fs.realpath(await createTemporaryDirectory('policy-targets-'))
    const network = await resolveOperationIntentTargets(
      createIntent('network-egress', root, [{ kind: 'origin', value: 'https://EXAMPLE.com:443/' }])
    )
    expect(network.targets).toEqual([{ kind: 'origin', value: 'https://example.com' }])

    for (const unsafeOrigin of [
      'file:///tmp/data',
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com/?secret=fake',
      'https://example.com/#fragment'
    ]) {
      await expect(
        resolveOperationIntentTargets(
          createIntent('network-egress', root, [{ kind: 'origin', value: unsafeOrigin }])
        )
      ).rejects.toMatchObject({ code: 'invalid-target' } satisfies Partial<PermissionPolicyError>)
    }

    expect(() => evaluatePermissionPolicy(createIntent('git-read', root))).toThrowError(
      PermissionPolicyError
    )
    expect(() => evaluatePermissionPolicy(createIntent('worktree-create', root))).toThrowError(
      PermissionPolicyError
    )
    expect(() =>
      evaluatePermissionPolicy(
        createIntent('network-egress', root, [{ kind: 'unknown', value: '目标未确认' }])
      )
    ).toThrowError(PermissionPolicyError)
    expect(
      evaluatePermissionPolicy({
        ...createIntent('network-egress', root, [{ kind: 'unknown', value: '目标未确认' }]),
        minimumRisk: 'L3'
      })
    ).toMatchObject({ risk: 'L3', allowedScopes: ['once'] })
  })

  it('操作只接受白名单目标类别，Project 目标必须匹配意图身份', () => {
    expect(() =>
      evaluatePermissionPolicy({
        ...createIntent('write-file'),
        targets: [
          { kind: 'path', value: 'src/index.ts' },
          { kind: 'command', value: 'pnpm test' }
        ]
      })
    ).toThrowError(PermissionPolicyError)
    expect(() =>
      evaluatePermissionPolicy({
        ...createIntent('network-egress'),
        targets: [
          { kind: 'origin', value: 'https://example.com' },
          { kind: 'path', value: 'src/secret.ts' }
        ]
      })
    ).toThrowError(PermissionPolicyError)
    expect(() =>
      evaluatePermissionPolicy({
        ...createIntent('read-project'),
        targets: [{ kind: 'project', value: 'project-other' }]
      })
    ).toThrowError(PermissionPolicyError)
  })

  it('拒绝父目录、同前缀假目录和 root 本身的破坏性目标', async () => {
    const parent = await fs.realpath(await createTemporaryDirectory('policy-prefix-'))
    const root = join(parent, 'repo')
    const sibling = join(parent, 'repo2')
    await fs.mkdir(root)
    await fs.mkdir(sibling)

    await expect(
      resolveOperationIntentTargets(
        createIntent('write-file', root, [{ kind: 'path', value: '../repo2/file.ts' }])
      )
    ).rejects.toMatchObject({ code: 'invalid-target' } satisfies Partial<PermissionPolicyError>)
    await expect(
      resolveOperationIntentTargets(
        createIntent('write-file', root, [{ kind: 'path', value: join(sibling, 'file.ts') }])
      )
    ).rejects.toMatchObject({ code: 'invalid-target' } satisfies Partial<PermissionPolicyError>)
    await expect(
      resolveOperationIntentTargets(
        createIntent('delete-path', root, [{ kind: 'path', value: root }])
      )
    ).rejects.toMatchObject({ code: 'invalid-target' } satisfies Partial<PermissionPolicyError>)
  })

  it('允许 root 内符号链接并拒绝指向 root 外的符号链接逃逸', async () => {
    const parent = await fs.realpath(await createTemporaryDirectory('policy-link-'))
    const root = join(parent, 'repo')
    const outside = join(parent, 'outside')
    await fs.mkdir(root)
    await fs.mkdir(outside)
    await fs.mkdir(join(root, 'real'))
    const canonicalRoot = await fs.realpath(root)
    await fs.symlink(join(root, 'real'), join(root, 'inside-link'))
    await fs.symlink(outside, join(root, 'outside-link'))

    await expect(
      resolveOperationIntentTargets(
        createIntent('write-file', root, [{ kind: 'path', value: 'inside-link/new.ts' }])
      )
    ).resolves.toMatchObject({
      targets: [{ kind: 'path', value: join(canonicalRoot, 'real', 'new.ts') }]
    })
    await expect(
      resolveOperationIntentTargets(
        createIntent('write-file', root, [{ kind: 'path', value: 'outside-link/new.ts' }])
      )
    ).rejects.toMatchObject({ code: 'invalid-target' } satisfies Partial<PermissionPolicyError>)
  })

  it('共享记忆树内的读写视为合法目标，写入自动允许，其它家目录仍拒绝', async () => {
    const parent = await fs.realpath(await createTemporaryDirectory('policy-memory-'))
    const project = join(parent, 'project')
    const grokHome = join(parent, 'fake-home', '.grok')
    const memoryRoot = join(grokHome, 'memory')
    await fs.mkdir(project)
    await fs.mkdir(memoryRoot, { recursive: true })
    await fs.writeFile(join(memoryRoot, 'MEMORY.md'), '# Global Memory\n', 'utf8')
    await fs.writeFile(join(grokHome, 'config.toml'), 'secret = true\n', 'utf8')
    const canonicalProject = await fs.realpath(project)
    const canonicalMemory = await fs.realpath(memoryRoot)

    const memoryWrite = await resolveOperationIntentTargets({
      ...createIntent('write-file', canonicalProject, [
        { kind: 'path', value: join(canonicalMemory, 'MEMORY.md') }
      ]),
      trustedExternalRoots: [canonicalMemory]
    })
    expect(memoryWrite.targets).toEqual([
      { kind: 'path', value: join(canonicalMemory, 'MEMORY.md') }
    ])
    expect(evaluatePermissionPolicy(memoryWrite)).toEqual({
      kind: 'allow',
      risk: 'L0',
      allowedScopes: []
    })

    await expect(
      resolveOperationIntentTargets({
        ...createIntent('write-file', canonicalProject, [
          { kind: 'path', value: join(grokHome, 'config.toml') }
        ]),
        trustedExternalRoots: [canonicalMemory]
      })
    ).rejects.toMatchObject({ code: 'invalid-target' } satisfies Partial<PermissionPolicyError>)

    const projectWrite = await resolveOperationIntentTargets({
      ...createIntent('write-file', canonicalProject, [
        { kind: 'path', value: join(canonicalProject, 'src.ts') }
      ]),
      trustedExternalRoots: [canonicalMemory]
    })
    expect(evaluatePermissionPolicy(projectWrite)).toMatchObject({
      kind: 'approval',
      risk: 'L1'
    })
  })
})

function createIntent(
  operationType: OperationIntent['operationType'],
  executionRoot = '/tmp/project',
  targets = defaultTargets(operationType)
): OperationIntent {
  return {
    initiator: { kind: 'runtime', runtimeId: 'grok' },
    taskId: 'task-1',
    turnId: 'turn-1',
    projectId: 'project-1',
    environmentId: createLocalEnvironmentId('project-1', executionRoot),
    executionRoot,
    operationType,
    targets,
    parameterFingerprint: `${operationType}:v1`,
    title: '执行受控操作',
    impact: '可能影响当前 Project。'
  }
}

function defaultTargets(
  operationType: OperationIntent['operationType']
): OperationIntent['targets'] {
  if (['write-file', 'delete-path'].includes(operationType)) {
    return [{ kind: 'path', value: 'src/index.ts' }]
  }
  if (operationType === 'execute-command') return [{ kind: 'command', value: '未提供结构化命令' }]
  if (operationType === 'network-egress') return [{ kind: 'origin', value: 'https://example.com' }]
  if (operationType === 'read-project') return [{ kind: 'project', value: 'project-1' }]
  return [{ kind: 'unknown', value: '目标未确认' }]
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

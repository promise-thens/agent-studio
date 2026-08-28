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
  it('只读自动允许，写入和普通删除允许本任务授权，高风险只允许单次', () => {
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
      risk: 'L1',
      allowedScopes: ['once', 'task']
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
        ...createIntent('write-file'),
        initiator: { kind: 'app', service: 'git' }
      },
      {
        ...createIntent('delete-path'),
        initiator: { kind: 'app', service: 'git' }
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
  it('接受 root 内相对、绝对和不存在叶子，同一 Task 写授权可跨文件复用', async () => {
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
    expect(createOperationGrantKey(resolvedRelative)).toBe(
      createOperationGrantKey(resolvedAbsolute)
    )
    expect(createOperationGrantKey(resolvedRelative)).toBe(
      createOperationGrantKey({ ...resolvedRelative, parameterFingerprint: 'edit:v2' })
    )
    expect(createOperationGrantKey(resolvedRelative)).not.toBe(
      createOperationGrantKey({ ...resolvedRelative, taskId: 'task-2' })
    )
    expect(createOperationGrantKey(resolvedRelative)).not.toBe(
      createOperationGrantKey({ ...resolvedRelative, environmentId: 'local:other' })
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

  it('普通删除为 L1 且宽 grant，删 .git、非空目录和 root 外路径不能复用', async () => {
    const root = await fs.realpath(await createTemporaryDirectory('policy-delete-'))
    await fs.mkdir(join(root, 'src'))
    await fs.writeFile(join(root, 'src', 'a.ts'), 'export {}')
    await fs.writeFile(join(root, 'src', 'b.ts'), 'export {}')
    await fs.mkdir(join(root, 'empty'))
    await fs.mkdir(join(root, 'full'))
    await fs.writeFile(join(root, 'full', 'keep.ts'), 'export {}')
    await fs.mkdir(join(root, '.git'))
    await fs.writeFile(join(root, '.git', 'config'), '[core]\n')

    const normalFile = await resolveOperationIntentTargets(
      createIntent('delete-path', root, [{ kind: 'path', value: 'src/a.ts' }])
    )
    const otherFile = await resolveOperationIntentTargets(
      createIntent('delete-path', root, [{ kind: 'path', value: 'src/b.ts' }])
    )
    const emptyDir = await resolveOperationIntentTargets(
      createIntent('delete-path', root, [{ kind: 'path', value: 'empty' }])
    )
    const gitDir = await resolveOperationIntentTargets(
      createIntent('delete-path', root, [{ kind: 'path', value: '.git' }])
    )
    const gitFile = await resolveOperationIntentTargets(
      createIntent('delete-path', root, [{ kind: 'path', value: '.git/config' }])
    )
    const fullDir = await resolveOperationIntentTargets(
      createIntent('delete-path', root, [{ kind: 'path', value: 'full' }])
    )
    const writeFile = await resolveOperationIntentTargets(
      createIntent('write-file', root, [{ kind: 'path', value: 'src/a.ts' }])
    )

    expect(evaluatePermissionPolicy(normalFile)).toMatchObject({
      kind: 'approval',
      risk: 'L1',
      allowedScopes: ['once', 'task']
    })
    expect(evaluatePermissionPolicy(emptyDir)).toMatchObject({
      kind: 'approval',
      risk: 'L1',
      allowedScopes: ['once', 'task']
    })
    for (const dangerous of [gitDir, gitFile, fullDir]) {
      expect(evaluatePermissionPolicy(dangerous)).toMatchObject({
        kind: 'approval',
        risk: 'L3',
        allowedScopes: ['once']
      })
    }

    expect(createOperationGrantKey(normalFile)).toBe(createOperationGrantKey(otherFile))
    expect(createOperationGrantKey(normalFile)).toBe(createOperationGrantKey(emptyDir))
    expect(createOperationGrantKey(normalFile)).not.toBe(createOperationGrantKey(gitDir))
    expect(createOperationGrantKey(gitDir)).not.toBe(createOperationGrantKey(gitFile))
    expect(createOperationGrantKey(writeFile)).not.toBe(createOperationGrantKey(normalFile))

    await expect(
      resolveOperationIntentTargets(
        createIntent('delete-path', root, [{ kind: 'path', value: join(root, '..', 'outside.ts') }])
      )
    ).rejects.toMatchObject({ code: 'invalid-target' } satisfies Partial<PermissionPolicyError>)
  })

  it('execute grant 只绑定命令指纹，未知/出网保持精确目标且不受 rawInput 影响', async () => {
    const root = await fs.realpath(await createTemporaryDirectory('policy-grant-'))
    const execA = await resolveOperationIntentTargets({
      ...createIntent('execute-command', root),
      parameterFingerprint: 'cmd-a'
    })
    const execB = await resolveOperationIntentTargets({
      ...createIntent('execute-command', root),
      parameterFingerprint: 'cmd-b'
    })
    const execSameFingerprint = await resolveOperationIntentTargets({
      ...createIntent('execute-command', root, [{ kind: 'command', value: '另一条命令' }]),
      parameterFingerprint: 'cmd-a'
    })
    const unknownA = await resolveOperationIntentTargets({
      ...createIntent('unknown', root, [{ kind: 'unknown', value: 'computer-use' }])
    })
    const unknownB = await resolveOperationIntentTargets({
      ...createIntent('unknown', root, [{ kind: 'unknown', value: 'screen-capture' }])
    })
    const fetchUnknown = await resolveOperationIntentTargets({
      ...createIntent('network-egress', root, [{ kind: 'unknown', value: '目标未确认' }]),
      minimumRisk: 'L3'
    })

    expect(createOperationGrantKey(execA)).not.toBe(createOperationGrantKey(execB))
    expect(createOperationGrantKey(execA)).toBe(createOperationGrantKey(execSameFingerprint))
    expect(createOperationGrantKey(unknownA)).not.toBe(createOperationGrantKey(unknownB))
    expect(createOperationGrantKey(execA)).not.toBe(createOperationGrantKey(unknownA))
    expect(createOperationGrantKey(fetchUnknown)).not.toBe(createOperationGrantKey(unknownA))

    const withRawInput = {
      ...execA,
      rawInput: { command: 'rm -rf /', apiKey: 'sk-fake-not-for-grant' }
    } as typeof execA & { rawInput: { command: string; apiKey: string } }
    expect(createOperationGrantKey(withRawInput)).toBe(createOperationGrantKey(execA))
    expect(JSON.stringify(createGrantKeyInspection(execA))).not.toContain('rawInput')
    expect(JSON.stringify(createGrantKeyInspection(execA))).not.toContain('sk-fake')
  })
})

function createGrantKeyInspection(intent: Parameters<typeof createOperationGrantKey>[0]): unknown {
  return {
    initiator: intent.initiator,
    taskId: intent.taskId,
    projectId: intent.projectId,
    environmentId: intent.environmentId,
    operationType: intent.operationType,
    targets: intent.targets,
    parameterFingerprint: intent.parameterFingerprint
  }
}

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

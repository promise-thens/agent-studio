import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentAvailableCommand } from '../../shared/agent-available-command'
import {
  PRODUCT_SLASH_COMMANDS,
  SLASH_RUNTIME_WAITING_COPY,
  applyAvailableCommandFetchIfCurrent,
  applyAvailableCommandSnapshotIfCurrent,
  completeSlashComposerPrompt,
  filterSlashCommands,
  isSlashComposerDraft,
  matchProductSlashSubmit,
  mergeSlashCommands,
  resolveSlashSubmit,
  shouldShowSlashRuntimeWaiting,
  slashQuery,
  type SlashCommandItem
} from './slash-command-palette'

const rendererDir = dirname(fileURLToPath(import.meta.url))
const helperSource = readFileSync(join(rendererDir, 'slash-command-palette.ts'), 'utf8')
const paletteSource = readFileSync(join(rendererDir, 'components/SlashCommandPalette.vue'), 'utf8')
const composerSource = readFileSync(join(rendererDir, 'components/TaskComposer.vue'), 'utf8')
const appSource = readFileSync(join(rendererDir, 'App.vue'), 'utf8')

function runtimeCommand(
  partial: Partial<AgentAvailableCommand> & Pick<AgentAvailableCommand, 'name'>
): AgentAvailableCommand {
  return {
    description: partial.description ?? partial.name,
    ...partial
  }
}

function merged(runtime: AgentAvailableCommand[] = []): SlashCommandItem[] {
  return mergeSlashCommands({
    runtime,
    product: PRODUCT_SLASH_COMMANDS
  })
}

describe('斜杠草稿识别', () => {
  it('以 / 开头才是草稿，前导空白不算', () => {
    expect(isSlashComposerDraft('/')).toBe(true)
    expect(isSlashComposerDraft('/plug')).toBe(true)
    expect(isSlashComposerDraft('/compact keep auth')).toBe(true)
    expect(isSlashComposerDraft('')).toBe(false)
    expect(isSlashComposerDraft('hello')).toBe(false)
    expect(isSlashComposerDraft(' /x')).toBe(false)
    expect(isSlashComposerDraft(' /plugins')).toBe(false)
  })

  it('查询只取首个 / 之后到第一个空白的片段', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/plug')).toBe('plug')
    expect(slashQuery('/compact keep auth')).toBe('compact')
    expect(slashQuery('/plugins extra')).toBe('plugins')
    expect(slashQuery(' /x')).toBe('')
  })
})

describe('合并与过滤', () => {
  it('/mem 匹配 memory 别名且 kind 为 product', () => {
    const items = merged()
    const matched = filterSlashCommands(items, slashQuery('/mem'))
    expect(matched.map((item) => item.name)).toEqual(['memory'])
    expect(matched[0]?.source).toBe('product')
    expect(resolveSlashSubmit(matched[0]!, '/mem')).toEqual({
      kind: 'product',
      action: 'open-settings-memory'
    })
  })

  it('/mcp 打开插件页 MCP 栏，不再进设置', () => {
    const items = merged()
    const matched = filterSlashCommands(items, slashQuery('/mcp'))
    expect(matched.map((item) => item.name).sort()).toEqual(['mcp', 'mcps'])
    expect(
      matched.every((item) => {
        const resolved = resolveSlashSubmit(item, '/mcp')
        return resolved.kind === 'product' && resolved.action === 'open-plugins-mcp'
      })
    ).toBe(true)
    expect(PRODUCT_SLASH_COMMANDS.find((item) => item.name === 'mcps')?.productAction).toBe(
      'open-plugins-mcp'
    )
  })

  it('/plug 匹配产品别名 plugins，且选 plugins 不产生 runtime prompt', () => {
    const items = merged([runtimeCommand({ name: 'compact', description: '压缩上下文' })])
    const matched = filterSlashCommands(items, slashQuery('/plug'))

    expect(matched.map((item) => item.name)).toEqual(['plugins'])
    expect(matched[0]?.source).toBe('product')
    expect(resolveSlashSubmit(matched[0]!, '/plug')).toEqual({
      kind: 'product',
      action: 'open-plugins'
    })
    expect(resolveSlashSubmit(matched[0]!, '/plug')).not.toEqual(
      expect.objectContaining({ kind: 'runtime' })
    )
  })

  it('runtime compact 加上 /compact keep auth 原样作为 runtime prompt', () => {
    const items = merged([
      runtimeCommand({ name: 'compact', description: '压缩上下文', inputHint: 'keep auth' })
    ])
    const compact = items.find((item) => item.name === 'compact')

    expect(compact?.source).toBe('runtime')
    expect(resolveSlashSubmit(compact!, '/compact keep auth')).toEqual({
      kind: 'runtime',
      prompt: '/compact keep auth'
    })
    expect(completeSlashComposerPrompt(compact!, '/compact keep auth')).toBe('/compact keep auth')
  })

  it('非法或空 runtime 列表时产品别名仍在', () => {
    const empty = merged([])
    const illegal = mergeSlashCommands({
      runtime: [
        runtimeCommand({ name: '', description: '空名' }),
        runtimeCommand({ name: 'has space', description: '非法' }),
        runtimeCommand({ name: '!!!', description: '非法符号' })
      ],
      product: PRODUCT_SLASH_COMMANDS
    })

    expect(empty.map((item) => item.name)).toEqual([
      'plugins',
      'marketplace',
      'settings',
      'memory',
      'mcps',
      'mcp',
      'config',
      'always-approve'
    ])
    expect(illegal.map((item) => item.name)).toEqual([
      'plugins',
      'marketplace',
      'settings',
      'memory',
      'mcps',
      'mcp',
      'config',
      'always-approve'
    ])
    expect(empty.every((item) => item.source === 'product')).toBe(true)
    expect(PRODUCT_SLASH_COMMANDS.map((item) => item.name)).toEqual([
      'plugins',
      'marketplace',
      'settings',
      'memory',
      'mcps',
      'mcp',
      'config',
      'always-approve'
    ])
  })

  it('同名时产品别名优先，避免 Grok 的 /plugins 抢走导航', () => {
    const items = merged([
      runtimeCommand({ name: 'plugins', description: 'Grok 自己的插件命令' }),
      runtimeCommand({ name: 'settings', description: 'Grok 自己的设置命令' }),
      runtimeCommand({ name: 'compact', description: '压缩上下文' })
    ])

    expect(items.map((item) => `${item.source}:${item.name}`)).toEqual([
      'product:plugins',
      'product:marketplace',
      'product:settings',
      'product:memory',
      'product:mcps',
      'product:mcp',
      'product:config',
      'product:always-approve',
      'runtime:compact'
    ])
    expect(items.find((item) => item.name === 'plugins')?.productAction).toBe('open-plugins')
    expect(items.find((item) => item.name === 'marketplace')?.productAction).toBe(
      'open-plugins-marketplace'
    )
  })

  it('/marketplace 是产品别名，Grok 同名广告不得 startTurn', () => {
    const items = merged([
      runtimeCommand({ name: 'marketplace', description: 'Grok 自己的市场命令' })
    ])
    const matched = filterSlashCommands(items, slashQuery('/marketplace'))

    expect(matched).toHaveLength(1)
    expect(matched[0]?.source).toBe('product')
    expect(matched[0]?.name).toBe('marketplace')
    expect(resolveSlashSubmit(matched[0]!, '/marketplace')).toEqual({
      kind: 'product',
      action: 'open-plugins-marketplace'
    })
    expect(resolveSlashSubmit(matched[0]!, '/marketplace')).not.toEqual(
      expect.objectContaining({ kind: 'runtime' })
    )
    expect(
      items.find((item) => item.source === 'runtime' && item.name === 'marketplace')
    ).toBeUndefined()
  })
})

describe('产品发送拦截', () => {
  it('首 token 是 /plugins 或 /settings 时走产品动作，即使没点命令板', () => {
    expect(matchProductSlashSubmit('/plugins')).toBe('open-plugins')
    expect(matchProductSlashSubmit('/plugins leftover')).toBe('open-plugins')
    expect(matchProductSlashSubmit('/marketplace')).toBe('open-plugins-marketplace')
    expect(matchProductSlashSubmit('/marketplace leftover')).toBe('open-plugins-marketplace')
    expect(matchProductSlashSubmit('/settings')).toBe('open-settings')
    expect(matchProductSlashSubmit('/always-approve')).toBe('open-permission-mode')
    expect(matchProductSlashSubmit('/always-approve leftover')).toBe('open-permission-mode')
    expect(matchProductSlashSubmit('/plug')).toBeNull()
    expect(matchProductSlashSubmit('/compact keep auth')).toBeNull()
    expect(matchProductSlashSubmit(' /plugins')).toBeNull()
  })
})

describe('always-approve 产品别名', () => {
  it('广告的 always-approve 不得作为 runtime 项交给 startTurn', () => {
    const items = merged([
      runtimeCommand({ name: 'always-approve', description: 'Grok 自己的接管命令' }),
      runtimeCommand({ name: 'compact', description: '压缩上下文' })
    ])
    const matched = filterSlashCommands(items, slashQuery('/always-approve'))

    expect(matched).toHaveLength(1)
    expect(matched[0]?.source).toBe('product')
    expect(matched[0]?.name).toBe('always-approve')
    expect(resolveSlashSubmit(matched[0]!, '/always-approve')).toEqual({
      kind: 'product',
      action: 'open-permission-mode'
    })
    expect(resolveSlashSubmit(matched[0]!, '/always-approve')).not.toEqual(
      expect.objectContaining({ kind: 'runtime' })
    )
    expect(
      items.find((item) => item.source === 'runtime' && item.name === 'always-approve')
    ).toBeUndefined()
  })
})

describe('等待文案与过期快照', () => {
  it('无 runtime 命令且 query 为空时用固定等待文案', () => {
    expect(SLASH_RUNTIME_WAITING_COPY).toBe('等待 Grok 提供命令')
    expect(shouldShowSlashRuntimeWaiting([], '')).toBe(true)
    expect(shouldShowSlashRuntimeWaiting([], 'plug')).toBe(false)
    expect(shouldShowSlashRuntimeWaiting([runtimeCommand({ name: 'compact' })], '')).toBe(false)
  })

  it('丢弃 taskId 对不上的快照，IPC 失败则保持原状', () => {
    expect(
      applyAvailableCommandSnapshotIfCurrent({
        selectedTaskId: 'task-b',
        currentRevision: 0,
        snapshot: { taskId: 'task-a', revision: 1, commands: [runtimeCommand({ name: 'compact' })] }
      })
    ).toEqual({ apply: false })

    expect(
      applyAvailableCommandSnapshotIfCurrent({
        selectedTaskId: 'task-b',
        currentRevision: 0,
        snapshot: { taskId: 'task-b', revision: 1, commands: [runtimeCommand({ name: 'compact' })] }
      })
    ).toEqual({
      apply: true,
      commands: [runtimeCommand({ name: 'compact' })],
      revision: 1
    })

    expect(
      applyAvailableCommandFetchIfCurrent({
        selectedTaskId: 'task-b',
        requestedTaskId: 'task-a',
        currentRevision: 0,
        incoming: {
          ok: true,
          snapshot: {
            taskId: 'task-a',
            revision: 1,
            commands: [runtimeCommand({ name: 'compact' })]
          }
        }
      })
    ).toEqual({ apply: false })

    expect(
      applyAvailableCommandFetchIfCurrent({
        selectedTaskId: 'task-b',
        requestedTaskId: 'task-b',
        currentRevision: 0,
        incoming: { ok: false }
      })
    ).toEqual({ apply: false })
  })

  it('同 task 更旧或相同 revision 丢弃，更新的才写入', () => {
    const compact = runtimeCommand({ name: 'compact' })
    const dream = runtimeCommand({ name: 'dream' })

    expect(
      applyAvailableCommandSnapshotIfCurrent({
        selectedTaskId: 'task-a',
        currentRevision: 2,
        snapshot: { taskId: 'task-a', revision: 2, commands: [compact] }
      })
    ).toEqual({ apply: false })

    expect(
      applyAvailableCommandSnapshotIfCurrent({
        selectedTaskId: 'task-a',
        currentRevision: 2,
        snapshot: { taskId: 'task-a', revision: 1, commands: [compact] }
      })
    ).toEqual({ apply: false })

    expect(
      applyAvailableCommandSnapshotIfCurrent({
        selectedTaskId: 'task-a',
        currentRevision: 2,
        snapshot: { taskId: 'task-a', revision: 3, commands: [dream] }
      })
    ).toEqual({ apply: true, commands: [dream], revision: 3 })

    expect(
      applyAvailableCommandFetchIfCurrent({
        selectedTaskId: 'task-a',
        requestedTaskId: 'task-a',
        currentRevision: 3,
        incoming: {
          ok: true,
          snapshot: { taskId: 'task-a', revision: 2, commands: [compact] }
        }
      })
    ).toEqual({ apply: false })

    expect(
      applyAvailableCommandFetchIfCurrent({
        selectedTaskId: 'task-a',
        requestedTaskId: 'task-a',
        currentRevision: 3,
        incoming: {
          ok: true,
          snapshot: { taskId: 'task-a', revision: 4, commands: [dream] }
        }
      })
    ).toEqual({ apply: true, commands: [dream], revision: 4 })
  })
})

describe('命令板表面', () => {
  it('根节点带 slash-command-palette，等待文案固定，不用手写假 Grok 菜单', () => {
    expect(paletteSource).toContain('class="slash-command-palette"')
    expect(paletteSource).toContain('SLASH_RUNTIME_WAITING_COPY')
    expect(paletteSource).toContain('role="listbox"')
    expect(paletteSource).toContain('role="option"')
    expect(paletteSource).not.toContain('/compact')
    expect(paletteSource).not.toContain('/dream')
    expect(paletteSource).not.toContain('/memory')
    expect(paletteSource).not.toContain('/mcps')
    expect(helperSource).not.toContain("name: 'compact'")
    expect(helperSource).toContain("name: 'memory'")
    expect(helperSource).toContain("name: 'mcps'")
  })

  it('Composer 在斜杠草稿时打开命令板，执行中仍可点产品别名', () => {
    expect(composerSource).toContain('isSlashComposerDraft')
    expect(composerSource).toContain('SlashCommandPalette')
    expect(composerSource).toContain("emit('open-plugins')")
    expect(composerSource).toContain("emit('open-settings')")
    expect(composerSource).toContain("emit('open-settings-memory')")
    expect(composerSource).toContain("emit('open-plugins-mcp')")
    expect(composerSource).toContain("emit('open-plugins-marketplace')")
    expect(composerSource).toContain('matchProductSlashSubmit')
    expect(composerSource).toContain("action === 'open-permission-mode'")
    expect(composerSource).toContain('openPermissionModeFromSlash')
    expect(composerSource).not.toContain('继续任务')
    expect(composerSource).toContain('TaskPermissionModeMenu')
    expect(composerSource).toContain('TaskTakeoverConfirmDialog')
  })

  it('App 按 selectedTaskId 订阅命令快照，产品提交不清 startTurn', () => {
    expect(appSource).toContain('window.agent.onAvailableCommands')
    expect(appSource).toContain('window.agent.getAvailableCommands')
    expect(appSource).toContain('applyAvailableCommandSnapshotIfCurrent')
    expect(appSource).toContain('applyAvailableCommandFetchIfCurrent')
    expect(appSource).toContain('runtimeSlashRevision')
    expect(appSource).toContain('currentRevision')
    expect(appSource).toContain('matchProductSlashSubmit')
    expect(appSource).toContain('handleProductSlashAction')
    expect(appSource).toContain('workbench.openPlugins()')
    expect(appSource).toContain('openSettingsDialog()')
    expect(appSource).toContain('open-settings-memory')
    expect(appSource).toContain('open-settings-grok-config')
    expect(appSource).toContain('openPluginHub(pluginTarget.tab, pluginTarget.pane)')
    expect(appSource).toContain('open-plugins-marketplace')
    expect(appSource).toContain('resolveProductSlashPluginTarget')
    expect(appSource).toContain('initial-pane')
    expect(appSource).toContain('open-permission-mode')
    expect(appSource).toContain('openPermissionModeFromSlash')
    expect(appSource).not.toContain("openSettingsSection('mcp')")
  })
})

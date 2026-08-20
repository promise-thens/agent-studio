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

    expect(empty.map((item) => item.name)).toEqual(['plugins', 'settings'])
    expect(illegal.map((item) => item.name)).toEqual(['plugins', 'settings'])
    expect(empty.every((item) => item.source === 'product')).toBe(true)
    expect(PRODUCT_SLASH_COMMANDS.map((item) => item.name)).toEqual(['plugins', 'settings'])
    expect(PRODUCT_SLASH_COMMANDS.map((item) => item.productAction)).toEqual([
      'open-plugins',
      'open-settings'
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
      'product:settings',
      'runtime:compact'
    ])
    expect(items.find((item) => item.name === 'plugins')?.productAction).toBe('open-plugins')
  })
})

describe('产品发送拦截', () => {
  it('首 token 是 /plugins 或 /settings 时走产品动作，即使没点命令板', () => {
    expect(matchProductSlashSubmit('/plugins')).toBe('open-plugins')
    expect(matchProductSlashSubmit('/plugins leftover')).toBe('open-plugins')
    expect(matchProductSlashSubmit('/settings')).toBe('open-settings')
    expect(matchProductSlashSubmit('/plug')).toBeNull()
    expect(matchProductSlashSubmit('/compact keep auth')).toBeNull()
    expect(matchProductSlashSubmit(' /plugins')).toBeNull()
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
        snapshot: { taskId: 'task-a', commands: [runtimeCommand({ name: 'compact' })] }
      })
    ).toEqual({ apply: false })

    expect(
      applyAvailableCommandSnapshotIfCurrent({
        selectedTaskId: 'task-b',
        snapshot: { taskId: 'task-b', commands: [runtimeCommand({ name: 'compact' })] }
      })
    ).toEqual({ apply: true, commands: [runtimeCommand({ name: 'compact' })] })

    expect(
      applyAvailableCommandFetchIfCurrent({
        selectedTaskId: 'task-b',
        requestedTaskId: 'task-a',
        incoming: { ok: true, commands: [runtimeCommand({ name: 'compact' })] }
      })
    ).toEqual({ apply: false })

    expect(
      applyAvailableCommandFetchIfCurrent({
        selectedTaskId: 'task-b',
        requestedTaskId: 'task-b',
        incoming: { ok: false }
      })
    ).toEqual({ apply: false })
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
    expect(helperSource).not.toContain("name: 'memory'")
    expect(helperSource).not.toContain("name: 'mcps'")
  })

  it('Composer 在斜杠草稿时打开命令板，执行中仍可点产品别名', () => {
    expect(composerSource).toContain('isSlashComposerDraft')
    expect(composerSource).toContain('SlashCommandPalette')
    expect(composerSource).toContain("emit('open-plugins')")
    expect(composerSource).toContain("emit('open-settings')")
    expect(composerSource).toContain('matchProductSlashSubmit')
    expect(composerSource).not.toContain('继续任务')
  })

  it('App 按 selectedTaskId 订阅命令快照，产品提交不清 startTurn', () => {
    expect(appSource).toContain('window.agent.onAvailableCommands')
    expect(appSource).toContain('window.agent.getAvailableCommands')
    expect(appSource).toContain('applyAvailableCommandSnapshotIfCurrent')
    expect(appSource).toContain('applyAvailableCommandFetchIfCurrent')
    expect(appSource).toContain('matchProductSlashSubmit')
    expect(appSource).toContain('handleProductSlashAction')
    expect(appSource).toContain('workbench.openPlugins()')
    expect(appSource).toContain('openSettingsDialog()')
    expect(appSource).not.toContain('/memory')
    expect(appSource).not.toContain('/mcps')
  })
})

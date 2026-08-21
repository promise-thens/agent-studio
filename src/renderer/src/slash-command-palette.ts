import {
  AVAILABLE_COMMAND_NAME_PATTERN,
  type AgentAvailableCommand
} from '../../shared/agent-available-command'

export type SlashCommandSource = 'runtime' | 'product'

export interface SlashCommandItem {
  id: string
  name: string
  description: string
  inputHint?: string
  source: SlashCommandSource
  // product 只允许导航，不得 startTurn。
  productAction?:
    | 'open-plugins'
    | 'open-plugins-mcp'
    | 'open-settings'
    | 'open-settings-memory'
    | 'open-settings-grok-config'
}

export const SLASH_RUNTIME_WAITING_COPY = '等待 Grok 提供命令'

/** P0-10C 只提供这两项桌面导航别名；Grok 广告项不得手写进菜单。 */
export const PRODUCT_SLASH_COMMANDS: SlashCommandItem[] = [
  {
    id: 'product:plugins',
    name: 'plugins',
    description: '打开插件页',
    source: 'product',
    productAction: 'open-plugins'
  },
  {
    id: 'product:settings',
    name: 'settings',
    description: '打开设置',
    source: 'product',
    productAction: 'open-settings'
  },
  {
    id: 'product:memory',
    name: 'memory',
    description: '打开记忆设置',
    source: 'product',
    productAction: 'open-settings-memory'
  },
  {
    id: 'product:mcps',
    name: 'mcps',
    description: '打开插件页的 MCP',
    source: 'product',
    productAction: 'open-plugins-mcp'
  },
  {
    id: 'product:mcp',
    name: 'mcp',
    description: '打开插件页的 MCP',
    source: 'product',
    productAction: 'open-plugins-mcp'
  },
  {
    id: 'product:config',
    name: 'config',
    description: '打开 Grok 配置',
    source: 'product',
    productAction: 'open-settings-grok-config'
  }
]

/**
 * 斜杠草稿必须以 `/` 开头。
 * 故意不 trimStart：`' /x'` 只是普通文本，避免空格后的斜杠误开命令板。
 */
export function isSlashComposerDraft(prompt: string): boolean {
  return prompt.startsWith('/')
}

/** 过滤只用首 token（`/` 之后到第一个空白）；多余参数留在原文里给 runtime 提交。 */
export function slashQuery(prompt: string): string {
  if (!isSlashComposerDraft(prompt)) return ''
  const after = prompt.slice(1)
  const end = after.search(/\s/)
  return end === -1 ? after : after.slice(0, end)
}

export function mergeSlashCommands(input: {
  runtime: AgentAvailableCommand[]
  product: SlashCommandItem[]
}): SlashCommandItem[] {
  const product = input.product.filter(
    (item) => item.source === 'product' && Boolean(item.productAction)
  )
  const productNames = new Set(product.map((item) => item.name))
  const runtimeItems: SlashCommandItem[] = []
  const seen = new Set<string>()
  const runtime = Array.isArray(input.runtime) ? input.runtime : []

  for (const command of runtime) {
    if (typeof command?.name !== 'string' || typeof command.description !== 'string') continue
    if (!AVAILABLE_COMMAND_NAME_PATTERN.test(command.name)) continue
    // 同名时产品别名优先：桌面导航不能被 Grok 的 /plugins 抢走去发 prompt。
    if (productNames.has(command.name) || seen.has(command.name)) continue
    seen.add(command.name)
    runtimeItems.push({
      id: `runtime:${command.name}`,
      name: command.name,
      description: command.description,
      ...(command.inputHint ? { inputHint: command.inputHint } : {}),
      source: 'runtime'
    })
  }

  return [...product, ...runtimeItems]
}

export function filterSlashCommands(items: SlashCommandItem[], query: string): SlashCommandItem[] {
  const needle = query.toLowerCase()
  if (!needle) return [...items]
  return items.filter((item) => item.name.toLowerCase().startsWith(needle))
}

export function resolveSlashSubmit(
  item: SlashCommandItem,
  prompt: string
):
  | { kind: 'product'; action: NonNullable<SlashCommandItem['productAction']> }
  | { kind: 'runtime'; prompt: string } {
  if (item.source === 'product' && item.productAction) {
    return { kind: 'product', action: item.productAction }
  }
  return { kind: 'runtime', prompt }
}

/**
 * 发送拦截：即使没点命令板，首 token 是 `/plugins` 或 `/settings` 也只做桌面导航，
 * 不得把产品别名当 prompt 交给 startTurn。
 */
export function matchProductSlashSubmit(
  prompt: string
): NonNullable<SlashCommandItem['productAction']> | null {
  if (!isSlashComposerDraft(prompt)) return null
  const name = slashQuery(prompt)
  const product = PRODUCT_SLASH_COMMANDS.find((item) => item.name === name)
  return product?.productAction ?? null
}

export function shouldShowSlashRuntimeWaiting(
  runtime: AgentAvailableCommand[],
  query: string
): boolean {
  return (!Array.isArray(runtime) || runtime.length === 0) && query === ''
}

/**
 * 点命令板 runtime 项时补全命令名，但保留用户已经写在空白后的参数。
 * `/compact keep auth` 保持原文；`/comp` 补成 `/compact`。
 */
export function completeSlashComposerPrompt(item: SlashCommandItem, prompt: string): string {
  if (!isSlashComposerDraft(prompt)) return `/${item.name}`
  const remainder = prompt.slice(1)
  const spaceIndex = remainder.search(/\s/)
  const args = spaceIndex === -1 ? '' : remainder.slice(spaceIndex)
  return `/${item.name}${args}`
}

/**
 * 同 Task 只接受更新的 revision；切 Task 后调用方必须先把 currentRevision 归零再拉 GET。
 */
function isNewerAvailableCommandRevision(
  currentRevision: number,
  incomingRevision: number
): boolean {
  return Number.isFinite(incomingRevision) && incomingRevision > currentRevision
}

/**
 * 丢弃过期快照：切 Task 后迟到的推送、同 Task 更旧 revision 都不能污染当前命令板。
 */
export function applyAvailableCommandSnapshotIfCurrent(input: {
  selectedTaskId: string
  currentRevision: number
  snapshot: { taskId: string; revision: number; commands: AgentAvailableCommand[] }
}): { apply: true; commands: AgentAvailableCommand[]; revision: number } | { apply: false } {
  if (!input.selectedTaskId || input.snapshot.taskId !== input.selectedTaskId) {
    return { apply: false }
  }
  if (!isNewerAvailableCommandRevision(input.currentRevision, input.snapshot.revision)) {
    return { apply: false }
  }
  return {
    apply: true,
    commands: input.snapshot.commands,
    revision: input.snapshot.revision
  }
}

/**
 * 丢弃过期拉取：selectedTaskId 已变、IPC 失败、或 revision 不新于当前推送时不覆盖。
 * 失败保持调用方现有列表（空或上一份），避免命令板崩溃。
 */
export function applyAvailableCommandFetchIfCurrent(input: {
  selectedTaskId: string
  requestedTaskId: string
  currentRevision: number
  incoming:
    | {
        ok: true
        snapshot: { taskId: string; revision: number; commands: AgentAvailableCommand[] }
      }
    | { ok: false }
}): { apply: true; commands: AgentAvailableCommand[]; revision: number } | { apply: false } {
  if (!input.selectedTaskId || input.selectedTaskId !== input.requestedTaskId) {
    return { apply: false }
  }
  if (!input.incoming.ok) return { apply: false }
  if (input.incoming.snapshot.taskId !== input.selectedTaskId) {
    return { apply: false }
  }
  if (!isNewerAvailableCommandRevision(input.currentRevision, input.incoming.snapshot.revision)) {
    return { apply: false }
  }
  return {
    apply: true,
    commands: input.incoming.snapshot.commands,
    revision: input.incoming.snapshot.revision
  }
}

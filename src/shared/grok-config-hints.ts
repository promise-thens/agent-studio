export const GROK_CONFIG_MAX_BYTES = 128 * 1024

export interface GrokConfigHint {
  table: string
  key?: string
  title: string
  meaning: string
  values?: string
  studioNote?: string
}

export const GROK_CONFIG_STARTER_TOML = `# Agent Studio 为 Grok 生成的配置。改完点保存即可，不必去 Finder 里翻文件。
# 这是 App 专属 config.toml，不会改你家里的 ~/.grok/config.toml。
# 记忆 Markdown 经 junction 与 ~/.grok/memory 整棵树共用（全局 + 项目）。
# [model.agent-studio-default] 由供应商页写入，保存前请先完成供应商配置。

[memory]
# 跨会话记忆。打开后 Grok 才能 /remember、/flush、/dream。
# 文件与终端 Grok 是同一份。
enabled = true

[session]
# 上下文占用到这个百分比时 Grok 会自动压缩。
auto_compact_threshold_percent = 85

[features]
# 匿名遥测。桌面不替你打开。
telemetry = false
`

export const GROK_CONFIG_HINTS: readonly GrokConfigHint[] = [
  {
    table: 'memory',
    key: 'enabled',
    title: 'memory.enabled',
    meaning: '跨会话记忆开关。打开后 Grok 才能 /remember、/flush、/dream。',
    values: 'true / false',
    studioNote:
      '开关写在 App config.toml。全局和项目 Markdown 都与 TUI 共用 ~/.grok/memory，本项不会改家里的 ~/.grok/config.toml。'
  },
  {
    table: 'memory',
    title: '表 memory',
    meaning: 'Grok 跨会话记忆。文件永远在 GROK_HOME/memory，桌面把它接到 ~/.grok/memory。'
  },
  {
    table: 'session',
    key: 'auto_compact_threshold_percent',
    title: 'session.auto_compact_threshold_percent',
    meaning: '上下文占用到这个百分比时 Grok 会自动 compact。',
    values: '1–100 的整数，常见默认 85'
  },
  {
    table: 'session',
    key: 'load_envrc',
    title: 'session.load_envrc',
    meaning: '是否加载项目里的 .envrc。',
    values: 'true / false'
  },
  {
    table: 'session',
    title: '表 session',
    meaning: '会话行为：自动压缩阈值、是否加载 .envrc 等。'
  },
  {
    table: 'features',
    key: 'telemetry',
    title: 'features.telemetry',
    meaning: '匿名遥测。',
    values: 'true / false',
    studioNote: '桌面默认不替你打开。'
  },
  {
    table: 'features',
    key: 'remote_fetch',
    title: 'features.remote_fetch',
    meaning: '是否允许在线拉模型目录。',
    values: 'true / false'
  },
  {
    table: 'features',
    title: '表 features',
    meaning: 'Grok 功能开关，例如遥测和远程目录。'
  },
  {
    table: 'tools',
    key: 'respect_gitignore',
    title: 'tools.respect_gitignore',
    meaning: '工具是否跳过 gitignore 中的文件。',
    values: 'true / false'
  },
  {
    table: 'tools',
    title: '表 tools',
    meaning: 'Grok 工具行为。'
  },
  {
    table: 'plugins',
    key: 'enabled',
    title: 'plugins.enabled',
    meaning: '要启用的插件名单。Grok 默认插件是关的，写进这里才会加载。',
    studioNote: '请用侧栏插件页的开关改，不要在这里手写路径。'
  },
  {
    table: 'plugins',
    key: 'disabled',
    title: 'plugins.disabled',
    meaning: '要停用的插件名单。',
    studioNote: '请用侧栏插件页的开关改。'
  },
  {
    table: 'plugins',
    title: '表 plugins',
    meaning: '插件启停名单。安装、信任和市场货架不在本页。'
  },
  {
    table: 'mcp_servers',
    title: '表 mcp_servers',
    meaning: '每个子表是一个 MCP 服务器，由 Grok 连接，Agent Studio 不自己执行。',
    studioNote:
      'App toml 不要把 Key 写在这里。用户级与 TUI 的 ~/.grok/config.toml 同步；请用设置 MCP 页改。'
  },
  {
    table: 'models',
    key: 'default',
    title: 'models.default',
    meaning: 'Grok 自己的默认模型。',
    studioNote: '工作台模型以供应商页为准，改这里不会切换输入框里的模型。'
  },
  {
    table: 'models',
    title: '表 models',
    meaning: 'Grok 内置模型表。工作台绑定走供应商页写入的 [model.agent-studio-default]。'
  },
  {
    table: 'model.agent-studio-default',
    key: 'context_window',
    title: 'model.agent-studio-default.context_window',
    meaning: 'Grok 用来做 auto-compact 的上下文窗口（token）。省略时自定义模型默认 200000。',
    values: '正整数，例如 200000、500000',
    studioNote: '这是 Grok 原生字段，可在本页修改；连接 Runtime 时不会被供应商绑定覆盖。'
  },
  {
    table: 'model.agent-studio-default',
    title: '表 model.agent-studio-default',
    meaning:
      '供应商页写入绑定：model / base_url / env_key / api_backend。context_window 等其它键是 Grok 原生配置。',
    studioNote:
      '由供应商页管理绑定字段。请勿改成明文 Key；删掉该表会拒绝保存。context_window 可在本页改，保存后会保留。'
  },
  {
    table: 'ui',
    key: 'vim_mode',
    title: 'ui.vim_mode',
    meaning: 'TUI 的 Vim 模式。',
    studioNote: '对工作台无效，那是终端 Grok 的。'
  },
  {
    table: 'ui',
    key: 'simple_mode',
    title: 'ui.simple_mode',
    meaning: 'TUI 简化界面。',
    studioNote: '对工作台无效。'
  },
  {
    table: 'ui',
    key: 'default_selected_permission',
    title: 'ui.default_selected_permission',
    meaning: 'TUI 权限弹窗的默认选项。',
    studioNote: '工作台审批仍走 Agent Studio，不读这一项。'
  },
  {
    table: 'ui',
    title: '表 ui',
    meaning: 'Grok Build TUI 专用界面选项。',
    studioNote: '写在 App toml 里也不会驱动桌面外观；外观请用设置「外观」页。'
  },
  {
    table: 'cli',
    key: 'auto_update',
    title: 'cli.auto_update',
    meaning: 'Grok CLI 是否自动更新。',
    studioNote: '桌面启动使用 grok agent --no-auto-update，这一项几乎无影响。'
  },
  {
    table: 'cli',
    title: '表 cli',
    meaning: 'Grok CLI 行为。'
  }
]

export function matchGrokConfigHint(table: string, key?: string): GrokConfigHint | null {
  const normalizedTable = table.trim()
  if (!normalizedTable) return null
  if (key) {
    const exact = GROK_CONFIG_HINTS.find(
      (hint) => hint.table === normalizedTable && hint.key === key
    )
    if (exact) return exact
  }
  const mcpTable = /^mcp_servers(?:\.|$)/.exec(normalizedTable)
  if (mcpTable) {
    return GROK_CONFIG_HINTS.find((hint) => hint.table === 'mcp_servers' && !hint.key) ?? null
  }
  if (normalizedTable.startsWith('model.agent-studio-default')) {
    return (
      GROK_CONFIG_HINTS.find((hint) => hint.table === 'model.agent-studio-default' && !hint.key) ??
      null
    )
  }
  return GROK_CONFIG_HINTS.find((hint) => hint.table === normalizedTable && !hint.key) ?? null
}

# P0-10D Grok 记忆与 MCP 设置 实施计划

> **状态：** 待开始（2026-08-20 产品确认：记忆可看可改；`config.toml` 可在设置里直接编辑，并带字段说明；表单也会自动合并写入）
>
> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务落地。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **插入点：** [P0-10C](p0-10c-grok-host-surfaces.md) 之后。设置弹窗壳来自 [P0-10B](p0-10b-settings-dialog-and-appearance.md)。

**优先级：** P0-A / 权重 4（让用户看见并配置 Grok 的记忆与 MCP，桌面不自己跑这两套引擎）

**目标：** 设置增加「记忆」「MCP」「Grok 配置」三栏。记忆可看可改。`config.toml` 可以在编辑器里改，右侧（或跟随光标）提示每个字段是干什么的；记忆开关 / MCP 表单仍会自动合并进同一份文件。MCP 由 **Grok 连接并调用**。

**Architecture：** App `GROK_HOME/config.toml` 是 Grok 的配置原文，工作台提供带注释目录的编辑器 + 结构化表单两条写入路径，都经主进程校验后原子写。记忆 Markdown 走同一 `GROK_HOME` 沙箱。MCP Secret 仍只进 `safeStorage`，编辑器保存时若检出明文 Key 则拒绝。`writeGrokProviderConfig` 必须改成合并，不能整文件覆盖把用户注释冲掉。

**Tech Stack：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Electron `safeStorage`、ACP `McpServer` stdio/http。

**Spec：** 2026-08-20 会话。记忆 ≠ 当前上下文占用（占用仍用已有 `usage_update`）。MCP ≠ P3-04 Capability Host：本计划不拉起 MCP 进程，只把描述交给 Grok。

## Global Constraints

- Node `>=20`，本机验证优先 22/24；pnpm 10。
- IPC 用 `app:*` / `agent:*`，不得新增 `grok:*`。
- 不修改用户 `~/.grok`；记忆只看 `userData/grok-home/memory`。
- 已保存 Secret 永不回 Renderer、日志、错误、测试快照。
- `clientCapabilities` 保持 `{}`。
- `safeStorage` 只在 `app.whenReady()` 后调用。
- 中文注释写原因和边界；协议字段保持英文。
- 第一波 MCP 只允许 stdio（绝对可执行路径 + args 数组）和 `http`/`https` URL。

---

## 非目标

- 不实现 Agent Studio 自己的 MCP Host、工具执行器、P3 Manifest。
- 不接 MCP OAuth、SSE（除非握手已核实 Grok 广告 `mcpCapabilities.sse`；默认不做）。
- 不通过 shell 字符串启动 MCP；禁止 `command` 含空格拼接。
- 不把记忆做成桌面自己的向量库；不读、不写用户 `~/.grok`。
- 不把用户本机 `~/.grok/config.toml` 打开或覆盖；只编辑 App 专属 grok-home。
- 编辑器不是「任意文本直通磁盘」：必须能解析为 TOML，超限或含明文 Secret 则拒绝保存。
- **不把 MCP/模型 Secret 建议写进 toml**（env/header 密文只在 `safeStorage`）。提示文案写明这一点。
- 不接插件市场安装；插件启停只写 `[plugins] enabled/disabled`。
- 不把 `/always-approve` 做成设置项。

## 数据流

```text
设置 → Grok 配置（可编辑 toml + 字段提示）
  getGrokConfig() → 读 grok-home/config.toml（空则下发带注释的模板）
  光标所在 [表] / 键 → 右侧提示该字段含义（中文，来自提示目录，不是 Grok 原文整页）
  saveGrokConfig({ text })
    → 解析 TOML、体积、NUL、明文 Secret 扫描
    → 原子写；保留用户自己写的注释
    → 下一 session 由 Grok 读取

界面表单（记忆开关 / MCP / 插件启停 / 模型绑定）
  → GrokHomeConfigController.apply(patch) 只改对应表
  → 尽量保留其它表的注释；被替换的那一张表内注释可能丢掉（编辑器里可再写回来）

设置 → 记忆（看 + 改）
  listMemories / getMemory
    → realpath 限制在 grok-home/memory
    → 返回 markdown
  saveMemory({ memoryId, markdown })
    → 同样沙箱、限长、原子写 .md
    → Grok 文件监视会在下次检索时重建索引
  deleteMemory：仅允许 session 文件，不允许删全局/项目 MEMORY.md
  「让 Grok 记住/保存/整理」仍可 startTurn("/remember|/flush|/dream")
    → 写完后再 listMemories()

设置 → MCP
  upsert → mcp-servers.json（含加密 Secret）
        → 同时 merge 进 config.toml [mcp_servers.<name>]（无 Secret）
        → 下次 session/new 把启用项 + 解密 Secret 映射为 acp.McpServer[]
  Grok 连接并调用；桌面不 spawn MCP
```

用户 **可以** 在设置里改 toml 玩字段；表单是快捷方式，两条路写同一份文件。不需要去 Finder 里翻 `config.toml`。

## 安全边界

- 记忆 `memoryId` 不允许 `..`、绝对路径、NUL；`realpath` 必须落在 `memoryRoot` 内。
- 记忆正文读写上限 256 KiB。`get` 若 `truncated: true`，**禁止**用截断正文 `save`（避免把文件剪短）。
- `saveMemory` 只写 UTF-8 Markdown；去掉 NUL；不跟随逃逸 symlink。
- MCP `name`：`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$`，最多 32 项。
- stdio `command` 必须是绝对路径，存在且为文件；`args` 每项 ≤ 4 KiB，最多 32 个。
- URL 用现有 Provider URL 校验：只 http/https，无 userinfo，query/hash 不得像 Secret。
- HTTP header 名白名单；值为 Secret 的 header 不得出现在 list DTO，也不得写入 toml。
- Origin 变更必须清掉该 server 的 Secret，禁止把旧 Key 送到新 URL。
- `apply(patch)` 的 patch 只能是已知键的结构化对象，不能是原始 toml 字符串。
- `saveGrokConfig({ text })` 允许带注释的 toml 全文，但：体积 ≤ 128 KiB、必须解析成功、不得含 NUL、不得把 `api_key` / `token` / `secret` / `password` / `authorization` 写成明文、值不得像 `sk-` 密钥。
- `[model.agent-studio-default]` 的 `env_key` 不得改成明文 Key；若用户删掉该表，保存时警告并拒绝，或自动补回（选拒绝 + 文案「模型绑定由供应商页管理」）。
- Handler 校验主窗口来源。
- 提示目录只解释字段，不把用户文件内容送出进程。

## 文件范围

**创建：**

- `src/shared/grok-memory.ts`、`src/shared/grok-memory.test.ts`
- `src/shared/mcp-server-config.ts`、`src/shared/mcp-server-config.test.ts`
- `src/main/runtime/grok/grok-config-merge.ts`、`grok-config-merge.test.ts`
- `src/main/runtime/grok/grok-home-config-controller.ts`、`grok-home-config-controller.test.ts`
- `src/shared/grok-config-hints.ts`、`src/shared/grok-config-hints.test.ts`
- `src/main/runtime/grok/grok-memory-store.ts`、`grok-memory-store.test.ts`
- `src/main/mcp/mcp-server-store.ts`、`mcp-server-store.test.ts`
- `src/main/mcp/mcp-server-to-acp.ts`、`mcp-server-to-acp.test.ts`
- `src/renderer/src/components/MemorySettingsPanel.vue`
- `src/renderer/src/components/McpSettingsPanel.vue`
- `src/renderer/src/components/GrokConfigEditor.vue`
- `src/renderer/src/grok-config-cursor.ts`、`grok-config-cursor.test.ts`

**修改：**

- `src/renderer/src/settings-dialog.ts`、`settings-dialog.test.ts`、`components/SettingsDialog.vue`
- `src/renderer/src/slash-command-palette.ts`（追加 `/memory` `/mcps` `/config` 产品别名）
- `src/main/provider/grok-provider-config.ts`、对应测试（改为走 merge，禁止裸覆盖）
- `src/main/runtime/grok/grok-acp-adapter.ts`、`grok-acp-adapter.test.ts`（`mcpServers` 不再写死 `[]`）
- `src/main/agent/agent-runtime-adapter.ts`（`AgentRuntimeSessionContext` 可带已校验 mcpServers）
- `src/shared/app-ipc.ts`、`src/main/app-ipc.ts`、preload、`index.ts`
- `docs/superpowers/plans/roadmap-index.md`、`grokACP计划/README.md`（P3-04 不再抢 Grok `mcpServers` 注入）

## 已锁定 UI

设置弹窗左侧栏目顺序：

```text
供应商
外观
记忆
MCP
Grok 配置
```

**记忆页**

- 开关：启用跨会话记忆（写 `config.toml` `[memory] enabled`，目录是 App 专属 Grok Home，不是 `~/.grok`）。
- 列表分组：全局 / 本项目 / 会话。
- 点一项：**可编辑** Markdown，有「保存」「放弃未保存」。脏状态离开前提示。
- 新建：默认追加到全局或本项目 `MEMORY.md`（文件不存在则创建）。
- 删除：仅会话摘要文件；全局/项目 `MEMORY.md` 只能改内容，不能删文件。
- 仍保留「让 Grok 记住 / 保存当前任务 / 整理」——那是让大脑提炼，和人手改文件是两条路。
- 无选中 Task 时，Grok 动作按钮 disable；**本地保存编辑不依赖 Task**。
- 空状态：「还没有记忆。可以在这里直接写，或开着记忆让 Grok 在对话里记住。」

**MCP 页**

- 已添加列表：name、transport、enabled、hasSecret、lastError（脱敏短句）。
- 添加：name、stdio（command + args 一行一个）或 HTTP URL；可选 env/header，Secret 输入框保存后变「已保存」。
- 启停、删除。删除要确认。
- 说明：「MCP 由 Grok Build 连接。Agent Studio 不自己执行这些工具。」
- 空状态引导添加，不做市场。

**Grok 配置页**

```text
┌ 编辑器（config.toml）        ┬ 字段说明 ┐
│ [memory]                    │ 表 memory │
│ enabled = true              │ enabled：跨会话记忆开关 │
│                             │ 写入 App 目录，不是 ~/.grok │
└─────────────────────────────┴───────────┘
  [保存]  [放弃]   解析错误时保存禁用并标行号
```

- 空文件时先给出**带中文注释的模板**（只含安全默认项：`[memory]`、`[session] auto_compact_threshold_percent`、`[features] telemetry` 等），让人看得懂再改。
- 光标落在某个键或 `[表]` 上，右侧显示该条目的中文说明、取值、和桌面的关系（例如 `[ui] vim_mode` 对工作台无效，那是 TUI 的）。
- 未知键：提示「Grok 可能认识，桌面不解释；保存前请确认不是密钥」。
- 脏状态离开前提示。保存成功文案：「已写入 Grok 配置，新对话或重新进入后生效。」

`/memory` → 记忆页；`/mcps` → MCP 页；`/config` → Grok 配置页。产品别名优先于 Grok 同名命令。

---

### Task 1: 设置栏目扩展

**Files:**

- Modify: `src/renderer/src/settings-dialog.ts`、`settings-dialog.test.ts`、`SettingsDialog.vue`

**Produces:**

```ts
export type SettingsSection = 'provider' | 'appearance' | 'memory' | 'mcp' | 'grok-config'
export const SETTINGS_SECTIONS = [
  { id: 'provider', label: '供应商' },
  { id: 'appearance', label: '外观' },
  { id: 'memory', label: '记忆' },
  { id: 'mcp', label: 'MCP' },
  { id: 'grok-config', label: 'Grok 配置' }
] as const
```

`resolveSettingsSection` 未知值仍回 `provider`。本任务先放右侧占位，避免弹窗空白；真正面板在后续任务替换。

- [ ] 测试：`resolveSettingsSection('grok-config') === 'grok-config'`；非法值回 provider。

---

### Task 2: config.toml 由界面自动合并

**Files:**

- Create: `src/main/runtime/grok/grok-config-merge.ts`、`grok-config-merge.test.ts`
- Create: `src/main/runtime/grok/grok-home-config-controller.ts`、`grok-home-config-controller.test.ts`
- Modify: `src/main/provider/grok-provider-config.ts`、现有测试

**Produces:**

```ts
/** 结构化补丁。禁止传入原始 toml 字符串。 */
export interface GrokConfigPatch {
  modelBlock?: string
  memoryEnabled?: boolean
  mcpServers?: ReadonlyArray<{
    name: string
    enabled: boolean
    transport: 'stdio' | 'http'
    command?: string
    args?: string[]
    url?: string
    // 不得包含 env/header Secret。
  }>
  pluginsEnabled?: string[]
  pluginsDisabled?: string[]
}

export function mergeGrokConfigToml(existing: string, patch: GrokConfigPatch): string

export class GrokHomeConfigController {
  constructor(private readonly grokHome: string) {}
  read(): Promise<string>
  apply(patch: GrokConfigPatch): Promise<void>
  /** 编辑器保存：校验后整份写入，保留注释。 */
  writeText(text: string): Promise<void>
}
```

规则：

- 用户不手改文件；所有入口走 `apply(patch)`。
- 保留未知表（Grok 自己写的段不要删）。
- `[model.agent-studio-default]` 与 `[shell_environment_policy]` 仅在 `modelBlock` 出现时替换。
- `[memory] enabled`、`[mcp_servers.<name>]`、`[plugins] enabled/disabled` 按 patch 合并；删除 MCP 时去掉对应表。
- `[mcp_servers.<name>]` 只写 name/command/args/url/enabled，**无 env 值、无 header 值**。
- 原子写：tmp + rename；目录 `0700`、文件 `0600`。
- **禁止**整文件覆盖。
- patch 里若出现 `env`/`headers`/`api_key` 字段，merge **失败**（防 Secret 漏进 toml）。
- 损坏 toml：拒绝 `apply` 记忆/MCP/插件补丁；模型写入若必须重建文件，结果带 `replacedCorruptFile: true`。

- [ ] 测试：已有 `[memory] enabled = true` 时重写模型段，enabled 仍在。
- [ ] 测试：空文件写入模型块 + memoryEnabled true，磁盘 toml 含 `[memory]`。
- [ ] 测试：merge 进一个 stdio MCP 后 toml 有 `[mcp_servers.github]` 且不含 `sk-`。
- [ ] 测试：传入带 env 的 patch 抛错且文件不变。
- [ ] 测试：`writeText` 含注释的合法 toml 保存后 `read()` 仍含该注释。
- [ ] 测试：`writeText` 含 `api_key = "sk-test-not-real"` 被拒绝且文件不变。
- [ ] 测试：删掉 `[model.agent-studio-default]` 的全文被拒绝。

GitNexus：改 `writeGrokProviderConfig` 前对它做 upstream impact。

---

### Task 2b: 带字段说明的 toml 编辑器

**Files:**

- Create: `src/shared/grok-config-hints.ts`、`src/shared/grok-config-hints.test.ts`
- Create: `src/renderer/src/grok-config-cursor.ts`、`grok-config-cursor.test.ts`
- Create: `src/renderer/src/components/GrokConfigEditor.vue`
- Modify: `SettingsDialog.vue`、`app-ipc`、preload、`index.ts`

**Produces:**

```ts
export interface GrokConfigHint {
  table: string
  key?: string
  title: string
  meaning: string
  values?: string
  studioNote?: string
}

export const GROK_CONFIG_HINTS: readonly GrokConfigHint[]
export function matchGrokConfigHint(table: string, key?: string): GrokConfigHint | null
export function parseTomlCursor(text: string, cursorOffset: number): { table: string; key?: string }

export const GROK_CONFIG_STARTER_TOML = `# Agent Studio 为 Grok 生成的配置。改完点保存即可，不必去 Finder 里翻文件。
# 这是 App 专属目录，不会改你家里的 ~/.grok/config.toml。

[memory]
# 跨会话记忆。打开后 Grok 才能 /remember、/flush、/dream。
enabled = true

[session]
# 上下文占用到这个百分比时 Grok 会自动压缩。
auto_compact_threshold_percent = 85

[features]
# 匿名遥测。桌面不替你打开。
telemetry = false
`

APP_INVOKE_CHANNELS.getGrokConfig = 'app:get-grok-config'
APP_INVOKE_CHANNELS.saveGrokConfig = 'app:save-grok-config'
```

第一波必须收入提示目录的表（中文 `meaning`，键名保持官方英文）：

| table | key | 要点 |
| --- | --- | --- |
| memory | enabled | 跨会话记忆开关 |
| session | auto_compact_threshold_percent | 自动 compact 阈值 |
| session | load_envrc | 是否加载 `.envrc` |
| features | telemetry | 匿名遥测 |
| features | remote_fetch | 是否允许在线拉模型目录 |
| tools | respect_gitignore | 工具是否跳过 gitignore |
| plugins | enabled / disabled | 插件启停名单 |
| mcp_servers | （表级） | 每个子表是一个 MCP；**不要把 Key 写在这里**，用设置 MCP 页 |
| models | default | Grok 自己的默认模型；工作台模型以供应商页为准 |
| model.agent-studio-default | （表级） | 由供应商页写入，请勿改成明文 Key |
| ui | vim_mode / simple_mode / default_selected_permission | **TUI 专用**；工作台审批仍走 Agent Studio |
| cli | auto_update | 对 `grok agent --no-auto-update` 启动几乎无影响 |

`matchGrokConfigHint`：先精确 `table+key`，再退到表级。

编辑器：等宽、行号可选、不引入新编辑器库。右侧固定提示栏。`parseTomlCursor` 只做轻量扫描当前 `[section]` 和 `key =`，不必完整 AST。

- [ ] 测试：光标在 `enabled = true` 且上一表是 `[memory]` → 命中 memory.enabled。
- [ ] 测试：光标在未知键 → `match` 为表级或 null，UI 显示「桌面不解释」。
- [ ] 测试：get 空文件返回 starter 模板（或磁盘不存在时返回模板且尚未写盘，直到用户保存）。
- [ ] 测试：save 非法 toml 返回 `invalid-input` 且带行号/「无法解析」。

空文件策略：`getGrokConfig` 若文件不存在，返回 `{ text: GROK_CONFIG_STARTER_TOML, seeded: true }`，**先不写盘**；用户按保存才落地。避免没进过配置页就改了 Grok 默认。

---

### Task 3: 记忆扫描与保存

**Files:**

- Create: `src/shared/grok-memory.ts`、测试
- Create: `src/main/runtime/grok/grok-memory-store.ts`、测试

**Produces:**

```ts
export type GrokMemoryScope = 'global' | 'project' | 'session'

export interface GrokMemorySummary {
  memoryId: string
  scope: GrokMemoryScope
  title: string
  updatedAt: string | null
}

export interface GrokMemoryDocument {
  memoryId: string
  scope: GrokMemoryScope
  title: string
  markdown: string
  truncated?: true
}
```

布局按 Grok 文档：

- `memory/MEMORY.md` → global
- `memory/<slug>-<hash8>/MEMORY.md` → project
- `memory/<slug>-<hash8>/sessions/*.md` → session

`memoryId` 用相对 posix 路径，例如 `global/MEMORY.md`、`project/foo-deadbeef/MEMORY.md`。主进程映射回真实文件。

```ts
export function saveGrokMemoryDocument(input: {
  grokHome: string
  memoryId: string
  markdown: string
}): Promise<GrokMemoryDocument>

export function deleteGrokMemoryDocument(input: {
  grokHome: string
  memoryId: string
}): Promise<void>
```

保存：原子写；必要时 `mkdir` 项目目录 `0700`、文件 `0600`。只允许写已识别的三种布局。`delete`：`scope === 'session'` 才允许，否则 `invalid-input`。

- [ ] 测试：临时 grok-home 放三份文件，list 分组正确。
- [ ] 测试：`memoryId` 含 `..` 的 get/save/delete 都被拒绝。
- [ ] 测试：symlink 指到 grok-home 外 → 跳过或 invalid，save 不得跟上。
- [ ] 测试：save 全局 MEMORY.md 后 get 读回相同正文。
- [ ] 测试：delete 全局 MEMORY.md 失败；delete 会话文件成功。

---

### Task 4: 记忆 IPC 与设置面板

**Files:**

- Modify: `src/shared/app-ipc.ts`、`app-ipc.ts`、preload、`index.ts`
- Create: `MemorySettingsPanel.vue`
- Modify: `SettingsDialog.vue`、`App.vue`（把 selectedTaskId / startTurn / 发送是否可用传入）

**Produces:**

```ts
APP_INVOKE_CHANNELS.listMemories = 'app:list-memories'
APP_INVOKE_CHANNELS.getMemory = 'app:get-memory'
APP_INVOKE_CHANNELS.saveMemory = 'app:save-memory'
APP_INVOKE_CHANNELS.deleteMemory = 'app:delete-memory'
APP_INVOKE_CHANNELS.getMemoryEnabled = 'app:get-memory-enabled'
APP_INVOKE_CHANNELS.setMemoryEnabled = 'app:set-memory-enabled'
```

`setMemoryEnabled({ enabled: boolean })` 走 Task 2 的 `apply({ memoryEnabled })`。返回 `{ enabled }`，不含路径。

`saveMemory({ memoryId, markdown })`：主进程再做沙箱与限长。面板在 `truncated` 文档上禁用保存，提示「文件过大，不能在此覆盖」。

面板：

- 编辑器：保存 / 放弃；Ctrl/Cmd+S 触发 saveMemory。
- 让 Grok 提炼（可选）：`/remember` `/flush` `/dream` 仍 `startTurn`；失败走现有错误条。
- 本地保存 **不** 要求有选中 Task。

---

### Task 5: MCP 配置契约与存储

**Files:**

- Create: `src/shared/mcp-server-config.ts`、测试
- Create: `src/main/mcp/mcp-server-store.ts`、测试

**Produces:**

```ts
export type McpTransportKind = 'stdio' | 'http'

export interface McpServerInput {
  name: string
  enabled: boolean
  transport: McpTransportKind
  command?: string
  args?: string[]
  url?: string
  // Secret 只在写入时出现；读取 DTO 不得包含。
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface McpServerSummary {
  name: string
  enabled: boolean
  transport: McpTransportKind
  command?: string
  url?: string
  hasSecret: boolean
  lastError?: string
}
```

存储分两层：

1. `userData/config/mcp-servers.json`：完整记录 + Secret 密文（`safeStorage`）。Linux `basic_text` 时本会话可用、不得持久化 Secret。
2. 同步 `GrokHomeConfigController.apply({ mcpServers })`：toml 里只有非 Secret 字段，供 Grok 自己读配置。

upsert/delete 必须两处一起成功或一起失败（先写 json 再 merge toml；toml 失败则回滚 json 不作为第一版强要求，但必须测「toml 失败时 UI 报错且 list 与磁盘一致」——推荐：先 merge toml（无 Secret）再写 json（含密文），任一步失败返回错误）。

- [ ] 测试：假 Key `sk-test-not-real` 加密后 list 只有 `hasSecret: true`。
- [ ] 测试：改 URL origin 后 hasSecret 变 false，旧密文删掉。
- [ ] 测试：相对路径 command 拒绝。

---

### Task 6: 映射到 ACP mcpServers 并注入 Adapter

**Files:**

- Create: `src/main/mcp/mcp-server-to-acp.ts`、测试
- Modify: `agent-runtime-adapter.ts` 的 `AgentRuntimeSessionContext`
- Modify: `grok-acp-adapter.ts` 三处 `mcpServers: []`（new / load / resume）及测试
- Modify: `agent-service.ts`：create/load/resume 时读 store 的 enabled 项

**Produces:**

```ts
export function toAcpMcpServers(
  servers: readonly McpServerRecord[]
): acp.McpServer[]
```

stdio → `{ name, command, args, env: [{ name, value }] }`（ACP Stdio 形状以当期 SDK 为准，测试锁字段）。http → `{ type: 'http', name, url, headers: [{ name, value }] }`。未启用的不注入。解密失败的项跳过并写 `lastError: '凭据不可用'`，不得用空字符串当 Key。

`AgentRuntimeSessionContext` 增加 `mcpServers: acp.McpServer[]` 会把 ACP 类型漏进 agent 层。**不要这样做。** 改为 Adapter 在 `createSession` 时向主进程已注入的 `McpServerProvider` 拉已映射结构，或 session context 使用 `src/shared` 中性 DTO，Adapter 内再转 ACP。

推荐：

```ts
export interface AgentRuntimeMcpServer {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: { name: string; value: string }[]
  url?: string
  headers?: { name: string; value: string }[]
}

export interface AgentRuntimeSessionContext {
  workspace: string
  mcpServers: AgentRuntimeMcpServer[]
}
```

Adapter 内转换成 SDK 对象。测试：`newSession` 收到非空 mcpServers；默认无配置时仍是 `[]`。

GitNexus：改 `createSession` / `loadSession` / `resumeSession` 前做 impact。

---

### Task 7: MCP 设置面板

**Files:**

- Create: `McpSettingsPanel.vue`
- Modify: `SettingsDialog.vue`、app-ipc、preload

**Produces:**

```ts
APP_INVOKE_CHANNELS.listMcpServers = 'app:list-mcp-servers'
APP_INVOKE_CHANNELS.upsertMcpServer = 'app:upsert-mcp-server'
APP_INVOKE_CHANNELS.deleteMcpServer = 'app:delete-mcp-server'
```

`upsert` 请求字段白名单。更新已有 server 时，空 Secret 表示保持原密文。删除后不得残留密文。

已启用的 MCP 在**下一次** session/new 或 resume 生效。UI 写一句：「当前对话不会热重载 MCP，新 Task 或重新进入后由 Grok 连接。」不要假装已经连上。想看原文可去「Grok 配置」页，不必打开 Finder。

---

### Task 8: 插件启停写回 config.toml

**Files:**

- Modify: `src/shared/app-ipc.ts`、`app-ipc.ts`、preload
- Modify: P0-10C 的 `PluginsPage.vue`（加上开关，调用本任务 IPC）

**Produces:**

```ts
APP_INVOKE_CHANNELS.setPluginEnabled = 'app:set-plugin-enabled'
// { pluginId: string, enabled: boolean }
```

`apply({ pluginsEnabled / pluginsDisabled })` 按 Grok 文档写 `[plugins] enabled` / `disabled`。不安装、不信任市场源。生效时机与 MCP 相同：下一 session。页面开关失败要报错，不得本地乐观打勾。

- [ ] 测试：enable 后 toml 含该 id；disable 后进入 disabled 列表。
- [ ] 测试：非法 pluginId（含 `/` `..`）拒绝。

---

### Task 9: 命令板产品别名

**Files:**

- Modify: `src/renderer/src/slash-command-palette.ts`、测试、`App.vue`

P0-10C 的 `productAction` 扩展：

```ts
productAction?: 'open-plugins' | 'open-settings' | 'open-settings-memory' | 'open-settings-mcp' | 'open-settings-grok-config'
```

`/memory`、`/mcps`（及 `/mcp`）、`/config` 打开设置对应栏目。与 Grok 广告同名时产品别名优先。`/config` 进「Grok 配置」编辑器，不是外观页。

- [ ] 测试：`/mem` 匹配 memory 别名且 kind 为 product。

---

### Task 10: 验证

- [ ] 目标文件 ESLint、`pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`
- [ ] 确认 `grok-acp-adapter.test.ts` 不再写死三处 `mcpServers: []` 为唯一合法值；无配置时为空，有配置时注入。
- [ ] 开发版手工：开记忆开关后 toml 出现 `[memory]`。设置里改记忆并保存仍在。Grok 配置页改注释/字段能保存，光标有中文提示；写入 `api_key` 被拒绝。加 MCP 后 toml 有 server 且无 Key。不跑真实付费 MCP。
- [ ] 不得用真 API Key。测试 Key 必须明显是假的。

## 验收标准

- [ ] 设置有记忆、MCP、Grok 配置三栏；检查器标签不变。
- [ ] 记忆可看、可改、可保存；只动 App `GROK_HOME/memory`，不碰 `~/.grok`。
- [ ] 表单会自动合并 toml；同时可以在「Grok 配置」里改原文并看到字段说明。
- [ ] 含明文 Key 的 toml 不能保存；用户注释在 `writeText` 路径下保留。
- [ ] 表单合并与编辑器写的是同一份文件；不碰 `~/.grok`。
- [ ] `config.toml` 无 API Key / MCP Secret（编辑器拒绝，表单不写入）。
- [ ] 重写模型配置后 `[memory] enabled` 与 `[mcp_servers]` 仍在。
- [ ] 启用的 MCP 出现在下一次 `session/new` 的 `mcpServers`；Secret 不进 Renderer。
- [ ] Agent Studio 不自己 spawn MCP。
- [ ] `/memory` `/mcps` `/config` 打开对应设置页，不向 Grok 误发导航命令。
- [ ] P3-04 仍未开工；本计划不是 Capability Pack。

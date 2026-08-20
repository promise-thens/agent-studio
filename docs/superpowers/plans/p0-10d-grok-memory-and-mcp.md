# P0-10D Grok 记忆与 MCP 设置 实施计划

> **状态：** 代码已落地（2026-08-20）。自动测试覆盖合并 toml、记忆沙箱、MCP 密文、ACP 注入和斜杠别名；开发版 GUI 走查与 TUI 对读仍待做。
>
> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务落地。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **插入点：** [P0-10C](p0-10c-grok-host-surfaces.md) 之后。设置弹窗壳来自 [P0-10B](p0-10b-settings-dialog-and-appearance.md)。

**优先级：** P0-A / 权重 4（让用户看见并配置 Grok 的记忆与 MCP，桌面不自己跑这两套引擎）

**目标：** 设置增加「记忆」「MCP」「Grok 配置」三栏。记忆可看可改。`config.toml` 可以在编辑器里改，右侧（或跟随光标）提示每个字段是干什么的；记忆开关 / MCP 表单仍会自动合并进同一份文件。MCP 由 **Grok 连接并调用**。

**Architecture：** App `GROK_HOME/config.toml` 是 Grok 的配置原文，工作台提供带注释目录的编辑器 + 结构化表单两条写入路径，都经主进程校验后原子写。Grok 没有单独的记忆根路径，记忆永远在 `GROK_HOME/memory`。产品确认后，把 **整个** `userData/grok-home/memory` **junction / 目录符号链接** 到用户 `~/.grok/memory`（不是只链 `MEMORY.md`）。共享范围包括：

- 全局 `MEMORY.md`
- **项目 / workspace** ` <slug>-<hash8>/MEMORY.md`
- 该项目下 `sessions/*.md`
- 同目录里 Grok 自己的 SQLite 索引

TUI 与桌面对同一仓库必须落到同一 `<slug>-<hash8>`：Grok 用 git `origin`（否则用目录路径）算身份。桌面 spawn 的 cwd 必须是当前 Local Project 的磁盘根，不得用 App grok-home 当 cwd 去算 hash。`GROK_HOME` 本身仍是 App 目录：config、密钥、插件、marketplace-cache **不**改成 `~/.grok`。

MCP 不能整份 junction `config.toml`。用户级服务器在 TUI 的 `~/.grok/config.toml` 的 `[mcp_servers.<name>]`。桌面 GROK_HOME 隔离后默认读不到这份表，所以要做 **只合并 `[mcp_servers.*]` 的双向同步**：定义进 App grok-home toml（无 Secret）+ `mcp-servers.json`（Secret 在 `safeStorage`）；TUI 侧保留 Grok 原文表（可含 `env`/`headers`，那是 TUI 自己的落点）。仓库 `.grok/config.toml` 的项目 MCP 不复制：spawn cwd 已经是项目根，Grok 会自己加载。OAuth 文件 `~/.grok/mcp_credentials.json` 第一波不接。`writeGrokProviderConfig` 必须改成合并，不能整文件覆盖把 `[memory]` / `[mcp_servers]` 冲掉。

**Tech Stack：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、Electron `safeStorage`、ACP `McpServer` stdio/http。

**Spec：** 2026-08-20 会话。记忆 ≠ 当前上下文占用（占用仍用已有 `usage_update`）。MCP ≠ P3-04 Capability Host：本计划不拉起 MCP 进程，只把描述交给 Grok。记忆共享：用户确认「共享同一份目录」，随后确认 **项目记忆也要共享**。MCP 共享：用户确认与 TUI 共用用户级 MCP——桌面设置里加的服务器，TUI `/mcps` 能看见；TUI `config.toml` 里已有的 `[mcp_servers]`，桌面列表也能看见并注入下一 session。Grok 没有只读记忆模式。

## Global Constraints

- Node `>=20`，本机验证优先 22/24；pnpm 10。
- IPC 用 `app:*` / `agent:*`，不得新增 `grok:*`。
- **记忆目录例外：** 整个 `grok-home/memory` 接到 `~/.grok/memory`，含全局、项目 `<slug>-<hash8>`、会话摘要和索引。允许创建该目录、跟随这一条 junction、经 Grok / 设置页读写其中的 Markdown。不得只链全局文件而把项目子目录留在 App 侧。不得因此把 `GROK_HOME` 改成 `~/.grok`。
- **MCP 表例外：** 主进程可以读、合并写入用户 `~/.grok/config.toml` 里的 **`[mcp_servers.*]` 表**（含 TUI 侧 `env`/`headers`）。禁止改该文件的其它表（`[ui]` `[models]` `[cli]` `[marketplace]` `[memory]` `[privacy]` 等）。禁止把用户 toml 全文交给 Renderer 或 Grok 配置编辑器。
- **仍禁止：** 覆盖整份 `~/.grok/config.toml`；读写 `~/.grok/plugins`、`auth.json`、`mcp_credentials.json`、leader.sock。插件、市场、模型密钥继续走 App grok-home。
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
- 不把记忆做成桌面自己的向量库；索引仍由 Grok 维护。
- 不把整个 `GROK_HOME` 指到 `~/.grok`（会把密钥、插件、config 和 TUI 混在一起）。
- 不把用户本机 `~/.grok/config.toml` **整文件**打开给编辑器或整文件覆盖。记忆 **文件** 经 junction 落在 `~/.grok/memory`。MCP **只**同步 `[mcp_servers.*]`。
- 不把 `~/.grok/mcp_credentials.json` 拷进 App 或 Renderer（MCP OAuth 仍不接）。
- 不把仓库 `.grok/config.toml` 的项目 MCP 复制进 App toml；Grok 已从 cwd 加载。设置页只读展示「来自本项目」，编辑用户级服务器走共享的 `[mcp_servers]`，避免弄脏 git。
- 不共享插件自带的 `.mcp.json`（仍由 P0-10C 库存摘要 / P0-10E 安装负责）。
- 不做「只导入一次」的拷贝方案；不做只读镜像；不把项目记忆另存一份到 App grok-home 或仓库 `.grok/`。共享即整棵 `memory/` 树读写同一份。
- 不共享 `~/.grok/implement-memory/`（那是 implement skill 的另一套文件，不是 Grok `[memory]`）。
- 不在桌面自己实现 slug/hash 算法去「猜」目录名；列表扫描共享树里实际存在的 `<slug>-<hash8>`。当前 Local Project 的高亮，用 Grok 已写下的目录 + 选中项目名/远程做 best-effort 匹配，匹配不上就全部列在「项目」分组，不得新建第二套 hash 目录。
- 编辑器不是「任意文本直通磁盘」：必须能解析为 TOML，超限或含明文 Secret 则拒绝保存。
- **不把 MCP/模型 Secret 建议写进 toml**（env/header 密文只在 `safeStorage`）。提示文案写明这一点。
- 不接插件市场安装；插件启停只写 `[plugins] enabled/disabled`。安装、信任、货架见 [P0-10E](p0-10e-grok-plugin-install-and-trust.md)。
- 不把 `/always-approve` 做成设置项。

## 数据流

```text
启动 / 写 Provider 配置
  writeGrokProviderConfig / Adapter spawn
    → ensureSharedGrokMemory(grokHome)
        mkdir ~/.grok/memory（若不存在）
        grok-home/memory → junction/symlink → ~/.grok/memory
        （整棵树：全局 + 各 <slug>-<hash8>/ + sessions/ + 索引）
    → App config.toml [memory] enabled = true（合并写入，不覆盖其它表）
    → Runtime env GROK_HOME=app grok-home，GROK_MEMORY=1
    → spawn cwd = Local Project 磁盘根（让 Grok 算出与 TUI 相同的项目 hash；并加载仓库 .grok/config.toml 的项目 MCP）
    → 不整文件改 ~/.grok/config.toml

设置 → MCP
  启动时 syncUserMcpServers()
    → 只解析 ~/.grok/config.toml 的 [mcp_servers.*]
    → 非 Secret 合并进 App grok-home toml
    → env/headers 进 safeStorage；DTO 只有 hasSecret
  upsert / delete
    → App mcp-servers.json + App toml（无 Secret）
    → 再 merge 同一 name 到 ~/.grok/config.toml 的 [mcp_servers.name]
      （TUI 原文允许 env；其它表字节级尽量不动）
    → 下次 session/new 把启用项 + 解密 Secret 映射为 acp.McpServer[]
  仓库 .grok/config.toml：只读列出，不写回
  Grok 连接并调用；桌面不 spawn MCP

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
    → 逻辑根仍是 grok-home/memory
    → realpath 允许落到 ~/.grok/memory（仅这一条共享目标）
    → 其它逃出 grok-home 的 symlink 仍 invalid
    → 返回 markdown，DTO 不含绝对路径
  saveMemory({ memoryId, markdown })
    → 同样沙箱、限长、原子写 .md（会写进共享目录）
    → Grok 文件监视会在下次检索时重建索引
  deleteMemory：仅允许 session 文件，不允许删全局/项目 MEMORY.md
  「让 Grok 记住/保存/整理」仍可 startTurn("/remember|/flush|/dream")
    → 写完后再 listMemories()

```

用户 **可以** 在设置里改 toml 玩字段；表单是快捷方式，两条路写同一份文件。不需要去 Finder 里翻 `config.toml`。

## 安全边界

- 记忆 `memoryId` 不允许 `..`、绝对路径、NUL。
- `memoryRoot` 沙箱：逻辑路径必须在 `grok-home/memory` 下。`realpath` 只允许两种落点：仍在 `grok-home` 内，或等于已解析的 `~/.grok/memory`（共享目标）。其它目标一律 invalid，save 不得跟上。
- 共享目标路径由主进程用 `homedir()` 拼出，Renderer 不得传入「请读这个绝对路径」。
- 记忆正文读写上限 256 KiB。`get` 若 `truncated: true`，**禁止**用截断正文 `save`（避免把文件剪短）。
- `saveMemory` 只写 UTF-8 Markdown；去掉 NUL。
- 不得把 `~/.grok/memory` 以外的用户家目录文件读进 IPC。
- MCP `name`：`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$`，最多 32 项。
- stdio `command` 必须是绝对路径，存在且为文件；`args` 每项 ≤ 4 KiB，最多 32 个。
- URL 用现有 Provider URL 校验：只 http/https，无 userinfo，query/hash 不得像 Secret。
- HTTP header 名白名单；值为 Secret 的 header 不得出现在 list DTO，也 **不得写入 App grok-home toml**。回写 `~/.grok/config.toml` 的 `[mcp_servers.*]` 时，TUI 需要 `env`/`headers` 才能自己连上——只允许写进这一组表，且不得出现在 Renderer。
- 用户 toml 路径固定 `join(homedir(), '.grok', 'config.toml')`。不存在则跳过同步，不得创建一份完整用户配置把 TUI 默认冲掉。Renderer 不得传入该路径。
- 合并用户 toml：解析失败或目标不是文件 → 操作失败、用户文件不变。不得把 App 的 `[model.agent-studio-default]` 写进用户文件。
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
- `src/main/runtime/grok/grok-shared-memory.ts`、`grok-shared-memory.test.ts`
- `src/main/runtime/grok/grok-memory-store.ts`、`grok-memory-store.test.ts`
- `src/main/mcp/mcp-server-store.ts`、`mcp-server-store.test.ts`
- `src/main/mcp/grok-user-mcp-sync.ts`、`grok-user-mcp-sync.test.ts`
- `src/main/mcp/mcp-server-to-acp.ts`、`mcp-server-to-acp.test.ts`
- `src/renderer/src/components/MemorySettingsPanel.vue`
- `src/renderer/src/components/McpSettingsPanel.vue`
- `src/renderer/src/components/GrokConfigEditor.vue`
- `src/renderer/src/grok-config-cursor.ts`、`grok-config-cursor.test.ts`

**修改：**

- `src/renderer/src/settings-dialog.ts`、`settings-dialog.test.ts`、`components/SettingsDialog.vue`
- `src/renderer/src/slash-command-palette.ts`（追加 `/memory` `/mcps` `/config` 产品别名）
- `src/main/provider/grok-provider-config.ts`、对应测试（改为走 merge，禁止裸覆盖；写盘后 `ensureSharedGrokMemory`）
- `src/main/runtime/grok/grok-acp-adapter.ts`、`grok-acp-adapter.test.ts`（`mcpServers` 不再写死 `[]`；`GROK_MEMORY=1`）
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

- 开关：启用跨会话记忆（写 App `config.toml` `[memory] enabled`）。说明一句：「与 Grok Build TUI 共用 `~/.grok/memory`，全局和项目记忆都会两边看见。」
- 列表分组：全局 / 项目（共享树里每个 `<slug>-<hash8>`） / 会话（挂在对应项目下）。当前选中的 Local Project 若能对上，标「本项目」。
- 点一项：**可编辑** Markdown，有「保存」「放弃未保存」。脏状态离开前提示。
- 新建：默认追加到全局或本项目 `MEMORY.md`（文件不存在则创建，落在共享目录）。
- 删除：仅会话摘要文件；全局/项目 `MEMORY.md` 只能改内容，不能删文件。
- 仍保留「让 Grok 记住 / 保存当前任务 / 整理」——那是让大脑提炼，和人手改文件是两条路。
- 无选中 Task 时，Grok 动作按钮 disable；**本地保存编辑不依赖 Task**。
- 空状态：「还没有记忆。可以在这里直接写，或开着记忆让 Grok 在对话里记住。全局和项目内容都与终端 Grok 共用。」
- 若 junction 因 App 目录里已有非空 `memory/` 而跳过：页顶提示「未与 TUI 共享：App grok-home 已有独立记忆文件」，不得悄悄删。

**MCP 页**

- 说明：「与 Grok Build TUI 共用用户级 MCP。由 Grok 连接，Agent Studio 不自己执行。」
- 列表：name、transport、enabled、hasSecret、来源（`用户` / `本项目`）、lastError（脱敏短句）。
- `用户`：读写共享的 `[mcp_servers]`（`~/.grok/config.toml` ↔ App 存储）。
- `本项目`：来自仓库 `.grok/config.toml`，只读；提示「改这个文件会进 git，请在仓库里改或复制到用户级」。
- 添加 / 启停 / 删除只作用于用户级。删除要确认，并同步从 TUI toml 去掉该表。
- Secret 输入框保存后变「已保存」；list 看不到明文。
- 空状态：「还没有用户级 MCP。添加后终端 Grok 也能用。本项目若在 `.grok/config.toml` 里配了服务器，会出现在列表里（只读）。」

**Grok 配置页**

```text
┌ 编辑器（config.toml）        ┬ 字段说明 ┐
│ [memory]                    │ 表 memory │
│ enabled = true              │ enabled：跨会话记忆开关 │
│                             │ 开关写在 App config.toml │
│                             │ 文件经 junction 共用 ~/.grok/memory │
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

- [x] 测试：`resolveSettingsSection('grok-config') === 'grok-config'`；非法值回 provider。

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

- [x] 测试：已有 `[memory] enabled = true` 时重写模型段，enabled 仍在。
- [x] 测试：空文件写入模型块 + memoryEnabled true，磁盘 toml 含 `[memory]`。
- [x] 测试：merge 进一个 stdio MCP 后 toml 有 `[mcp_servers.github]` 且不含 `sk-`。
- [x] 测试：传入带 env 的 patch 抛错且文件不变。
- [x] 测试：`writeText` 含注释的合法 toml 保存后 `read()` 仍含该注释。
- [x] 测试：`writeText` 含 `api_key = "sk-test-not-real"` 被拒绝且文件不变。
- [x] 测试：删掉 `[model.agent-studio-default]` 的全文被拒绝。

GitNexus：改 `writeGrokProviderConfig` 前对它做 upstream impact。

---

### Task 2c: 把 grok-home/memory 接到 ~/.grok/memory

**Files:**

- Create: `src/main/runtime/grok/grok-shared-memory.ts`、`grok-shared-memory.test.ts`
- Modify: `writeGrokProviderConfig`（mkdir grok-home 之后调用）
- Modify: `buildGrokRuntimeEnvironment`、`grok-acp-adapter.test.ts`

**Produces:**

```ts
export function getUserGrokMemoryDir(): string
// join(homedir(), '.grok', 'memory') — 测试注入 homedir，禁止测到真实家目录。

export type SharedMemoryLinkResult = 'linked' | 'already-linked' | 'skipped-existing'

/** 只连接记忆目录。不得碰 config.toml / plugins / auth。 */
export async function ensureSharedGrokMemory(input: {
  grokHome: string
  userMemoryDir: string
}): Promise<SharedMemoryLinkResult>
```

规则：

1. `userMemoryDir` 必须是绝对路径，且文件名最后一段是 `memory`，父目录名是 `.grok`。测试里用临时目录模拟 `.../.grok/memory`，不要真写开发者家目录。
2. `mkdir` 用户记忆目录（不存在时），权限尽量 `0700`。
3. `grok-home/memory` 不存在 → 建 **目录级** junction（Windows `fs.symlink(..., 'junction')`）或目录 symlink（posix）。禁止只链单个 `MEMORY.md`。项目子目录随整棵树自动可见。
4. 已是指向同一 `realpath` 的链接 → `already-linked`。
5. 是空目录 → 删空目录再链接。
6. 是非空真实目录，或链接指到别处 → `skipped-existing`，**不得删除**用户已有文件；设置页提示未共享。
7. 跟随链接逃出预期目标则失败，不得改成任意路径。
8. 不写 `~/.grok/config.toml`。TUI 自己的 `[memory] enabled` 与 App toml 各自维护。

Runtime：

```ts
environment.GROK_HOME = grokHome          // 仍是 App 目录
environment.GROK_MEMORY = '1'            // 打开跨会话记忆；--no-memory 本计划不传
```

`GROK_MEMORY` 不从 `process.env` 继承宿主值，由桌面显式设为 `'1'`，避免用户机器上的 `GROK_MEMORY=0` 把桌面关掉。

- [x] 测试：临时 grok-home + 临时 `.grok/memory`，调用后 managed `memory` 的 realpath 等于用户目录。
- [x] 测试：经 managed 路径写入 `MEMORY.md`，用户目录能读到同一文件。
- [x] 测试：经 managed 路径写入 `demo-deadbeef/MEMORY.md`，用户目录 `demo-deadbeef/MEMORY.md` 能读到（项目记忆，不是只有全局）。
- [x] 测试：managed `memory` 里已有非空文件时返回 `skipped-existing` 且文件还在。
- [x] 测试：`buildGrokRuntimeEnvironment` 含 `GROK_MEMORY: '1'`，且不出现宿主 `GROK_MEMORY=0`。
- [x] 测试：`writeGrokProviderConfig` 不修改传入的假 `~/.grok/config.toml`（用临时 homedir 夹具或断言未调用写 config）。

GitNexus：改 `buildGrokRuntimeEnvironment`、`writeGrokProviderConfig` 前做 upstream impact。

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
# 这是 App 专属 config.toml，不会改你家里的 ~/.grok/config.toml。
# 记忆 Markdown 经 junction 与 ~/.grok/memory 整棵树共用（全局 + 项目）。

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

APP_INVOKE_CHANNELS.getGrokConfig = 'app:get-grok-config'
APP_INVOKE_CHANNELS.saveGrokConfig = 'app:save-grok-config'
```

第一波必须收入提示目录的表（中文 `meaning`，键名保持官方英文）：

| table | key | 要点 |
| --- | --- | --- |
| memory | enabled | 跨会话记忆开关；全局和项目文件都与 TUI 共用 `~/.grok/memory`，开关写在 App toml |
| session | auto_compact_threshold_percent | 自动 compact 阈值 |
| session | load_envrc | 是否加载 `.envrc` |
| features | telemetry | 匿名遥测 |
| features | remote_fetch | 是否允许在线拉模型目录 |
| tools | respect_gitignore | 工具是否跳过 gitignore |
| plugins | enabled / disabled | 插件启停名单 |
| mcp_servers | （表级） | 每个子表是一个 MCP；App toml **不要把 Key 写在这里**。用户级与 TUI 的 `~/.grok/config.toml` 同步；用设置 MCP 页改 |
| models | default | Grok 自己的默认模型；工作台模型以供应商页为准 |
| model.agent-studio-default | （表级） | 由供应商页写入，请勿改成明文 Key |
| ui | vim_mode / simple_mode / default_selected_permission | **TUI 专用**；工作台审批仍走 Agent Studio |
| cli | auto_update | 对 `grok agent --no-auto-update` 启动几乎无影响 |

`matchGrokConfigHint`：先精确 `table+key`，再退到表级。

编辑器：等宽、行号可选、不引入新编辑器库。右侧固定提示栏。`parseTomlCursor` 只做轻量扫描当前 `[section]` 和 `key =`，不必完整 AST。

- [x] 测试：光标在 `enabled = true` 且上一表是 `[memory]` → 命中 memory.enabled。
- [x] 测试：光标在未知键 → `match` 为表级或 null，UI 显示「桌面不解释」。
- [x] 测试：get 空文件返回 starter 模板（或磁盘不存在时返回模板且尚未写盘，直到用户保存）。
- [x] 测试：save 非法 toml 返回 `invalid-input` 且带行号/「无法解析」。

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

布局按 Grok 文档，**三层都在共享树上**，禁止把 project 写到别处：

- `memory/MEMORY.md` → global（`~/.grok/memory/MEMORY.md`）
- `memory/<slug>-<hash8>/MEMORY.md` → project（`~/.grok/memory/<slug>-<hash8>/MEMORY.md`）
- `memory/<slug>-<hash8>/sessions/*.md` → session

`<slug>-<hash8>` 由 Grok 根据仓库 `origin` 生成。桌面只扫描已存在的目录，不自造 hash。同一 git remote 的 TUI 会话与 Agent Studio Task 必须共用这一层。

`memoryId` 用相对 posix 路径，例如 `global/MEMORY.md`、`project/foo-deadbeef/MEMORY.md`。主进程映射回真实文件（经 junction 后物理文件在 `~/.grok/memory`）。

沙箱函数必须吃 Task 2c 的共享目标：

```ts
export function isAllowedMemoryCanonical(input: {
  grokHome: string
  userMemoryDir: string
  canonical: string
}): boolean
```

`userMemoryDir` 只允许 `ensureSharedGrokMemory` 算出的那一条。测试里指向临时目录，不要写死开发者 `C:\Users\...`。

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

- [x] 测试：临时 grok-home 放三份文件，list 分组正确。
- [x] 测试：`memoryId` 含 `..` 的 get/save/delete 都被拒绝。
- [x] 测试：symlink 指到 grok-home 外且 **不是** 共享目标 → 跳过或 invalid，save 不得跟上。
- [x] 测试：junction 到临时 `.grok/memory` 时，list/get/save 成功，DTO 不含绝对路径。
- [x] 测试：save 全局 MEMORY.md 后 get 读回相同正文；用户侧临时 memory 目录也能读到。
- [x] 测试：save 项目 `demo-deadbeef/MEMORY.md` 后，共享树里该项目文件更新；delete 该项目 MEMORY.md 失败。
- [x] 测试：delete 全局 MEMORY.md 失败；delete 会话文件成功。
- [x] 测试：list 能分出 global 与至少一个 project 组，且 DTO 无绝对路径。

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
  origin: 'user' | 'project'
  command?: string
  url?: string
  hasSecret: boolean
  lastError?: string
}
```

存储分两层：

1. `userData/config/mcp-servers.json`：完整记录 + Secret 密文（`safeStorage`）。Linux `basic_text` 时本会话可用、不得持久化 Secret。
2. 同步 `GrokHomeConfigController.apply({ mcpServers })`：toml 里只有非 Secret 字段，供 Grok 自己读配置。

upsert/delete 必须 App json、App toml、用户 `[mcp_servers.*]` 一起成功或一起失败（推荐：先 merge App toml（无 Secret）→ 写 json（含密文）→ merge 用户 toml 的该表；任一步失败返回错误且用户其它表仍在）。

- [x] 测试：假 Key `sk-test-not-real` 加密后 list 只有 `hasSecret: true`。
- [x] 测试：改 URL origin 后 hasSecret 变 false，旧密文删掉。
- [x] 测试：相对路径 command 拒绝。

---

### Task 5b: 与 ~/.grok/config.toml 的 [mcp_servers] 双向同步

**Files:**

- Create: `src/main/mcp/grok-user-mcp-sync.ts`、`grok-user-mcp-sync.test.ts`
- Modify: `mcp-server-store.ts`、`index.ts`（启动与 upsert/delete 时调用）

**Produces:**

```ts
export type McpServerOrigin = 'user' | 'project'

export function parseUserMcpServerTables(tomlText: string): ParsedUserMcpServer[]
export function mergeUserMcpServerTable(existingToml: string, server: ParsedUserMcpServer): string
export function removeUserMcpServerTable(existingToml: string, name: string): string

export async function syncUserMcpFromHome(input: {
  userConfigPath: string
  store: McpServerStore
}): Promise<void>
```

规则：

1. 默认 `userConfigPath = join(homedir(), '.grok', 'config.toml')`。测试注入临时文件，禁止测到开发者家目录。
2. 只认表名 `mcp_servers.<id>`。其它表原样保留（含注释，尽力而为）。
3. 启动：用户文件不存在 → 当作没有用户级 MCP，不创建该文件。
4. 启动：把解析到的服务器 upsert 进 store；用户 toml 里的 `env`/`headers` 进 safeStorage，不写进 App toml。
5. 桌面 upsert：除写 App 外，把该 name 的表 merge 进用户 toml（stdio 的 `command`/`args`/`enabled`，以及解密后的 env——**仅用户文件**）。若用户文件仍不存在，**只创建包含 `[mcp_servers.name]` 的最小文件**，不要塞 App 的模型块。
6. 桌面 delete：从用户 toml 删除该表，其它表不动。
7. 同名冲突：设置页后写为准；启动导入时若 App 已有同名，不覆盖 App Secret，只补缺失项（测试锁这个策略）。
8. 项目 `.grok/config.toml`：另函数只读扫描 `join(workspace, '.grok', 'config.toml')`，realpath 必须在该项目根内。失败则不当作用户级。

- [x] 测试：用户 toml 有 `[mcp_servers.github]` + `env.API_KEY=sk-test-not-real`，sync 后 list 有 github、`hasSecret: true`，App toml 不含 `sk-test`。
- [x] 测试：upsert 后用户临时 toml 出现 `[mcp_servers.docs]`，且原有 `[ui] vim_mode` 仍在。
- [x] 测试：delete 后用户 toml 不再有该表，`[models]` 仍在。
- [x] 测试：用户 toml 损坏时 sync 失败、store 不变。
- [x] 测试：项目 toml 在 workspace 外的 symlink → 跳过。

GitNexus：改 store upsert/delete 前做 impact。

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

`upsert` 请求字段白名单。更新已有 server 时，空 Secret 表示保持原密文。删除后不得残留密文，并同步去掉用户 toml 的该表。

`list` 带 `origin: 'user' | 'project'`。项目项没有 upsert/delete。

已启用的 MCP 在**下一次** session/new 或 resume 生效。UI 写一句：「与终端 Grok 共用用户级服务器。当前对话不会热重载，新 Task 或重新进入后由 Grok 连接。」不要假装已经连上。App 侧原文在「Grok 配置」页（无 Key）；TUI 原文仍在 `~/.grok/config.toml`，不要让用户去 Finder 翻，除非只读提示。

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

- [x] 测试：enable 后 toml 含该 id；disable 后进入 disabled 列表。
- [x] 测试：非法 pluginId（含 `/` `..`）拒绝。

---

### Task 9: 命令板产品别名

**Files:**

- Modify: `src/renderer/src/slash-command-palette.ts`、测试、`App.vue`

P0-10C 的 `productAction` 扩展：

```ts
productAction?: 'open-plugins' | 'open-settings' | 'open-settings-memory' | 'open-settings-mcp' | 'open-settings-grok-config'
```

`/memory`、`/mcps`（及 `/mcp`）、`/config` 打开设置对应栏目。与 Grok 广告同名时产品别名优先。`/config` 进「Grok 配置」编辑器，不是外观页。

- [x] 测试：`/mem` 匹配 memory 别名且 kind 为 product。

---

### Task 10: 验证

- [x] 目标文件 ESLint、`pnpm typecheck`、`pnpm build`、`git diff --check`；本计划相关 `vitest` 已过。全量 `pnpm test` 在 Windows 上仍有既有 symlink/fsync 失败，非本计划引入。开发版 GUI 见下。
- [x] 确认 `grok-acp-adapter.test.ts` 不再写死三处 `mcpServers: []` 为唯一合法值；无配置时为空，有配置时注入。
- [ ] 开发版手工：开记忆开关后 App toml 出现 `[memory]`。`grok-home/memory` 是指向 `~/.grok/memory` 的 junction。设置里改 **全局** 一条、再改 **当前项目** 一条，TUI `/memory` 两边都能看见（或反过来）。Grok 配置页改注释/字段能保存，光标有中文提示；写入 `api_key` 被拒绝。加一个假 MCP 后：App toml 有 server 且无 Key；`~/.grok/config.toml` **仅** `[mcp_servers.*]` 增加对应表，`[ui]`/`[models]` 仍在。TUI `grok mcp list` 能看到该项。不跑真实付费 MCP。
- [ ] 开发版：保存供应商 / 开记忆开关 **不**改用户 toml 除已有记忆目录外的内容；只有 MCP upsert/delete 允许动 `[mcp_servers.*]`。
- [x] 不得用真 API Key。测试 Key 必须明显是假的。

## 验收标准

- [ ] 设置有记忆、MCP、Grok 配置三栏；检查器标签不变。
- [ ] 记忆可看、可改、可保存；逻辑根是 App `grok-home/memory`，物理文件与 TUI 共用整棵 `~/.grok/memory`（全局 + 项目 `<slug>-<hash8>` + 会话）。
- [ ] 同一 Local Project 在桌面记下的项目记忆，TUI 打开同一仓库能读到；禁止桌面另写一套项目目录。
- [ ] 不把 `GROK_HOME` 改成 `~/.grok`。不整文件覆盖 `~/.grok/config.toml`；只允许合并/删除 `[mcp_servers.*]`。
- [ ] 表单会自动合并 toml；同时可以在「Grok 配置」里改原文并看到字段说明。
- [ ] 含明文 Key 的 toml 不能保存；用户注释在 `writeText` 路径下保留。
- [ ] 表单合并与编辑器写的是同一份 **App** `config.toml`。用户家里的 toml 只通过 MCP 同步碰 `[mcp_servers.*]`。
- [ ] **App** `config.toml` 无 API Key / MCP Secret（编辑器拒绝，表单不写入）。用户 toml 为兼容 TUI，允许 `[mcp_servers]` 内的 env，且不得出现在 Renderer。
- [ ] TUI 已有的用户级 MCP 出现在桌面列表；桌面新增的用户级 MCP 出现在 TUI `grok mcp list`。项目 MCP 只读，来自仓库 `.grok/config.toml`。
- [ ] 重写模型配置后 `[memory] enabled` 与 `[mcp_servers]` 仍在。
- [ ] 启用的 MCP 出现在下一次 `session/new` 的 `mcpServers`；Secret 不进 Renderer。
- [ ] Agent Studio 不自己 spawn MCP。
- [ ] `/memory` `/mcps` `/config` 打开对应设置页，不向 Grok 误发导航命令。
- [ ] P3-04 仍未开工；本计划不是 Capability Pack。

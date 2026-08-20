# P0-10C Grok 宿主工作台表面 实施计划

> **状态：** 待开始（2026-08-20 产品确认：桌面是 Grok Build 的 ACP Client，不自己当大脑；先写计划，不开工）
>
> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务落地。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **插入点：** [P0-10B](p0-10b-settings-dialog-and-appearance.md) 之后、P0-11 之前；与收口中的 [P0-10](p0-10-single-runtime-task-workbench.md) / [GACP-02](grokACP计划/gacp-02-session-restore-capability-contract.md) 并行，不挡它们的手工走查。记忆浏览与 MCP 注入见 [P0-10D](p0-10d-grok-memory-and-mcp.md)。

**优先级：** P0-A / 权重 4（把 Grok 已有能力摊开，而不是新做一套 Agent）

**目标：** 工作台成为 Grok Build 的可视化宿主：输入框 `/` 列出 Grok 广告的斜杠命令；侧栏「插件」打开独立整页且**不停止**正在跑的 Task；检查器不塞记忆/MCP。

**Architecture：** Agent Studio 只做 ACP Client 与产品导航。斜杠命令来自 `available_commands_update`，作为 **session 级快照** 推给 Renderer，**不进 Timeline**。插件页读取 App 专属 `GROK_HOME` 里 Grok 已加载的插件。`primaryView` 与 `selectedTaskId` / `activeExecution` 三套状态独立：换页只换主列，不 `cancel`、不 `disconnect`、不清选中 Task。

**Tech Stack：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest、`@agentclientprotocol/sdk` 1.3.x。不新增 UI 框架。

**Spec：** 2026-08-20 会话确认。产品分层：Grok 思考/工具/记忆/Skills/MCP/插件；桌面只展示、配置、审批。插件导航学 Codex「侧栏点插件 → 主列整页」，不抄货架市场。

## Global Constraints

- Node `>=20`，本机验证优先 22/24；pnpm 10。
- 新增 IPC 使用 `agent:*` / `app:*`，不得新增 `grok:*`。
- `clientCapabilities` 保持 `{}`；本计划不实现 fs/terminal，不自己 Host MCP。
- 不修改用户 `~/.grok`；只读 App `userData/grok-home`。
- Renderer 不读磁盘、不碰 `ipcRenderer`、不看到 `runtimeSessionId`。
- 执行中切到插件页不得取消 Turn、不得断开 Runtime、不得清空 `selectedTaskId`。
- 中文注释写原因和边界；协议字段保持英文。
- 斜杠命令板 **禁止手写一份假的 Grok 菜单**；Grok 没广告就显示等待/空。

---

## 非目标

- 不自己实现 `/compact`、`/dream`、记忆引擎、MCP 运行时。
- 不接 Grok Marketplace / Featured 货架、Chrome、Computer Use 商店。
- 不把记忆、MCP 放进检查器（那两块属于 P0-10D 设置页）。
- 不搬 TUI 壳：`/vim-mode`、`/theme`、`/dashboard`、`/doctor`、`/minimal`。
- 不接 `/always-approve` 静默 yolo（权限仍走 Broker；GACP-03 另做少打断）。
- 不在本计划合并写入 `config.toml`（P0-10D 的 `GrokHomeConfigController` 统一自动写）。
- 不安装/卸载插件、不加市场源；第一波列出已安装。启停开关在 P0-10D Task 8 接上。
- 不为 Codex 预留第二套插件页。

## 数据流

```text
Grok session/update available_commands_update
  → GrokAcpAdapter 写入当前 session 命令快照（无 activeTurn 也要收）
  → sink.onAvailableCommands(snapshot)
  → AgentService 推送 agent:available-commands
  → Preload 白名单解析
  → 输入框 / 命令板 = Grok 广告 ∪ 产品别名

侧栏「插件」
  → primaryView = 'plugins'（selectedTaskId / activeExecution 不动）
  → 主列 PluginsPage
  → window.app.listPlugins()
  → 主进程只扫描 userData/grok-home 下已安装插件目录
  → 脱敏摘要（id、名称、启用、Skill/MCP/Hooks 计数）

产品别名 /plugins
  → 只切换 primaryView，不 startTurn
Grok 命令 /compact …
  → 现有 agent.startTurn(selectedTaskId, "/compact …")
```

无 `activeTurn` 时：`tool_call` 等仍丢弃（保持现状）；**仅** `available_commands_update` 更新 session 快照。切 session / disconnect 时清空快照。

## 安全边界

- 命令快照只含 `name` / `description` / 可选 `inputHint`；丢弃 `_meta`、未知字段。
- `name` 必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$`，条数上限 200，单字段 4 KiB。
- 发给 Grok 的文本仍走现有 `startTurn` 限长；桌面不得另开「执行命令」IPC。
- 插件扫描：`realpath` 必须落在 `getManagedGrokHome(userDataPath)` 内；跟随 symlink 逃逸则整项 `invalid`。
- 插件摘要不返回绝对路径、清单原文、hooks 命令、MCP env。
- 插件页不能指定可执行文件或安装 URL。

## 文件范围

**创建：**

- `src/shared/agent-available-command.ts`、`src/shared/agent-available-command.test.ts`
- `src/shared/runtime-plugin.ts`、`src/shared/runtime-plugin.test.ts`
- `src/renderer/src/workbench-primary-view.ts`、`workbench-primary-view.test.ts`
- `src/renderer/src/slash-command-palette.ts`、`slash-command-palette.test.ts`
- `src/renderer/src/components/SlashCommandPalette.vue`
- `src/renderer/src/components/PluginsPage.vue`
- `src/renderer/src/components/ExecutionSurfaceBanner.vue`
- `src/main/runtime/grok/grok-plugin-inventory.ts`、`grok-plugin-inventory.test.ts`

**修改：**

- `src/shared/agent-ipc.ts`、`src/shared/app-ipc.ts`、`src/shared/agent-ipc.test.ts`
- `src/main/runtime/grok/grok-acp-mappers.ts`、`grok-acp-mappers.test.ts`、`grok-acp-adapter.ts`、`grok-acp-adapter.test.ts`、`grok-acp-observation.test.ts`
- `src/main/agent/agent-runtime-adapter.ts`、`agent-service.ts`、`agent-service.test.ts`
- `src/main/app-ipc.ts`、`app-ipc.test.ts`、`src/main/index.ts`
- `src/preload/desktop-api.ts`、`desktop-api.test.ts`、`index.d.ts`
- `src/renderer/src/composables/useTaskWorkbench.ts`、`useTaskWorkbench.test.ts`
- `src/renderer/src/components/ProjectSidebar.vue`、`TaskComposer.vue`、`App.vue`
- `src/renderer/src/workbench-keyboard.ts`、`workbench-keyboard.test.ts`
- `docs/superpowers/plans/roadmap-index.md`、`grokACP计划/README.md`、`AGENTS.md`、`CLAUDE.md`

## 已锁定 UI

```text
侧栏                              主列
─────────────────────            ─────────────────────
 [新建项目]  ⚙设置
 插件          ← 点这里          插件整页
                                 已安装 / 搜索
 项目                            点开一个：Skill / MCP / Hooks 摘要
   agent-studio                  （无输入框）
     ● 正在跑的任务  ← 徽标仍在
```

- `primaryView`: `'conversation' | 'plugins'`。默认 `conversation`。
- 点「插件」：主列换成 `PluginsPage`，对话/输入框卸下（不销毁 workbench 状态）。
- 点任务或「新对话」：`primaryView` 回到 `conversation`。新对话仍 `createTask`，与现网一致。
- 插件页无 Composer。进行中或待审批时，主列顶显示 `ExecutionSurfaceBanner`，点「返回对话」只改 `primaryView`。
- 命令板：输入框值为 `/` 或 `/xxx` 时在输入框上方打开；Esc 关闭；选产品别名不发送；选 Grok 命令后 `startTurn`。
- 检查器标签仍是 Timeline / Changes / Terminal / Artifacts。

### 斜杠命令落点（本计划实现范围打勾）

| 命令 | 落点 | P0-10C |
| --- | --- | --- |
| Grok 广告的任意 `/name`（含 Skill） | 命令板 → `startTurn("/name …")` | 是 |
| `/plugins` | 产品别名 → `primaryView='plugins'` | 是 |
| `/compact` `/plan` `/effort` `/remember` `/flush` `/dream` | 若 Grok 广告了就走命令板 | 是（不手写） |
| `/new` `/rename` `/delete` `/model` `/settings` | 已有 UI，命令板可做别名 | `/settings` 打开现有设置弹窗；其余可第二波 |
| `/memory` `/mcps` | 打开设置对应栏目 | **否，P0-10D** |
| `/context` 占用数字 | Composer 左下已有 `contextUsage` 槽 | 有 `usage_update` 就显示（已有） |
| `/fork` `/rewind` `/loop` `/goal` `/imagine` `/marketplace` | 以后 / 不接 | 否 |
| TUI 壳 `/vim-mode` `/theme` `/doctor` `/dashboard` | 不接 | 否 |

---

### Task 1: 主列视图与执行条契约

**Files:**

- Create: `src/renderer/src/workbench-primary-view.ts`
- Test: `src/renderer/src/workbench-primary-view.test.ts`

**Produces:**

```ts
export const WORKBENCH_PRIMARY_VIEWS = ['conversation', 'plugins'] as const
export type WorkbenchPrimaryView = (typeof WORKBENCH_PRIMARY_VIEWS)[number]

export function isWorkbenchPrimaryView(value: unknown): value is WorkbenchPrimaryView
export function resolveWorkbenchPrimaryView(value: unknown): WorkbenchPrimaryView
// 未知值一律 conversation，避免主列空白。

export type ExecutionSurfaceBannerKind = 'none' | 'running' | 'waiting-permission'

/** 插件页也要能看见后台 Task；返回对话不得携带 cancel。 */
export function resolveExecutionSurfaceBanner(input: {
  primaryView: WorkbenchPrimaryView
  activeExecution: { taskId: string; state: string } | null
}): { kind: ExecutionSurfaceBannerKind; taskId: string } | { kind: 'none' }

/** 切到插件页时必须保持选中与运行身份。 */
export function applyOpenPlugins(input: {
  selectedTaskId: string
  activeExecutionTaskId: string | null
}): { primaryView: 'plugins'; selectedTaskId: string; cancelTurn: false }
```

- [ ] **Step 1: 写失败测试**

```ts
it('打开插件页不取消、不清 selectedTaskId', () => {
  expect(
    applyOpenPlugins({ selectedTaskId: 'task-a', activeExecutionTaskId: 'task-a' })
  ).toEqual({ primaryView: 'plugins', selectedTaskId: 'task-a', cancelTurn: false })
})

it('插件页且等待审批时显示 waiting-permission 条', () => {
  expect(
    resolveExecutionSurfaceBanner({
      primaryView: 'plugins',
      activeExecution: { taskId: 'task-a', state: 'waiting-permission' }
    })
  ).toEqual({ kind: 'waiting-permission', taskId: 'task-a' })
})

it('对话页不显示执行条', () => {
  expect(
    resolveExecutionSurfaceBanner({
      primaryView: 'conversation',
      activeExecution: { taskId: 'task-a', state: 'running' }
    })
  ).toEqual({ kind: 'none' })
})
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小实现**
- [ ] **Step 4: 测试通过**

---

### Task 2: 可用命令快照契约

**Files:**

- Create: `src/shared/agent-available-command.ts`
- Test: `src/shared/agent-available-command.test.ts`

**Produces:**

```ts
export interface AgentAvailableCommand {
  name: string
  description: string
  inputHint?: string
}

export interface AgentAvailableCommandSnapshot {
  taskId: string
  revision: number
  commands: AgentAvailableCommand[]
}

export const MAX_AVAILABLE_COMMANDS = 200
export const AVAILABLE_COMMAND_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$/

export function parseAvailableCommandSnapshot(
  value: unknown
): AgentAvailableCommandSnapshot | null
```

非法 name、超长、`_meta`、缺 description 的项跳过；全非法则 `commands: []` 仍是合法快照（表示「已同步但为空」）。`parse` 失败（缺 taskId）返回 `null`，Preload 丢弃。

- [ ] 测试：正常列表、混入 `_meta` 被丢、非法 name 被跳过、超过 200 截断、非对象返回 null。

---

### Task 3: Mapper 投影 available_commands_update

**Files:**

- Modify: `src/main/runtime/grok/grok-acp-mappers.ts`、`grok-acp-mappers.test.ts`、`grok-acp-observation.test.ts`

**Produces:**

```ts
export function mapGrokAvailableCommands(
  update: acp.AvailableCommandsUpdate,
  redactText: (text: string) => string
): AgentAvailableCommand[]
```

`mapGrokSessionUpdate` **继续**对 `available_commands_update` 返回 `[]`（不进 Timeline）。观察测试保持「不进入产品事件」；另加测试断言 `mapGrokAvailableCommands` 只留下 name/description/input.hint。

GitNexus：改 `mapGrokSessionUpdate` 前对它做 upstream impact。本任务不得把命令写进 `AgentEvent`。

---

### Task 4: Adapter 在无 Turn 时也收下命令快照

**Files:**

- Modify: `src/main/agent/agent-runtime-adapter.ts`
- Modify: `src/main/runtime/grok/grok-acp-adapter.ts`、`grok-acp-adapter.test.ts`
- Modify: `src/main/agent/agent-service.ts`、`agent-service.test.ts`

**Produces:** `AgentRuntimeAdapterSink` 增加：

```ts
onAvailableCommands: (snapshot: AgentAvailableCommandSnapshot) => void
```

现有测试夹具必须补这个回调，避免编译失败。

`handleSessionUpdate` 调整：

1. 连接代际 / `sessionId` 不匹配 → 仍直接 return。
2. `sessionUpdate === 'available_commands_update'` → 用当前绑定 Task 的 `taskId` 组快照并 `sink.onAvailableCommands`；**不要求** `activeTurn`。
3. 其它 update 无 `activeTurn` → 仍 return（现状）。
4. `disconnect` / 换 session → `onAvailableCommands({ taskId, revision: next, commands: [] })`。

`taskId` 取 Adapter 当前激活的产品 Task；没有绑定 Task 时不推送。

- [ ] 测试：session/new 后、startTurn 前收到命令列表 → sink 被调用。
- [ ] 测试：无 activeTurn 的 `agent_message_chunk` 仍被忽略。
- [ ] 测试：disconnect 后快照 commands 为空。

---

### Task 5: 命令快照 IPC

**Files:**

- Modify: `src/shared/agent-ipc.ts`、`src/shared/agent-ipc.test.ts`
- Modify: 主进程 Agent IPC 注册处（与 `agent:event` 并列）、对应测试
- Modify: `src/preload/desktop-api.ts`、`desktop-api.test.ts`、`index.d.ts`

**Produces:**

```ts
AGENT_INVOKE_CHANNELS.getAvailableCommands = 'agent:get-available-commands'
AGENT_PUSH_CHANNELS.availableCommands = 'agent:available-commands'
```

```ts
getAvailableCommands: (taskId: string) => Promise<DesktopIpcResult<AgentAvailableCommandSnapshot>>
onAvailableCommands: (listener: (snapshot: AgentAvailableCommandSnapshot) => void) => () => void
```

`getAvailableCommands` 只接受已存在的 `taskId`；未知 Task → `invalid-input`。Push 经 `parseAvailableCommandSnapshot`，失败不回调。静态 channel 测试数组必须同步追加这两项，且仍不含 `grok:*`。

---

### Task 6: 插件摘要契约与 GROK_HOME 扫描

**Files:**

- Create: `src/shared/runtime-plugin.ts`、`src/shared/runtime-plugin.test.ts`
- Create: `src/main/runtime/grok/grok-plugin-inventory.ts`、`grok-plugin-inventory.test.ts`

**Produces:**

```ts
export type RuntimePluginScope = 'user' | 'project' | 'path'
export type RuntimePluginStatus = 'enabled' | 'disabled' | 'invalid'

export interface RuntimePluginSummary {
  pluginId: string
  displayName: string
  status: RuntimePluginStatus
  skillCount: number
  mcpCount: number
  hookCount: number
  version?: string
}

export interface RuntimePluginDetail extends RuntimePluginSummary {
  skillNames: string[]
  mcpNames: string[]
  hookNames: string[]
  invalidReason?: string
}
```

扫描根：`join(getManagedGrokHome(userDataPath), 'plugins')`。目录不存在 → 空列表，不是错误。单层子目录；有 `plugin.json` 则读 displayName/version；否则用目录名。Skill/MCP/Hooks 只 **计数和名称**：`skills/*/SKILL.md`、`.mcp.json` 的 server 名、`hooks/hooks.json` 的 hook 名。读文件失败 → 该项 `invalid`，不让扫描中断。

名称限 80 项、每名 128 字符。测试用临时目录，断言逃出 grok-home 的 symlink 被标 invalid。

---

### Task 7: 插件 IPC

**Files:**

- Modify: `src/shared/app-ipc.ts`、`src/shared/agent-ipc.test.ts`
- Modify: `src/main/app-ipc.ts`、`app-ipc.test.ts`、`src/main/index.ts`
- Modify: `src/preload/desktop-api.ts`、`desktop-api.test.ts`、`index.d.ts`

**Produces:**

```ts
APP_INVOKE_CHANNELS.listPlugins = 'app:list-plugins'
APP_INVOKE_CHANNELS.getPlugin = 'app:get-plugin'
```

请求：`listPlugins()` 无参；`getPlugin({ pluginId })`。主进程重校验 `pluginId`（非空、无 NUL、≤4KiB、无路径分隔符）。详情不存在 → `not-found`。不把绝对路径回给 Renderer。

---

### Task 8: 工作台状态接上 primaryView

**Files:**

- Modify: `src/renderer/src/composables/useTaskWorkbench.ts`、`useTaskWorkbench.test.ts`
- Modify: `src/renderer/src/components/ProjectSidebar.vue`
- Create: `src/renderer/src/components/PluginsPage.vue`
- Create: `src/renderer/src/components/ExecutionSurfaceBanner.vue`
- Modify: `src/renderer/src/App.vue`

**Produces:** `TaskWorkbenchState` 增加：

```ts
primaryView: Ref<WorkbenchPrimaryView>
openPlugins(): void
returnToConversation(): void
```

`openPlugins` / `returnToConversation` **不得**调用 `cancelTurn`、`disconnect`、`selectTask('')`。

`selectTask` / `createTask`（新对话）把 `primaryView` 设回 `conversation`。

侧栏在项目树 **上方** 增加「插件」按钮（`aria-current` 在 `primaryView==='plugins'` 时为 `page`）。运行点仍画在任务行上。

`App.vue`：`primaryView==='plugins'` 时主列渲染 `PluginsPage` + 条件 `ExecutionSurfaceBanner`，不渲染 `TaskConversation` / `TaskComposer`。Banner「返回对话」调用 `returnToConversation`。

`PluginsPage`：加载 `window.app.listPlugins()`；空状态文案「还没有已安装的插件。插件由 Grok Build 加载，本页只展示已安装项。」点一项再 `getPlugin`。搜索只过滤已加载列表。启停开关先做成禁用占位（title：将在设置写入 Grok 配置后可用），P0-10D 再接到 `setPluginEnabled`。

- [ ] workbench 测试：运行中 `openPlugins()` 后 `activeExecution` 仍在、`selectedTaskId` 不变。
- [ ] workbench 测试：`selectTask` 后 `primaryView` 回到 conversation。

---

### Task 9: 斜杠命令板

**Files:**

- Create: `src/renderer/src/slash-command-palette.ts`、`slash-command-palette.test.ts`
- Create: `src/renderer/src/components/SlashCommandPalette.vue`
- Modify: `src/renderer/src/components/TaskComposer.vue`
- Modify: `App.vue`（订阅 `onAvailableCommands`，按 selectedTaskId 丢弃过期快照）

**Produces:**

```ts
export type SlashCommandSource = 'runtime' | 'product'

export interface SlashCommandItem {
  id: string
  name: string
  description: string
  inputHint?: string
  source: SlashCommandSource
  // product 只允许导航，不得 startTurn。
  productAction?: 'open-plugins' | 'open-settings'
}

export function isSlashComposerDraft(prompt: string): boolean
export function slashQuery(prompt: string): string
export function mergeSlashCommands(input: {
  runtime: AgentAvailableCommand[]
  product: SlashCommandItem[]
}): SlashCommandItem[]
export function filterSlashCommands(items: SlashCommandItem[], query: string): SlashCommandItem[]
export function resolveSlashSubmit(item: SlashCommandItem, prompt: string): 
  | { kind: 'product'; action: NonNullable<SlashCommandItem['productAction']> }
  | { kind: 'runtime'; prompt: string }
```

P0-10C 产品别名固定两项：`plugins`（打开插件页）、`settings`（打开现有设置弹窗）。同名时 **产品别名优先**（桌面导航不能被 Grok 的 `/plugins` 抢走去发 prompt）。

`resolveSlashSubmit` 对 runtime：把输入框原文（已是 `/name …`）作为 `startTurn` 的 prompt，不再包一层。

Composer：`isSlashComposerDraft` 为真时展示面板；无 runtime 命令且 query 为空时显示「等待 Grok 提供命令」。执行中且发送被挡住时，面板仍可打开产品别名。

- [ ] 测试：`/plug` 匹配 plugins；选 plugins 不产生 runtime prompt。
- [ ] 测试：runtime `compact` + 用户输入 `/compact keep auth` → `{ kind: 'runtime', prompt: '/compact keep auth' }`。
- [ ] 测试：非法/空 runtime 列表时产品别名仍在。

---

### Task 10: Esc 与验证

**Files:**

- Modify: `src/renderer/src/workbench-keyboard.ts`、对应测试
- 文档：`roadmap-index.md`、`grokACP计划/README.md` 本计划状态

命令板打开时 Esc 先关面板，不停止 Task、不关检查器。`overlayConsumesEscape` 增加 `.slash-command-palette`。

- [ ] 目标文件 ESLint、`pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`
- [ ] 开发版手工（不替代自动门）：Task 运行中点「插件」→ 任务徽标仍在、Grok 继续；返回对话时间线续上；`/` 能看到 Grok 广告项（若本机会话有广告）。
- [ ] 受控 ACP e2e **本计划不强制重跑**；若改 Adapter sessionUpdate 分支，补一条 fixture：无 Turn 下发 `available_commands_update` 不崩。

## 验收标准

- [ ] 打开插件页不调用 cancel/disconnect，`selectedTaskId` 不变。
- [ ] 插件页等待审批时有返回对话入口；点返回不丢审批卡。
- [ ] 命令板只展示解析后的 Grok 广告 + 产品别名 `plugins` / `settings`。
- [ ] `available_commands_update` 不出现在 Timeline / `task:list-events`。
- [ ] 插件列表为空是合法状态，不是错误；路径逃逸项不可用。
- [ ] 无 `grok:*` IPC，无明文密钥，无 `~/.grok` 读写。
- [ ] 检查器标签集合不变。

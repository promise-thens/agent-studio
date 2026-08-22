# P0-10E Grok 插件安装与信任 实施计划

> **状态：** 代码已落地（2026-08-21）。自动验证已过。跟进：① already configured 时按源 name 刷新 cache；② 安装超时从 120s 改为 15 分钟，因本机 GitHub clone 约 20–45 KiB/s 时 120s 会杀掉半截 `chrome-devtools-mcp` 仓库。开发版 GUI / 完整安装走查未跑。
>
> **致执行者：** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务落地。步骤使用复选框 (`- [ ]`) 跟踪。
>
> **插入点：** [P0-10D](p0-10d-grok-memory-and-mcp.md) 之后、P0-11 之前。必须等 10D 把 `writeGrokProviderConfig` 改成合并写入，否则保存供应商会整文件覆盖 `[marketplace]` / `[plugins]`。库存扫描修正已作为 P0-10C 跟进合入，不挡本计划开工。

**优先级：** P0-A / 权重 4（让用户在桌面完成 Grok 已经会做的安装/信任，桌面不自己当插件市场）

**目标：** 插件页分「已安装 / 市场」两栏。市场列出 App `GROK_HOME` 里已配置源的可装项；点安装必须先确认信任；安装由 **Grok CLI** 写入 App `grok-home`，桌面只编排、确认、展示。不读、不写用户 `~/.grok`。

**Architecture：** Agent Studio 仍是 ACP Client。安装路径是 spawn `grok plugin`，`GROK_HOME` 指向 `userData/grok-home`，`--leader-socket` 必须落在该 grok-home 内，禁止打到 `~/.grok/leader.sock`。货架只读 `grok-home/marketplace-cache`。已装列表继续走 P0-10C 库存扫描（`plugins/` + `installed-plugins/registry.json`）。信任不是静默 yolo：没有勾选「信任并启用 Hooks/MCP」就不得带 `--trust`。

**Tech Stack：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest。不新增 UI 框架。安装执行器是本机已解析的 `grok` 二进制，与 Adapter 同源。

**Spec：** 2026-08-20 真机观察。用户 TUI Marketplace 高亮的 xAI Official（19 项）是货架；`grok plugin list` 当时为 `[]`。为验证桌面列表，已在 **App grok-home** 执行：

```text
GROK_HOME=%APPDATA%\agent-studio\grok-home
grok plugin --leader-socket <grok-home>/studio-plugin.sock marketplace add https://github.com/xai-org/plugin-marketplace.git
grok plugin --leader-socket <grok-home>/studio-plugin.sock install chrome-devtools --trust
```

结果（必须写进实现，不得再猜 `plugins/`）：

- 已装名：`chrome-devtools-mcp`（市场条目名是 `chrome-devtools`）
- 目录：`grok-home/installed-plugins/chrome-devtools-mcp-<hash>/`
- 注册表：`grok-home/installed-plugins/registry.json`（含绝对 `path`，禁止回 Renderer）
- 清单：`.claude-plugin/plugin.json`（无根 `plugin.json`，MCP 写在清单的 `mcpServers`）
- `config.toml` 增加 `[[marketplace.sources]]` 与 `[plugins] enabled = ["chrome-devtools-mcp"]`
- 用户 `~/.grok/config.toml` SHA256 安装前后不变

官方市场里和 Google 对得上的条目是 **chrome-devtools**（Chrome DevTools MCP），没有名为 `google` 的插件。

## Global Constraints

- Node `>=20`，本机验证优先 22/24；pnpm 10。
- IPC 用 `app:*`，不得新增 `grok:*`。
- 不修改用户 `~/.grok`；只动 App `userData/grok-home`。
- Renderer 不读磁盘、不碰 `ipcRenderer`、看不到绝对路径、git SHA、hooks 命令、MCP env。
- `clientCapabilities` 保持 `{}`；桌面不 Host MCP，不拉起 Chrome。
- 主进程必须重校验 pluginId / marketplace URL；安装源第一波只允许「当前货架已列出的 name」。
- `--trust` 只能在用户明确确认后附加。
- 中文注释写原因和边界；协议字段、CLI 子命令、清单文件名保持英文。
- 执行中安装不得 `cancelTurn` / `disconnect`；Hooks/MCP 下一 session 再生效（与 P0-10D MCP 相同）。

---

## 非目标

- 不把桌面做成 Grok Marketplace Host，不接 Featured / Chrome Web Store / Computer Use 商店。
- 不实现 Grok 的 git clone / pin SHA 逻辑；必须走 `grok plugin install|uninstall|marketplace`。
- 不从用户 `~/.grok/marketplace-cache` 或 `~/.grok/plugins` 抄一份过来。
- 不在本计划做记忆、MCP 设置表单（那是 P0-10D）。
- 不把 `/always-approve` 绑到信任插件。
- 不替插件跑 `npm install` / 不预热 `npx chrome-devtools-mcp`。
- 不为 Codex 做第二套插件安装。

## 数据流

```text
打开插件页
  → 已安装：window.app.listPlugins()
      → listGrokPlugins(userData) 扫描 plugins/ + installed-plugins/registry.json
  → 市场：window.app.listMarketplacePlugins()
      → 只读 grok-home/marketplace-cache/<id>/.grok-plugin/marketplace.json
      → 无源或无 cache → 空货架，可「添加官方市场」

点安装 chrome-devtools（示例）
  → 确认框：名称、来源展示名、将启用 Skills；勾选「信任 Hooks/MCP」才继续
  → app:install-plugin { name, trust: true }
      → 主进程校验 name 落在当前货架
      → spawn grok plugin --leader-socket <grok-home>/studio-plugin.sock install <name> [--trust]
      → env.GROK_HOME = managed grok-home；不得把 leader 指到 ~/.grok
      → 成功后重扫库存；失败脱敏短句
      → 文案：当前对话不会热加载插件，新 Task 或重新进入后由 Grok 加载

点卸载
  → 确认 → grok plugin uninstall <name> --confirm
  → 不得 --keep-data 作为默认（避免残留 MCP 状态目录说不清）

添加市场源
  → 只允许 https git URL，无 userinfo，query/hash 不得像 Secret
  → grok plugin marketplace add <url>
  → 若 CLI 报 `Marketplace source already configured`：主进程解析 `marketplace list --json`，
    用源 **name** 跑 `grok plugin marketplace update <name>` 补 `marketplace-cache`。
    Grok 的 update 按 name 查找，把 git URL 传进去会 `not found`；list 失败则 `marketplace update` 刷新全部源。
    不得把 list JSON 里的 url/path 回给 Renderer。
```

无 `activeTurn` 时仍允许安装：改的是 grok-home 文件，不是当前 Turn。正在跑的 Task 继续用旧 session 的插件集。

## 安全边界

- plugin name：沿用 `isRuntimePluginId`；额外建议 `^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,63}$`，与命令名同级。
- 第一波 **禁止** Renderer 传入任意 git URL 当安装源。只能传货架里出现过的 `name`。加源是单独 IPC。
- marketplace git URL：https only，无 userinfo，禁止内嵌凭据。
- `registry.json` / CLI JSON 里的 `path` 绝对路径不得出现在 DesktopIpcResult。
- spawn 环境不得把 `AGENT_STUDIO_MODEL_API_KEY` 泄漏进 argv 或错误字符串。
- CLI stderr 经统一脱敏后再回 Renderer。
- symlink 逃出 grok-home 的安装结果标 invalid，与 P0-10C 相同。
- 信任确认文案必须写明：信任后该插件的 Hooks、MCP、LSP 以用户权限运行。
- 未勾选信任：调用 **不带** `--trust` 的 `grok plugin install`。若 Grok 因未信任而拒绝装完，返回可理解错误，不得在主进程里偷偷重试 `--trust`。

## 文件范围

**创建：**

- `src/main/runtime/grok/grok-plugin-cli.ts`、`grok-plugin-cli.test.ts`
- `src/main/runtime/grok/grok-marketplace-inventory.ts`、`grok-marketplace-inventory.test.ts`
- `src/shared/runtime-marketplace-plugin.ts`、对应测试
- `src/renderer/src/components/PluginTrustDialog.vue`

**修改：**

- `src/shared/app-ipc.ts`、`src/main/app-ipc.ts`、`app-ipc.test.ts`、`src/main/index.ts`
- `src/preload/desktop-api.ts`、`desktop-api.test.ts`、`index.d.ts`
- `src/renderer/src/components/PluginsPage.vue`、`plugins-page.ts`、`plugins-page.test.ts`
- `src/renderer/src/slash-command-palette.ts`（`/marketplace` 打开插件页市场栏）
- `docs/superpowers/plans/roadmap-index.md`、`grokACP计划/README.md`、`AGENTS.md`、`CLAUDE.md`

依赖 P0-10D 已存在的 `GrokHomeConfigController` 合并写入。不得再走会整文件覆盖的 `writeGrokProviderConfig`。

## 已锁定 UI

```text
插件
只展示 App grok-home 已加载项；安装由 Grok 执行。
[已安装] [市场]

已安装                         市场
chrome-devtools-mcp            xAI Official / plugin-marketplace
  Skill 6 · MCP 1 · Hooks 0      chrome-devtools   [安装]
  已信任 · 已启用                  figma            [安装]
  [卸载]                         …
```

- 默认停在「已安装」。从 `/marketplace` 或空状态「去市场看看」切到市场栏。
- 市场项显示 name、description、skill/mcp/hook **计数**（来自 `plugin-index.json` 若有，否则不编造组件列表）。
- 已安装项点开仍是 P0-10C 摘要，不渲染 hooks 命令。
- 安装中按钮 disable + 状态文案；失败可重试。
- 启停开关仍由 P0-10D Task 8 负责；本计划不重做。

### 斜杠命令

| 命令 | 落点 | P0-10E |
| --- | --- | --- |
| `/plugins` | 已有，打开插件页 | 保持 |
| `/marketplace` | 产品别名 → 插件页市场栏 | 是 |
| Grok 广告的 `/plugins` | 产品别名优先，不 startTurn | 保持 |

---

### Task 1: 市场条目契约

**Files:**

- Create: `src/shared/runtime-marketplace-plugin.ts`、测试

**Produces:**

```ts
export interface MarketplacePluginSummary {
  name: string
  displayName: string
  description: string
  sourceName: string
  installed: boolean
  skillCount?: number
  mcpCount?: number
  hookCount?: number
}

export function parseMarketplacePluginSummary(value: unknown): MarketplacePluginSummary | null
```

禁止 `path`、`sha`、`url` 进 Renderer DTO。`sourceName` 用 config 里的 `name`（例如 `plugin-marketplace`），不是 git URL。

- [x] 测试：混入 `path`/`sha` 被丢；非法 name 跳过。

---

### Task 2: 只读扫描 marketplace-cache

**Files:**

- Create: `src/main/runtime/grok/grok-marketplace-inventory.ts`、测试

扫描 `join(getManagedGrokHome(userDataPath), 'marketplace-cache')` 下一层目录。每个源读 `.grok-plugin/marketplace.json`。realpath 必须在 grok-home 内。cache 缺失 → `[]`，不是错误。

与已装 `registry.json` 的插件名交叉，标 `installed`。注意市场条目 `chrome-devtools` 与已装 id `chrome-devtools-mcp` 可能不同：用 registry 的 `marketplace.plugin_subdir` 或 name 前缀对齐，**不要**靠猜。测装置 chrome-devtools 这条真实对应。

- [x] 测试：cache 不存在返回 []。
- [x] 测试：marketplace.json 的 19 项可解析，且不含绝对路径。
- [x] 测试：symlink 逃出 grok-home 的 cache 项跳过。

---

### Task 3: Grok plugin CLI 封装

**Files:**

- Create: `src/main/runtime/grok/grok-plugin-cli.ts`、测试

**Produces:**

```ts
export function grokPluginLeaderSocket(grokHome: string): string
export async function runGrokPlugin(input: {
  grokHome: string
  grokBinary: string
  args: string[]
  timeoutMs: number
}): Promise<{ ok: true; stdout: string } | { ok: false; message: string }>
```

硬性：

1. `args[0]` 必须是 `plugin`。
2. 自动注入 `--leader-socket` = `join(grokHome, 'studio-plugin.sock')`。
3. `env.GROK_HOME` 覆盖为 grokHome；不得把 `~/.grok` 设回去。
4. cwd 不得是用户项目根以外的随意目录；建议 grokHome。
5. timeout 默认 15 分钟（git clone）。120s 会在 GitHub 慢速拉取时杀掉进行中的 clone，只留下半截 `installed-plugins/<id>/.git`。
6. 非 0 退出：脱敏 stdout/stderr，截断 2 KiB。

测试用 fake binary，断言 argv 含自定义 socket、env 含 GROK_HOME、不含用户 home 的 leader.sock。

- [x] 测试：未传 trust 时 argv 不含 `--trust`。
- [x] 测试：错误文本不含绝对路径和 Key。

---

### Task 4: 安装 / 卸载 / 加源 IPC

**Files:**

- Modify: `app-ipc`、preload、`index.ts`

```ts
APP_INVOKE_CHANNELS.listMarketplacePlugins = 'app:list-marketplace-plugins'
APP_INVOKE_CHANNELS.installPlugin = 'app:install-plugin'
APP_INVOKE_CHANNELS.uninstallPlugin = 'app:uninstall-plugin'
APP_INVOKE_CHANNELS.addMarketplaceSource = 'app:add-marketplace-source'
```

请求：

```ts
installPlugin({ name: string, trust: boolean })
uninstallPlugin({ pluginId: string })
addMarketplaceSource({ gitUrl: string })
```

`installPlugin`：name 必须出现在 **当前** `listMarketplacePlugins()` 结果里。`trust !== true` 则不加 `--trust`。未知 name → `invalid-input`。

GitNexus：改 IPC 注册前对 `registerAppIpcHandlers` 做 upstream impact。

- [x] 测试：静态 channel 数组含这四项，且仍无 `grok:*`。
- [x] 测试：name 含 `..` `/` 被拒。
- [x] 测试：gitUrl 带 userinfo 被拒。

---

### Task 5: 插件页两栏与信任确认

**Files:**

- Modify: `PluginsPage.vue`、`plugins-page.ts`
- Create: `PluginTrustDialog.vue`

已安装栏保持 P0-10C。空状态增加按钮「去市场看看」，**不要**再让人以为扫描坏了。

信任框必含：

- 插件 name
- 市场源展示名（不是 URL）
- 「信任后将启用该插件的 Hooks、MCP 与 LSP，并以你的用户权限运行。」
- 主按钮默认不可点，直到勾选确认

安装成功 toast/横幅：「已安装。新对话或重新进入任务后由 Grok 加载。」不得说「当前 Turn 已生效」。

- [x] 测试：未勾选信任不能发出 `trust: true`。
- [x] 测试：`/marketplace` 产品别名打开市场栏且 kind 为 product。

---

### Task 6: 验证

- [x] 目标文件 ESLint、`pnpm test`、`pnpm typecheck`、`pnpm build`、`git diff --check`（2026-08-21：Node v22.22.0 / pnpm 10.33.0；vitest 99 files / 814 tests；全量 ESLint 0 error，1 条既有 prettier warning 在未改的 `useTaskTimeline.test.ts`）
- [ ] 开发版：插件页已安装能看到 `chrome-devtools-mcp`（若仍留在 App grok-home）——本机 grok-home **无** `installed-plugins`，未跑开发版 GUI
- [ ] 开发版：市场栏能看到官方源条目；再装一个非 Google 插件（例如 `exa`）走完确认框——本机 grok-home **无** `marketplace-cache`，未跑开发版 GUI
- [ ] 安装前后 `~/.grok/config.toml` hash 不变——未实际安装插件，未哈希用户 toml
- [ ] 进行中 Task 切到插件页安装，Turn 不 cancel——未跑开发版 GUI；单测覆盖安装路径不 `cancelTurn` / `disconnect`
- [ ] 保存供应商配置后 `[plugins]` / `[marketplace]` 仍在（依赖 P0-10D 合并）——未跑开发版 GUI；合并写入由 P0-10D 单测覆盖

## 验收标准

- [x] 市场与已安装是两份名单；货架未装项不得出现在已安装栏。（库存/货架单测；GUI 未跑）
- [x] 安装必须经过信任确认；主进程在 `trust !== true` 时不传 `--trust`。（UI + IPC + CLI 单测）
- [ ] 安装写入 App grok-home 的 `installed-plugins/`，不写 `~/.grok`。——CLI 单测覆盖 `GROK_HOME` 与 socket；真机写入未跑
- [x] CLI 使用 grok-home 内 leader socket，不连接用户 TUI leader。（CLI 单测）
- [x] Renderer 看不到绝对路径、registry path、MCP command/env。（DTO / 扫描 / preload 单测）
- [x] 无 `grok:*` IPC；`clientCapabilities` 仍为 `{}`。（channel 单测 + Adapter 源码）
- [ ] 当前 Turn 不因安装而中断；新插件下一 session 生效。——单测覆盖不 cancel；开发版进行中 Task 安装未跑

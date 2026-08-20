# Agent Studio

本地多 Agent 工作台。当前接入的第一个 Runtime 是 **Grok Build**，桌面端作为 ACP Client 负责项目、任务、对话、权限确认和模型配置，自己不当 Agent。

> 本项目不是 xAI 官方产品，也不代表 xAI。使用前需要本机已安装可通过 `grok` 启动的 Grok Build CLI。

长期产品愿景见 [docs/product-vision.md](docs/product-vision.md)。开发顺序见 [docs/superpowers/plans/roadmap-index.md](docs/superpowers/plans/roadmap-index.md)。

## 当前能力

### 模型供应商

- 首次启动必须先配置 **OpenAI Chat Completions 兼容** 服务：Base URL、认证方式（Bearer 或无需 Key）、Model ID。
- 主进程会请求 `GET /models` 拉取真实模型列表，保存前用选定模型打一次极小的 `POST /chat/completions` 连通测试。
- 没有可用列表时可以手动填写 Model ID；界面只显示接口返回的 `displayName`，没有就原样显示 `modelId`，不会拼接 Runtime 名称。
- 已保存的 API Key 使用 Electron `safeStorage` 加密落盘，渲染进程只能看到「已保存」，不能回填明文。
- Base URL origin 改变后必须重新输入 Key，不会把旧密钥发到新地址。
- 支持 HTTP 和 HTTPS；HTTP 配置会持续提示明文传输风险。
- 当前只保存 **一份** 供应商配置，没有多 Profile。

### 工作台

- 注册本地项目目录后，侧栏按项目平铺；点标题只展开或浏览任务，不会立刻打断当前对话。
- 每个项目可以新建对话、打开文件夹、从列表移除记录（保留墓碑和历史，不删磁盘目录），或删除 Agent Studio 本地历史。
- 任务支持点选进入、重命名、归档、删除；执行中仍可查看其它任务历史，但不能同时再发一条。
- 点进历史任务就是进入这条对话：立刻看到本地消息，输入框可直接发送，没有「继续任务」按钮。后台会尝试接回 Grok session；接不上时仍留在同一条任务上，状态条会说明上下文可能不完整。
- 首版只有 **一个执行槽**：一条任务在跑时，其它任务可以看、可以打草稿，发送会被拦住，直到当前 Turn 结束或被停止。
- 侧栏「插件」打开主列整页，只展示 App 专属 `userData/grok-home` 里 Grok 已加载的插件摘要；切到插件页 **不会** 停止正在跑的任务，也不会清空当前选中对话。进行中或等待审批时，插件页顶部可以返回对话。
- 标题栏可打开检查器抽屉（盖住右侧，不占第三列）。Timeline 显示轮次摘要；历史任务还能看权限审计。Changes / Terminal / Artifacts 目前是占位，尚未实现。

### 对话与执行

- 通过 ACP stdio 启动 Grok Build：`grok --no-auto-update agent --no-leader -m agent-studio-default stdio`。
- 流式展示助手回复、思考过程、计划和工具活动。助手正式回复按 Markdown 渲染标题、列表、代码、表格和安全外链；原始 HTML 与危险链接会降级为文本。
- 工具调用收成短标签，长命令或路径默认折叠。
- 输入框左下角切换模型；任务执行中禁止切换。有上下文用量时显示在模型选择器旁。
- 输入框以 `/` 开头时打开斜杠命令板：展示当前 session 里 Grok 广告的命令，以及桌面别名 `/plugins`、`/settings`。Grok 还没广告时只显示等待/空，不会手写一份假菜单。选产品别名只做导航，不会当成 Prompt 发给 Grok。
- 发送任务、停止当前 Turn。Enter 发送，Shift+Enter 换行。Esc 在命令板打开时先关面板，不停止任务。
- 轮次结束后有结果审阅摘要（用量、是否观察到 Diff / 验证 / Artifact）；未接入的能力会标明「未观察」或「尚未接入」，不会假装已经成功。

### 权限

- Grok 发起的敏感操作经主进程 Permission Broker 处理：L0 只读可自动允许；写文件、执行命令等需要用户确认；浏览器、屏幕、剪贴板在能力未接入前直接拒绝。
- 审批卡贴在对应轮次里：本任务允许、仅允许这一次、拒绝或停止。L3 高风险只能允许本次。
- 同一 Task 内可复用已授予范围，避免重复点同类操作。

### 外观

- 设置弹窗分为「供应商」和「外观」。
- 外观可选深色、米白、跟随系统；跟随系统时，系统浅色用米白，系统深色用现有深色。

## 当前边界

这些是代码里明确还没有做、或刻意收窄的部分，避免把「能启动」写成「完整 Agent 工作流」：

- 只有 Grok Build Runtime；Codex 尚未接入。
- 桌面不是 MCP Host，也不修改用户自己的 `~/.grok`。Grok 配置写在应用 `userData/grok-home`。
- ACP 握手使用 `clientCapabilities: {}`，Prompt 只发文本。斜杠命令来自 Grok 的 `available_commands_update` session 快照，不进 Timeline。记忆浏览和 MCP 注入尚未做（见 P0-10D）。插件页不能安装/卸载，启停开关还是占位。
- 没有隔离 Worktree、Git Diff 审阅、用户交互终端或 Artifact 预览。
- 不会宣称支持全部 OpenAI 兼容模型；当前验证的是 Chat Completions 的 `/models` 与 `/chat/completions`，再加上 Grok Build 作为 Agent 去实际执行。

## 环境要求

- Node.js 20 或更高版本（本机验证优先 Node 22 / 24）
- pnpm 10
- 已安装 Grok Build CLI，并能通过 `grok` 或 `~/.grok/bin/grok` 启动

安装 Grok Build：

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

模型服务在应用内配置。官方 CLI 的 `grok login` 不是 Agent Studio 保存 API Key 的方式。

## 本地开发

```bash
pnpm install
pnpm dev
```

首次打开会进入供应商引导；保存成功后才会进入项目 / 任务工作台。

## 验证与构建

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
pnpm build:mac
```

`pnpm test` 跑 Vitest 单元测试，排除 `tests/e2e/**`。受控 Electron e2e 是独立脚本（`pnpm test:lifecycle:e2e`、`pnpm test:permission:e2e` 等），需要先构建。Windows / Linux 安装包脚本为 `pnpm build:win`、`pnpm build:linux`。

## 技术结构

```text
src/main/index.ts              Electron 生命周期、窗口创建、服务组装与 IPC 注册
src/main/agent/                Agent 服务、任务执行槽、事件归一化与历史存储
src/main/runtime/grok/         Grok Build ACP Adapter（子进程、握手、session、权限转发）
src/main/provider/             Provider 校验、发现、连通测试、加密存储与 Grok 配置生成
src/main/security/             脱敏、权限策略与 Permission Broker
src/main/project/              本地 Project 注册表
src/main/appearance/           外观偏好
src/preload/                   类型化窄 IPC：window.agent / app / task / provider
src/shared/                    可序列化领域类型，不包含密钥或 Node 实现
src/renderer/src/              Vue 3 工作台（侧栏、对话、检查器、设置）
```

数据流固定为：Renderer → Preload 窄 API → 主进程 IPC → Provider / Runtime / Security → 网络、文件系统或子进程。渲染进程不能发带 Key 的模型请求，也不能读配置文件。

## 安全说明

- `contextIsolation` 与 `sandbox` 保持开启；渲染进程没有 Node.js、Shell 或任意 IPC 调用能力。
- API Key 只在主进程使用，不写日志、错误信息或 Grok TOML 明文。
- 模型 Key 不会被 Grok 启动的 Bash / Terminal 等工具子进程继承。
- HTTP Provider 没有传输加密，请只连可信服务，并优先使用低权限、可轮换的 Key。
- 本项目仍处于早期阶段。请在重要仓库里先确认 Grok Build 的权限和沙箱配置，再让它改文件或跑命令。

## License

[MIT License](LICENSE)

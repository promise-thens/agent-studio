# Agent Studio 协作规范

## 1. 适用范围

本文件适用于仓库根目录及全部子目录。子目录若存在更具体的 `AGENTS.md`，其规则只作为补充，不得削弱本文件中的安全、凭据和数据边界。

## 2. 沟通与协作

- 默认使用中文沟通，语气亲切自然，可以轻松幽默，但技术结论必须严谨、可验证。
- 开始任务前先确认真实工作目录、Git 状态、相关文档和现有实现。
- 复杂或可并行任务由主进程先拆分独立子任务，等待子进程结果汇总后再修改。
- 会影响产品行为、数据安全或架构边界的歧义，必须列出不同解释并向用户确认。
- 优先使用最少代码、最短数据流和最直接的实现，不为尚未确认的未来需求提前搭建复杂抽象。
- 用户只要求讨论、诊断或审查时，不得擅自修改代码。
- 开发前可以使用GitNexus更新索引。
- 如果发现node版本不合适，可以是用nvm相关内容切换版本。
- 更新AGENTS.md时，同步更新CLAUDE.md
- 每个代码块需要加上备注备注使用中文

## 3. 项目定位

Agent Studio 是一个本地多 Agent 工作台，核心关系为：

```text
Agent Runtime × Model Provider × Capability Pack
```

- Grok Build 是当前第一个 Agent Runtime，不是整个产品品牌。
- Codex app-server 是计划接入的第二个 Runtime。
- Provider、模型、凭据、插件和权限属于中性产品能力，不得绑定到 Grok 命名。
- “Agent Studio”用于产品、应用、安装包和通用 UI。
- “Grok Build”只用于 Grok Runtime、ACP 协议适配和专属状态。
- 不得把“基础接口可调用”描述为“完整支持 Agent 工作流”。

## 4. 技术基线

- Electron 39
- Vue 3
- TypeScript
- electron-vite
- pnpm 10
- Node.js 20 或更高版本
- Grok Build ACP

不得在 Node 版本低于 `package.json.engines.node` 时生成依赖、锁文件或正式验证结论。本机验证优先使用 Node 22 或 Node 24。

## 5. 目录职责

现阶段保持目录简单，不因整理目录而迁移无关代码。新增模块按以下职责放置：

```text
src/
├── main/
│   ├── index.ts              Electron 生命周期、窗口创建、依赖组装和 IPC 注册
│   ├── grok-agent.ts         当前 Grok ACP Runtime 实现
│   ├── provider/             Provider 校验、发现、测试、存储和 Runtime 配置生成
│   └── security/             脱敏、权限和跨领域安全工具
├── preload/
│   ├── index.ts              类型化窄 IPC 桥接
│   └── index.d.ts            Renderer 全局 API 类型
├── shared/                   可序列化领域类型、错误码和 IPC 数据结构
└── renderer/src/
    ├── App.vue               应用状态编排，不持续堆积具体页面实现
    ├── components/           具备独立业务职责的 Vue 组件
    ├── composables/          多组件共享的响应式状态和 UI 编排
    └── assets/               全局样式、设计变量和静态资源

docs/
├── product-vision.md         长期产品愿景与已确认边界
├── superpowers/plans/        按阶段与开发顺序编号的具体实施计划
├── superpowers/plans/grokACP计划/  Grok ACP 加深计划；从 P0-09 测试门之后开始
└── architecture/             只有形成稳定跨模块设计时才创建
```

目录约束：

- `src/main/index.ts` 只负责组装和注册，不承载 Provider 请求、加密或协议转换细节。
- `src/shared` 不得导入 Electron、Node.js 文件系统或主进程实现，也不得包含明文密钥。
- Renderer 不得直接访问文件系统、Shell、子进程、`safeStorage` 或 Provider 网络请求。
- Provider 层负责模型服务；Runtime Adapter 只消费已验证的内部配置。
- Grok 专属逻辑不得写入 Provider 通用类型。
- 测试文件与源文件就近放置为 `*.test.ts`。
- 第二个 Runtime 真正接入前，不提前建设庞大的 Runtime 框架；届时再迁移为 `runtime/grok`、`runtime/codex`。

## 6. 分层数据流

唯一允许的业务数据流是：

```text
Renderer
→ 类型化 Preload API
→ 主进程 IPC Handler
→ Provider / Runtime / Security 服务
→ 网络、文件系统或子进程
```

返回方向通过脱敏结果、状态摘要或类型化事件完成。

禁止：

- Renderer 直接发 Provider 请求并携带 API Key；
- Renderer 读取配置文件或解密密钥；
- Runtime Adapter 直接操作 Vue 状态；
- Provider 层依赖 Grok UI 文案；
- 为不同 Runtime 复制相同的 Provider 或安全实现。

## 7. 命名规范

- 产品通用类型使用 `Agent`、`Runtime`、`Provider`、`Capability`、`Permission`。
- Grok 专属实现才使用 `Grok` 前缀。
- 新增通用 IPC 使用 `agent:*`、`provider:*`、`app:*` 等中性命名。
- 不得继续为通用能力新增 `grok:*` IPC。
- TypeScript 类型和 Vue 组件使用 PascalCase。
- 变量、函数和字段使用 camelCase。
- 普通文件使用 kebab-case，Vue 组件文件使用 PascalCase。
- 模型调用和持久化使用 `modelId`，界面展示使用 `displayName`。
- 避免含义模糊的 `data`、`info`、`handler`、`utils`，名称必须表达领域职责。

### 模型名称强制规则

模型选择器的 value 必须是实际 `modelId`，显示标签只能使用接口实际返回的数据：

```ts
const modelLabel = model.displayName?.trim() || model.modelId
```

- 有实际 `displayName` 时显示它。
- 没有 `displayName` 时原样显示 `modelId`。
- 手动填写的模型只显示用户填写的 `modelId`。
- 禁止添加 `Grok ·`、`Codex ·`、Runtime 名、Provider 别名或其他合成前缀。
- 禁止自行编造营销名称或把内部模型别名当成实际模型名称。
- Runtime 身份必须由独立状态、徽标或 Runtime 选择器展示。

推荐共享类型：

```ts
interface ProviderModelOption {
  modelId: string
  displayName?: string
}
```

## 8. 中文注释

- 新增或修改的核心函数、类和安全边界必须使用中文注释说明当前代码负责什么。
- IPC Handler、密钥处理、URL 校验、子进程环境构造和异常降级必须写中文 TSDoc。
- 注释重点解释原因、边界和风险，不重复翻译代码语法。
- 简单赋值和显而易见的分支无需逐行注释，避免注释噪音。
- 协议字段、API 名称、类型名和命令保持官方英文名称。

## 9. IPC 安全

- 保持 `contextIsolation: true`、`sandbox: true`，不得启用 `nodeIntegration`。
- 新增功能必须通过明确、类型化的 Preload API 暴露。
- 不得把 `ipcRenderer`、文件系统、Shell 或通用 invoke 能力直接交给 Renderer。
- 现有 `window.electron` 不得作为新增业务功能入口。
- IPC channel 必须静态声明，禁止由 Renderer 动态指定 channel 或系统命令。
- 主进程必须重新校验所有参数；Renderer 校验只用于交互提示。
- Handler 必须校验调用方来自当前主窗口，并限制字符串、数组和请求体大小。
- IPC 只传递可序列化数据。
- 错误返回 Renderer 前必须脱敏，不得传递完整请求对象、Header、环境变量或原始异常堆栈。
- 事件订阅必须返回清理函数，组件卸载时移除监听器。
- 禁止出现 `provider:get-api-key` 或任何等价的明文密钥读取接口。

## 10. 密钥与配置安全

- API Key 只能在主进程中使用。
- 已保存的明文 Key 永远不得返回 Renderer、写入日志、TOML、错误信息、测试快照或 Git。
- 使用 Electron `safeStorage` 加密，并且只在 `app.whenReady()` 后调用。
- 配置写入 `app.getPath('userData')`，使用版本化结构和原子写入。
- 配置目录尽量使用 `0700`，配置文件使用 `0600`。
- Linux 检测到 `basic_text` 或无安全后端时，只允许本次会话使用，不得明文持久化。
- 不修改全局 `process.env`；Runtime 使用单独构造的环境变量对象。
- 模型 Key 不得被 Runtime 启动的 Bash、Terminal 或其他工具子进程继承。
- App 专属 Grok 配置不得修改用户的 `~/.grok`。
- Runtime stderr、网络错误和主进程日志必须先经过统一脱敏。
- Provider Base URL 支持 HTTP 和 HTTPS；HTTP 不提供传输加密，配置页必须持续提示 API Key 与请求内容可能被截获。
- URL 禁止内嵌账号密码或在 query/hash 中携带 Secret。
- Base URL origin 改变时必须重新输入 Key，禁止向新 origin 静默发送旧 Key。
- 自动化测试只能使用明显的假 Key 和本地 Mock Server。

## 11. UI 与交互约束

- 保持当前深色桌面工作台风格，优先复用现有颜色、边框和圆角变量。
- 不在组件中随意硬编码另一套颜色系统。
- 首次 Provider 配置完成前，不显示可误操作的工作台连接流程。
- 加载、空状态、测试中、保存中、失败、重试和成功必须有明确反馈。
- 保存后的 Key 只显示“已保存”，不得回填明文。
- 模型快捷选择器放在输入框 footer 左侧；完整 URL、Key 和模型管理放设置页。
- 模型选择器只显示实际 `displayName ?? modelId`，不得拼接 Runtime 名称。
- Runtime 与模型必须分开显示，避免用户误以为模型属于某个固定大脑。
- 执行任务期间禁止切换模型；切换模型若需要重启 Runtime，必须等待主进程确认后再更新 UI。
- UI 不得先乐观显示“已切换”，再等待主进程实际失败。
- 模型列表向上展开，长名称省略并提供完整名称提示。
- 小窗口优先隐藏快捷键提示，必须保留模型选择器、输入区域和发送按钮。
- Titlebar 内交互控件必须设置 `-webkit-app-region: no-drag`。
- 所有图标按钮必须有 `title` 或 `aria-label`。
- 表单错误必须关联具体字段，键盘焦点和 `focus-visible` 不得被移除。
- 保留 `prefers-reduced-motion` 支持。

## 12. 测试与验证

开始验证前确认：

```bash
node --version
pnpm --version
```

Node 必须为 20 或更高版本，pnpm 使用项目声明的 10.x。

当前基础验证命令：

```bash
pnpm exec eslint . --no-cache
pnpm typecheck
pnpm build
git diff --check
```

规则：

- 修改少量文件时先运行目标文件 ESLint，再运行完整验证。
- 修改 Electron 身份、构建配置或主进程入口时，额外运行 `pnpm build:unpack`。
- 引入 Vitest 后在 `package.json` 建立统一的 `pnpm test` 脚本，并将其加入必跑项。
- Provider 测试必须覆盖 URL 校验、模型发现、401/403、404、429、超时、错误结构和脱敏。
- 存储测试必须覆盖加密、重启读取、损坏配置、解密失败、清除和原子写入失败。
- 不得使用真实付费模型或真实 API Key 完成自动化测试。
- UI 或 Electron 行为修改后必须运行开发版做对应手工验证，并如实区分自动验证和手工验证。

## 13. Git 与脏工作区

- 每次修改前运行 `git status --short --branch`。
- 已存在的修改和未跟踪文件默认属于用户，必须保留。
- 不得使用 `git reset --hard`、`git checkout --` 或类似命令覆盖用户工作。
- 不得擅自 stash、删除或格式化无关文件。
- 提交前检查 `git diff`、`git diff --cached` 和 `git diff --check`。
- 一次提交只包含一个清晰主题；确需包含用户已有改动时，先逐项核对。
- 提交信息使用 Conventional Commits，例如 `feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:`。
- 未经用户要求，不擅自推送、创建 Release 或修改远程仓库设置。

## 14. 文档规则

- 产品长期定位和已确认边界更新到 `docs/product-vision.md`。
- 跨层或多步骤功能开发前，在 `docs/superpowers/plans/` 编写独立实施计划，并通过 `roadmap-index.md` 维护开发顺序与依赖。
- Grok ACP 加深计划放在 `docs/superpowers/plans/grokACP计划/`，从 P0-09 测试门之后开始，不得插入正在测试的时间线工作。
- 计划文件名使用 `<phase>-<sequence>-<topic>.md`，例如 `p0-05-grok-acp-adapter-migration.md`；同一序号需要拆分时使用小写字母后缀，例如 `p2-04a-...`、`p2-04b-...`。历史归档可以使用明确的语义化名称，不添加日期前缀。
- 实施计划至少写明目标、非目标、数据流、安全边界、文件范围、步骤和验收标准。
- 实现与计划发生变化时同步更新文档，不允许文档长期描述不存在的行为。
- README 只描述已经验证可用的当前能力，长期设想通过链接指向产品愿景。
- 不得宣称“支持全部 OpenAI 兼容模型”；必须写清已验证协议和 Runtime 限制。
- 新增长期架构目录或抽象前，先确认确有两个以上实现需要共享。

## 15. 当前实施进度

> 本节只记录当前任务快照；详细步骤和验证证据以对应实施计划为准。

- 当前计划：[P0-19 Grok 宿主能力打磨](docs/superpowers/plans/p0-19-grok-host-capability-polish.md)。P1-06～08 与 P2 搁置；P3 自建浏览器/Helper 后置于 19f。P0-13 代码已落地，开发版 GUI 走查仍是 0 号门。P0-14 Worktree 可与后续分计划并行，不挡宿主能力摊开。
- 状态：桌面定位为 Grok Build ACP Client，不自己当 Agent。设置现为供应商 / 外观 / 记忆 / Grok 配置；插件页三栏为插件 / MCP / 技能，插件 tab 内分已安装 / 市场，不得打断运行中 Task。Inspector 现为 Timeline/Plan/Changes/Terminal/Artifacts，支持悬浮拖拽、右侧吸附后三列自适应与双栏审阅；Changes 与 Artifacts 打开时加宽为审阅工作区。P2 Codex 暂缓
- 完成度：P0-01 至 P0-09、GACP-01 如前；GACP-02 核心已落地；P0-10 Task 1–4 已合入；P0-10A/B 代码已落地；P0-10C 代码已落地（自动验证已过，GUI 未跑）；库存扫描已补 `installed-plugins`；P0-10D 代码已落地（相关自动测试已过，开发版 GUI / TUI 对读未跑）；P0-10E 代码已落地（自动验证已过；already-configured 加源已修，开发版 GUI / 安装走查未跑）；P0-11 Task 1–4 已合入 main（自动验证已过，开发版 GUI 走查未跑）；GACP-03 代码已落地（真机/GUI 未收口）；P0-12 Task 1–4 代码已落地；P0-12A 两层审阅代码已落地（聚焦测试 + typecheck 已过，开发版 GUI 走查未跑）；P0-18 P0/P1 代码与关键 GUI 主路径已落地；P0-13 代码已落地（自动测试 + typecheck 已过，开发版 GUI 走查未跑）；GACP-04 代码已落地（相关 Vitest 已过；lifecycle/permission E2E 与 GUI 未跑）；P0-19g Task 1–3 代码已落地（接管默认关，Composer 三档 ask/assist/takeover，开发版 GUI 未走查）；P0-19a 任务 1–3 代码已落地（Grok 1.0.13 未广告 `plan`，当前 disabled-path；Vitest 已过；「开 Plan → 清单」GUI 未过）；GACP-06 代码已落地（可选 `parentId` 优先；无 parent 时只认 `[subagent:` spawn 行药丸卡；中文标题不聚类；开发版 GUI 未走查）
- Grok ACP 加深：GACP-01 → GACP-02 → P0-10C/D/E → P0-11 → GACP-03（纳入 P0-19）→ GACP-04（方言契约已落地，不挡 P0-19）→ P0-19a～g 与 GACP-06（代码已落地扁平）。`available_commands_update` 现为 session 快照，不进 Timeline。命令证据走 `task:list-command-evidence` 等只读查询，不进交互终端。变更审阅走 `task:get-change-set` / `task:get-file-diff` / `task:list-turn-checkpoints`；撤销走 `task:preview-latest-turn-restore` / `task:restore-latest-turn`
- 兼容边界：首版仍只有一个执行槽；GROK_HOME 仍是 App 目录；记忆整棵树 junction 到 `~/.grok/memory`；用户 toml 只允许合并/删除 `[mcp_servers.*]`；`clientCapabilities: {}`；不把桌面做成 MCP Host 或 Marketplace Host。自动撤销仅 latest-turn 且无漂移；检查点只存哈希，禁止 git reset/checkout。完全接管（always-approve）按 P0-19g：当前 Task 显式开关，默认关，不写全局 yolo。Plan 开关只消费广告的 `name === 'plan'`，未广告不得伪造 `/plan`。子 Agent：`parentId` 或结构化 `[subagent:` 才成卡，禁止用中文标题猜树；不得宣称已支持任意协议嵌套
- 下一步：P0-19b Sandbox。P0-19g / P0-19a / GACP-06 开发版 GUI 走查仍未跑。P0-10C 至 P0-13 开发版走查暂时可以通过。不要加回「继续任务」按钮
- 最近验证：2026-09-01 GACP-06。`pnpm test` 136 files / 1271 tests 已过；`pnpm build` 已过；开发版 GUI 未走查；真机观察白名单为空，生产路径扁平，不得宣称真机嵌套

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **agent-studio** (7806 symbols, 20713 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/agent-studio/context` | Codebase overview, check index freshness |
| `gitnexus://repo/agent-studio/clusters` | All functional areas |
| `gitnexus://repo/agent-studio/processes` | All execution flows |
| `gitnexus://repo/agent-studio/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

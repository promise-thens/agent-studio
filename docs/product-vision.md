# Agent Studio 产品愿景

> 状态：讨论草案
> 创建日期：2026-08-07
> 核心共识：以 Project / Task 为产品骨架，多 Agent Runtime × 多 Model Provider × 多 Capability Pack 为开放能力底座

## 1. 文档目的

本文用于沉淀 Agent Studio 当前阶段的产品共识、边界和演进方向。

它不是最终技术设计，也不代表其中所有能力都已经进入开发。项目将按照“先建立正确边界，再逐步扩展能力”的原则推进，后续讨论形成的新共识继续补充到本文；当具体技术方案稳定后，再拆分独立的架构和协议文档。

## 2. 产品愿景

Agent Studio 不应只是 Grok Build 的桌面外壳，也不以复刻 Codex Desktop 的界面为最终目标。

我们的目标是打造一个以本地桌面应用为入口，能够切换、组合和管理不同 Agent 大脑，自由配置模型服务，并通过插件获得浏览器、电脑和开发工具操作能力的 AI 工作台。

一句话定位：

> 一个以本地项目和长任务为中心，允许 Agent 持续执行、产出真实文件并由用户审阅接管，同时支持开放 Runtime、模型服务和能力工具的桌面 AI 工作台。

产品的核心组合关系是：

```text
Agent Runtime × Model Provider × Capability Pack
```

- **Agent Runtime** 决定 Agent 如何思考、规划和执行任务。
- **Model Provider** 决定实际使用哪个模型、接口和计费服务。
- **Capability Pack** 决定 Agent 能操作哪些外部工具和桌面环境。
- **Security & Governance** 统一负责权限、密钥、审计和回滚。

### 2.1 用户可见的产品骨架

`Agent Runtime × Model Provider × Capability Pack` 是系统供给侧组合，不应成为用户理解产品的第一道门槛。用户首先面对的是项目和任务：

```text
# 备注：以下是用户可见的产品对象，Runtime 私有会话不会成为并列导航层级。
Project
└── Task
    ├── Turn 1..N
    ├── Execution Environment（Local / Worktree）
    ├── Timeline / Permission / Command Evidence
    ├── Changes / Diff / Validation
    └── Artifact / Review / Delivery
```

- **Project** 是持久化的本地工作范围，保存 canonical root、项目规则和任务索引。
- **Task** 是用户可见、可恢复的长期目标或对话，同一个 Task 可以连续执行多个 Turn。
- **Turn** 是用户的一次指令以及 Agent 对应的一次完整执行。
- **Execution Environment** 决定任务写入用户当前目录还是隔离 Worktree；任务创建后不得静默切换。
- **Timeline** 负责按执行顺序展示消息、计划、权限、命令和状态，只保存 Changes、Validation 与 Artifact 的受限引用，不复制它们的事实。
- **Changes** 负责文件基线、TaskChangeSet、Diff、归因和 Validation；Diff 是 Changes 的审阅视图，不属于另一套 Artifact 数据源。
- **Artifact** 是任务产生的命名、类型化可审阅结果，包括文本、Markdown、图片、HTML 预览，以及指向 Changes 或 Validation 的受限引用；它不复制 Git 基线、Diff 或验证事实。
- Runtime session、Grok session 和 Codex thread 是 Task 的内部运行引用，不与 Task 并列成为用户必须管理的产品对象。

## 3. 为什么做这个项目

### 3.1 不同大脑擅长的问题不同

Grok Build、Codex 以及未来其他 Agent Runtime 在任务规划、上下文组织、工具使用、代码修改和问题排查方面会形成不同风格。

用户不应该只能选择一个固定大脑，而应该能根据任务切换、比较，甚至让多个大脑接力协作。

### 3.2 模型成本不应该成为使用门槛

并非所有用户都能长期承担昂贵的官方模型费用。项目应支持用户配置 OpenAI 兼容服务、OpenRouter、Ollama、自建网关等模型来源，在能力满足要求的前提下选择更合适的成本方案。

### 3.3 大脑、模型和工具不应该被永久绑定

当前许多 AI 产品会把 Agent Runtime、模型供应商和工具生态绑定在一起。本项目希望将三者拆分，让用户可以自由组合，同时明确展示组合是否真正兼容。

### 3.4 Agent 的操作过程需要透明和可控

当 Agent 开始修改文件、执行命令、访问网页或操作电脑时，仅显示一个“允许”按钮是不够的。

用户需要知道：

- Agent 正在做什么；
- 将操作哪个文件、命令、网站或应用；
- 可能产生什么影响；
- 是否能够撤回；
- 最终修改和验证结果是什么。

## 4. 总体分层

```text
Desktop Workbench
        │
Unified Agent Core
Project / Task / Turn / Environment / 事件 / 审批 / 历史
        │
        ├── Grok Build ACP Adapter
        ├── Codex app-server Adapter
        └── Future Agent Adapters
        │
Model Provider Layer
xAI / OpenAI / OpenRouter / Ollama / Custom Gateway
        │
Capability Layer
MCP / Skills / Browser / Chrome / Computer Use / Git / Terminal
        │
Security & Governance
权限 / 密钥 / 沙箱 / 审计 / 检查点 / 回滚
```

我们统一的是产品语义和 UI 事件，不强行要求不同 Runtime 使用同一种底层协议。

## 5. Agent Runtime：大脑层

Agent Runtime 负责：

- 管理上下文和会话生命周期；
- 理解用户任务；
- 规划执行步骤；
- 决定何时调用工具；
- 处理工具返回结果；
- 发起权限申请；
- 维护任务状态和历史语义。

### 5.1 Grok Build

Grok Build 是项目当前接入的第一个 Agent Runtime，通过 ACP 与桌面端通信。

当前已经具备的基础闭环包括：

- 选择本地工作目录；
- 创建会话；
- 发送任务；
- 接收流式消息和思考过程；
- 展示计划和工具活动；
- 处理权限请求；
- 停止当前任务。

P0-04 已将通用 IPC 与共享类型迁移到中性的 Agent 边界；后续只需在 P0-05 把现有 `GrokAgentBridge` 收敛为 `GrokAcpAdapter`，让 Grok 专属协议继续停留在 Adapter 内。

### 5.2 Codex app-server

Codex app-server 是计划接入的第二个 Agent Runtime。

第一阶段重点适配：

- 初始化与账号状态；
- Model Provider 和模型选择；
- Thread 创建、读取、恢复和分叉；
- Turn 启动、中断和完成；
- Message、Reasoning、Plan 和 Usage；
- 命令执行；
- 文件变更和 Diff；
- 权限审批。

Grok ACP 与 Codex app-server 使用不同协议和生命周期，因此需要独立 Adapter。桌面端只在内部将它们转换为统一事件，不能把两套协议粗暴混为一体。

### 5.3 统一 Agent 语义

统一层至少应表达以下能力：

- 连接、断开和状态检查；
- 创建、恢复、分叉和搜索会话；
- 启动、引导、取消任务；
- 消息与推理增量；
- 计划更新；
- 工具开始、进度和完成；
- 文件变更和 Diff；
- 权限请求与处理结果；
- Token、费用和执行时间；
- 任务成功、失败或中断。

不同 Runtime 的能力不一定完全对称。能力状态应区分：

- 原生支持；
- 桌面端模拟；
- 实验性支持；
- 不支持。

不应为了界面统一而伪造后端并不具备的能力。

统一层还必须明确产品标识与 Runtime 标识的所有权：

- `projectId`、`taskId` 和 `turnId` 由 Agent Studio 创建和持有；
- `runtimeSessionId`、Codex thread ID 或 Grok session ID 只作为受限的 Runtime 引用；
- Adapter 接收产品层分配的 Task / Turn 上下文，不得自行把每次 Prompt 重新解释为一个新 Task；
- 桌面端保存可审阅的任务索引、脱敏事件、Artifact 引用和执行快照；Runtime 继续拥有其原生上下文，桌面端只在能力已验证时请求原生恢复；
- “可以重新打开历史”与“可以恢复 Runtime 上下文继续执行”必须作为两种不同能力展示。

## 6. Model Provider：模型层

### 6.1 登录与模型配置是两个概念

产品需要明确区分：

- **账号登录**：例如 Grok 账号、ChatGPT 账号或设备授权；
- **服务凭据**：例如 API Key、自定义 Header 或环境变量；
- **模型配置**：例如 Base URL、协议类型和 Model ID；
- **Runtime 绑定**：本次任务由哪个大脑使用哪个模型执行。

设置页不应把这些内容全部称为“登录”。

### 6.2 计划支持的模型来源

- xAI；
- OpenAI；
- OpenRouter；
- Ollama；
- 本地模型服务；
- 企业或个人自建网关；
- 其他符合对应协议要求的服务。

基础配置项包括：

- Provider 名称；
- 协议类型；
- Base URL；
- API Key 或安全凭据引用；
- Model ID；
- 自定义 Headers；
- Query Parameters；
- 上下文长度；
- 超时和重试策略；
- 已验证能力。

### 6.3 OpenAI 兼容不等于完整 Agent 兼容

“OpenAI 兼容”不是一个统一、完整的能力标准。

部分服务可能只兼容基础 Chat Completions，却不支持：

- Responses API；
- 流式工具调用；
- 工具结果回传；
- 并行工具调用；
- Reasoning 字段；
- 图片输入；
- Usage 统计；
- 完整的多轮 Agent 工作流。

当前已确认的边界：

- Grok Build 可以根据其实际配置支持 Chat Completions、Responses 和 Anthropic Messages 等后端；
- Codex app-server 的自定义 Provider 当前要求 Responses API，不能假设只提供 `/chat/completions` 的服务可以直接驱动 Codex；
- 具体兼容性需要跟随 Runtime 版本、官方文档和本机 Schema 持续验证。

因此，产品不能简单承诺“支持所有 OpenAI 兼容模型”。

### 6.4 模型兼容性体检

模型配置完成后，应分层检测：

1. URL 和身份认证；
2. 基础请求；
3. 流式输出；
4. 工具调用；
5. 工具结果回传；
6. 多轮任务完成；
7. 中断和错误处理；
8. 图片、Reasoning 等可选能力。

界面建议显示以下状态：

- 完整 Agent 兼容；
- 基础聊天兼容；
- 缺少工具能力；
- 协议不兼容；
- 尚未验证。

连接成功只能说明接口可访问，不能证明模型能够可靠完成 Agent 任务。

## 7. Capability Pack：插件与能力层

插件能力应该独立于具体 Agent Runtime。

同一个 Chrome、Computer Use、Git 或浏览器能力，应尽可能同时服务 Grok 与 Codex，而不是为每个大脑重复开发。

Capability Pack 不直接被 Runtime 调用，也不自行创建另一套权限、时间线、Diff 或 Artifact。统一调用链是：

```text
# 备注：以下调用链保证 Capability 复用核心服务，而不是绕过主进程另建执行通道。
Capability Manifest / ActionDescriptor
→ Capability Registry
→ Capability Executor
→ Permission Broker
→ 既有 Command Evidence / Changes / Validation / Artifact 服务
```

文件写入、命令执行、Git Review、Worktree 和 Artifact Registry 属于 Agent Studio 核心服务；Capability Pack 只能通过受限 Host Service 使用它们，不能把核心能力重新包装成拥有任意文件系统、Shell 或 IPC 的插件入口。

### 7.1 第一阶段能力包

- 项目识别、环境体检与受控验证入口；
- MCP Server；
- Skills；
- 应用内受管浏览器；
- Chrome Native Bridge；
- macOS Computer Use Helper。

### 7.2 浏览器能力

建议分阶段实现：

1. 使用 Playwright 或 CDP 的应用内受管浏览器，并使用独立 Profile；
2. 通过 Chrome Extension 和 Native Messaging 连接用户现有 Chrome；
3. 由用户主动选择标签页，并按网站或会话授予权限。

不能通过直接读取用户 Chrome Profile 的方式绕过浏览器权限或复用登录状态。

### 7.3 Computer Use

Computer Use 建议作为独立原生 Helper 和插件能力运行。

macOS 首期可以基于公开系统能力实现：

- Accessibility / AXUIElement；
- ScreenCaptureKit；
- Quartz / CGEvent；
- 应用状态读取；
- 点击、输入、滚动、拖拽和快捷键。

用户必须明确授予辅助功能和屏幕录制权限，并始终拥有可见的停止入口。

### 7.4 对标 Codex 插件的边界

对标 Codex 插件体验，指的是实现同类用户能力和统一的插件管理体验，不代表复制、打包或依赖 Codex 的私有插件实现。

可以复用的开放标准包括：

- ACP；
- MCP；
- Chrome Extension API；
- Native Messaging；
- CDP；
- Playwright；
- 操作系统 Accessibility API。

需要由本项目自行实现：

- 插件生命周期；
- 能力声明和协商；
- 权限和审计；
- 浏览器桥接；
- Computer Use 原生 Helper；
- 插件签名、升级和回滚。

## 8. 权限与安全原则

Agent Studio 自有的文件、命令、Git、Worktree 和插件操作，以及 Runtime 明确上报的审批请求，都必须经过统一的 Permission Broker。

大脑可以提出操作请求，但不能借已知审批扩大权限范围。Permission Broker 不是 Runtime 进程沙箱；Runtime 未上报便自行执行的副作用必须由进程隔离、最小环境和能力可信度单独约束，产品不得伪称已被 Broker 拦截。

### 8.1 基本原则

- 默认最小权限；
- 敏感操作显式审批；
- 审批内容必须具体、易于理解；
- 插件不能绕过统一权限中心；
- 所有关键操作可追踪；
- 文件修改应支持 Diff 审阅；
- 高风险修改尽可能提供检查点和撤销能力；
- 浏览器登录态、屏幕内容和剪贴板属于高敏感数据。

### 8.2 凭据安全

- API Key 只允许进入 Electron 主进程；
- 不向 Renderer 返回明文密钥；
- 不写入仓库、普通配置文件、日志或会话记录；
- 使用系统安全存储保存凭据；
- 向 Runtime 注入密钥时使用临时环境变量或安全引用；
- Agent 的终端工具默认不能继承模型服务密钥；
- Query Parameters 不得用于保存 Secret。

### 8.3 审批内容

审批界面至少应说明：

- 哪个大脑和插件发起操作；
- 要调用的工具；
- 目标文件、命令、应用或网站；
- 将发送或修改的数据；
- 是否存在外部副作用；
- 风险等级；
- 授权范围和有效期。

授权范围可包括：

- 仅本次；
- 本次任务；
- 当前会话；
- 当前项目；
- 满足明确参数限制的长期授权。

## 9. 核心用户体验

理想的基础任务闭环：

```text
打开或注册项目
→ 新建 Task 并选择 Local / Worktree
→ 固定 Runtime、模型和权限快照
→ 输入第一轮任务
→ Agent 在主进程持续执行，切换页面不终止任务
→ 查看执行时间线并审批敏感操作
→ 查看文件、Diff、命令证据、测试和 Artifact；需要时再打开用户交互终端
→ 继续输入下一轮修改要求
→ 接受、撤销、保留或交付结果
→ 稍后重新打开 Task，并在 Runtime 支持时继续原生上下文
```

用户需要随时看见：

- 当前使用的大脑和模型；
- Agent 正在执行的步骤；
- 已读取、修改和运行的内容；
- 当前 Token、费用和耗时；
- 哪些权限已授予；
- 最终修改、验证和风险摘要；
- 当前运行、排队和等待审批的后台 Task；
- 当前任务绑定的 Local / Worktree 环境以及是否存在未审阅修改；
- 可直接打开的 Artifact，以及它来自哪个 Turn、是否仍然可信。

## 10. 长期差异化方向

### 10.1 双脑对比

同一个需求分别交给 Grok 和 Codex，在隔离的 Git worktree 中执行，最后比较：

- 解决方案；
- 文件 Diff；
- 测试结果；
- 执行时间；
- Token 和费用；
- 用户最终选择。

### 10.2 大脑接力

- 一个大脑负责分析，另一个负责实现；
- 一个大脑实现，另一个负责审查；
- 当前大脑失败后，将任务和上下文移交另一个大脑；
- 用户可以在任务过程中主动发起有界 Runtime 接力，由新 Task 接收经过预览和确认的有限上下文，而不是原地改写当前 Task 的 Runtime。

### 10.3 自动路由

未来可以根据任务类型、模型能力、历史成功率、费用和速度，为任务推荐或自动选择 Runtime 与模型组合。

这些能力属于中长期方向，不应阻塞单大脑基础闭环和统一抽象的稳定性。

## 11. 分阶段路线

### P0：统一核心骨架与 Codex-style 单 Runtime 工作台

P0-01 至 P0-04 先完成统一领域、事件、能力和 IPC 基础；P0-04 保持当前中性 IPC 施工范围，不插入 Project、Worktree、终端或 Artifact 功能。P0-04 之后分成三个验收层：

#### P0-A：本地可用闭环

- 将现有 Grok 实现迁移为最小 Grok ACP Adapter，由 AgentService 持有 Task/Turn/session 绑定，由 TaskExecutor 持有活动执行槽；
- 建立 Project、Task、Turn、Execution Environment 与版本化历史；
- 建立可实施的 Permission Broker、后台生命周期和实时/历史一致时间线；
- 完成单 Runtime Task 工作台；
- 把 Grok Build 作为大脑可视化：斜杠命令板、插件整页、设置中的记忆与 MCP（桌面配置，Grok 执行）；
- 建立 AppCommandRunner、Runtime 命令证据、Git 基线、Diff 和 Validation 事实链；
- 在新 Adapter 边界上复核现有 Provider、凭据、配置和工具子进程 Secret 隔离。

P0-A 必须先用 Grok Runtime 证明一个真实 Local Task 可以跨多个 Turn 持续执行，Task A → Task B → Task A 能恢复正确上下文，切换页面不终止后台任务，命令、权限、Diff 和验证结果都有可追溯事实。

#### P0-B：隔离交付闭环

- 建立只支持文本、Markdown、图片和 Changes Diff 引用的基础 Artifact Registry/Viewer；
- 提供受管 Git Worktree，所有 Runtime、Git Review 和 Artifact 都绑定同一 execution root；
- 支持导出 tracked/untracked 结果包和 base commit manifest；
- 支持在 Finder/终端打开受管 Worktree，但不自动应用回原项目、合并、提交或推送。

P0-B 完成后，用户才真正拥有“隔离执行 → 审阅 → 带走结果”的首个 Codex-style 桌面交付闭环。第二个 Runtime 不应成为这条闭环成立的前置条件；终端、并行调度和更广泛的 Artifact 类型仍按 P0+ 单独验收。

#### P0+：非首版阻塞增强

- 用户交互式 Task Terminal；
- 使用 sandboxed `WebContentsView` 的隔离 HTML Preview；
- 多任务队列与有界并行调度。

P0+ 不共同阻塞 P0-A/P0-B；只有确实需要交互终端、HTML 或并行调度的后续计划才依赖对应能力。

### P1：开放模型配置

- 管理 Provider 和模型配置；
- 支持 Base URL、API Key、Model ID 和协议类型；
- 优先接入 OpenRouter、Ollama 和自建兼容服务；
- 让 Grok Runtime 可以选择 App 管理的模型配置；
- 增加模型兼容性体检；
- 明确展示能力和成本差异。

P1-01 至 P1-05 已有单 Provider 实现基线，需要在新的 AgentService 边界上复核和补强；P1-06 至 P1-08 扩展模型来源和兼容深度，但不得阻塞 P0 的单 Runtime 工作台闭环。

### P2：接入 Codex app-server（当前暂缓，先打磨 Grok 宿主）

- 使用 Agent Studio `userData` 下的独立 `CODEX_HOME` 完成 binary、schema、app-server 生命周期和 ChatGPT 账号认证，不触碰用户默认 `~/.codex`；
- 将 Thread、Turn、Item、Plan、Usage 和原生恢复绑定到产品 Task/Turn，fork 创建新 Task 而不是覆盖原 Task；
- 先支持 account-backed Codex，App Provider 作为协议、模型健康和 Secret 隔离均验证后的条件分支；
- 先交付单执行槽 Runtime 选择与启动，再把不可变启动快照接入队列和有界并行；
- 将命令执行、审批、文件变化、Diff 和 Artifact 映射到既有 Permission、Command Evidence、Changes 和 Artifact 服务，不复制第二套工作台。

### P3：插件能力中心

- Capability Manifest、ActionDescriptor 与 Registry；
- Capability Executor 与核心 Permission Broker 接入；
- MCP 和 Skills；
- 插件管理器；
- Capability 对既有 Timeline、Command Evidence、Changes、Validation 与 Artifact 的结果路由；
- 受管浏览器；
- Chrome 控制；
- macOS Computer Use；
- 权限和审计中心。

### P4：多大脑协作

- 双脑对比；
- 大脑接力；
- 自动路由；
- 多 Runtime 任务编排；
- 基于 P0 Task Worktree 的公平对比与接力；
- 成本、速度、质量和成功率评估。

## 12. 当前非目标

为了保持项目节奏，当前明确不做以下承诺：

- 第一阶段完整复刻 VS Code；
- 第一阶段复制 Codex Desktop 的全部 UI 和插件；
- 宣称所有 OpenAI 兼容模型都支持完整 Agent 工作流；
- 在统一抽象稳定前同时接入大量 Runtime；
- 为一次性需求提前建设复杂插件市场；
- 绕过操作系统或浏览器的安全权限；
- 复制 Codex、Chrome 或其他产品的私有实现；
- 自动执行不可恢复的高风险操作；
- 让多大脑协作阻塞单大脑的基础体验。
- 把 Agent Studio 做成第二套 Agent：自己规划、自己跑 MCP、自己写记忆引擎。

## 13. 第一阶段成功标准

第一阶段不以插件数量或界面按钮数量衡量成功，而以完整闭环衡量：

> 用户可以在同一个桌面应用中打开本地项目，创建可持续多轮执行的 Task，让一个真实可用的 Runtime 在 Local 或隔离 Worktree 中完成代码任务，并在应用内查看进度、审批敏感操作、审阅文件与验证结果、打开基础 Artifact、导出或打开隔离结果，以及重新打开或继续任务。

进一步的质量指标包括：

- 首次环境连接成功率；
- 首个任务成功率；
- 模型工具调用兼容率；
- 用户能够正确理解 Agent 操作的比例；
- 修改可审阅、可验证；满足基线、环境和内容一致性条件时可撤回，否则明确说明不能自动撤回；
- 切换项目或 Task 不会让正在运行的任务静默丢失；
- 用户已有脏改动与本任务新增修改可以明确区分；
- 结果包可以追溯到明确 base commit，并覆盖 tracked/untracked 修改；系统不会自动应用、合并、提交或推送；
- 若启用 P0+ 并行调度，并行写任务只在执行环境隔离、Runtime 能力和资源上限均满足时启动；
- Runtime 和插件故障不会导致权限扩大或密钥泄露。

## 14. 待讨论问题

以下问题暂时保留，不在本版文档中强行决定：

1. 产品优先服务专业开发者，还是逐步覆盖通用电脑 Agent 用户？
2. Agent Studio 是否作为最终正式品牌名称？
3. 哪些 Runtime 与 Provider 组合由项目官方维护？
4. Provider 配置是否直接管理 Grok、Codex 的原生配置，还是使用 App 独立配置目录？
5. 不同 Runtime 的原生恢复能力应开放到什么粒度，哪些失败状态只允许查看而不能继续？
6. 插件主要以 MCP、独立进程协议还是未来自定义 SDK 接入？
7. Chrome 首期使用独立 Profile，还是连接用户现有登录态？
8. Computer Use 首期是否只支持 macOS？
9. 哪些权限可以项目级长期授权，哪些必须逐次审批？
10. 双脑任务如何隔离修改、限制成本并公平比较结果？
11. 插件是否允许第三方发布，如何完成签名、审核和撤回？
12. 项目是否完全开源，哪些高权限组件需要独立维护？

## 15. 文档演进原则

- 新想法先记录，再判断是否进入路线图；
- 已验证事实和产品设想必须明确区分；
- 协议能力以当前版本官方文档和实际测试为准；
- 技术实现确定后再进入独立架构文档；
- 每次加入大型能力前，检查是否破坏 Runtime、Provider、Capability 和 Permission 的分层；
- 优先完成真实闭环，不用按钮数量制造虚假完成度。

## 16. 想法记录

### 2026-08-07

- 将产品工作名从 Grok Build Desktop 调整为 Agent Studio，以体现多大脑、多模型和多能力的开放定位；
- 明确项目不是 Grok Build 的简单桌面壳，而是多大脑本地 AI 工作台；
- 确定首先支持 Grok Build，计划接入 Codex app-server；
- 将账号登录和模型服务配置分开；
- 计划支持用户自定义 OpenAI 兼容模型服务，降低模型使用门槛；
- 将浏览器、Chrome、Computer Use、MCP 和 Skills 作为独立能力层；
- 确定所有 Runtime 和插件共用统一权限、安全与审计机制；
- 将双脑对比、大脑接力和自动路由列为长期差异化方向。

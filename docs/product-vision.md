# Agent Studio 产品愿景

> 状态：讨论草案
> 创建日期：2026-08-07
> 核心共识：多 Agent Runtime × 多 Model Provider × 多 Capability Pack

## 1. 文档目的

本文用于沉淀 Agent Studio 当前阶段的产品共识、边界和演进方向。

它不是最终技术设计，也不代表其中所有能力都已经进入开发。项目将按照“先建立正确边界，再逐步扩展能力”的原则推进，后续讨论形成的新共识继续补充到本文；当具体技术方案稳定后，再拆分独立的架构和协议文档。

## 2. 产品愿景

Agent Studio 不应只是 Grok Build 的桌面外壳，也不以复刻 Codex Desktop 的界面为最终目标。

我们的目标是打造一个以本地桌面应用为入口，能够切换、组合和管理不同 Agent 大脑，自由配置模型服务，并通过插件获得浏览器、电脑和开发工具操作能力的 AI 工作台。

一句话定位：

> 一个支持多种代码 Agent 大脑、开放模型配置、可扩展桌面能力，并对执行过程进行透明审阅与安全控制的本地 AI 工作台。

产品的核心组合关系是：

```text
Agent Runtime × Model Provider × Capability Pack
```

- **Agent Runtime** 决定 Agent 如何思考、规划和执行任务。
- **Model Provider** 决定实际使用哪个模型、接口和计费服务。
- **Capability Pack** 决定 Agent 能操作哪些外部工具和桌面环境。
- **Security & Governance** 统一负责权限、密钥、审计和回滚。

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
会话 / 任务 / 事件 / 审批 / Diff / 历史
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

后续需要逐步将现有 `GrokAgentBridge`、`grok:*` IPC 和 `Grok*` 共享类型迁移为中性的 Agent 领域模型，再由 `GrokAcpAdapter` 负责协议适配。

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

### 7.1 第一阶段能力

- 文件读取和修改；
- 终端执行；
- Git 状态、Diff、检查点和回滚；
- MCP Server；
- Skills；
- 项目识别和环境体检。

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

无论操作来自 Grok、Codex 还是插件，都必须经过统一的 Permission Broker。

大脑可以提出操作请求，但不能自行扩大权限范围。

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
选择项目
→ 环境和 Runtime 体检
→ 选择 Agent 大脑
→ 选择模型服务与模型
→ 选择能力包和权限策略
→ 输入任务或选择任务模板
→ 查看执行时间线
→ 审批敏感操作
→ 查看 Diff、测试和成本
→ 接受、拒绝或撤销修改
→ 保存并恢复任务记录
```

用户需要随时看见：

- 当前使用的大脑和模型；
- Agent 正在执行的步骤；
- 已读取、修改和运行的内容；
- 当前 Token、费用和耗时；
- 哪些权限已授予；
- 最终修改、验证和风险摘要。

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
- 用户可以在任务中途主动切换大脑。

### 10.3 自动路由

未来可以根据任务类型、模型能力、历史成功率、费用和速度，为任务推荐或自动选择 Runtime 与模型组合。

这些能力属于中长期方向，不应阻塞单大脑基础闭环和统一抽象的稳定性。

## 11. 分阶段路线

### P0：统一核心骨架

- 抽象统一 Agent Backend；
- 将现有 Grok 实现迁移为 Grok ACP Adapter；
- 将 IPC 和共享类型从 Grok 专属命名迁移为 Agent 通用命名；
- 建立统一事件模型；
- 建立 Runtime 能力矩阵；
- 明确 Runtime、Provider、Capability 和 Permission 四层；
- 使用系统安全存储保存密钥。

### P1：开放模型配置

- 管理 Provider 和模型配置；
- 支持 Base URL、API Key、Model ID 和协议类型；
- 优先接入 OpenRouter、Ollama 和自建兼容服务；
- 让 Grok Runtime 可以选择 App 管理的模型配置；
- 增加模型兼容性体检；
- 明确展示能力和成本差异。

这是距离当前实现最近，也最容易让用户直接感受到价值的阶段。

### P2：接入 Codex app-server

- Codex Runtime 状态和认证；
- Model Provider 与模型选择；
- Thread、Turn 和 Item；
- 历史恢复；
- Plan；
- 命令执行；
- 文件变更和 Diff；
- 审批与 Usage；
- 映射为统一 UI 事件。

### P3：插件能力中心

- 插件 Manifest；
- MCP 和 Skills；
- 插件管理器；
- Capability Broker；
- Permission Broker；
- 受管浏览器；
- Chrome 控制；
- macOS Computer Use；
- 权限和审计中心。

### P4：多大脑协作

- 双脑对比；
- 大脑接力；
- 自动路由；
- 多任务并行；
- 隔离 Git worktree；
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

## 13. 第一阶段成功标准

第一阶段不以插件数量或界面按钮数量衡量成功，而以完整闭环衡量：

> 用户可以在同一个桌面应用中选择 Agent Runtime，配置一个真实可用的模型，安全地发起代码任务，查看执行过程，审批敏感操作，审阅文件变更，并保存或恢复任务记录。

进一步的质量指标包括：

- 首次环境连接成功率；
- 首个任务成功率；
- 模型工具调用兼容率；
- 用户能够正确理解 Agent 操作的比例；
- 修改可审阅、可验证、可撤回；
- Runtime 和插件故障不会导致权限扩大或密钥泄露。

## 14. 待讨论问题

以下问题暂时保留，不在本版文档中强行决定：

1. 产品优先服务专业开发者，还是逐步覆盖通用电脑 Agent 用户？
2. Agent Studio 是否作为最终正式品牌名称？
3. 哪些 Runtime 与 Provider 组合由项目官方维护？
4. Provider 配置是否直接管理 Grok、Codex 的原生配置，还是使用 App 独立配置目录？
5. 会话历史由桌面端统一保存，还是优先依赖各 Runtime？
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

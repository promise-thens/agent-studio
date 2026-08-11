# P1-07 Provider 协议 Profile 与兼容契约 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P1 / 权重 4（Provider 协议事实与 Runtime 兼容边界）

**目标：** 为 Chat Completions、Responses、Anthropic Messages 和已验证的本地协议建立显式注册表、协议专属测试器与中性兼容契约，使 Provider Profile 能准确说明“实现了什么协议”，Runtime 只绑定其真实支持的组合。

**核心数据流：** Provider Profile 保存 `protocolKind` 与公开能力摘要；主进程协议注册表选择对应的请求构造、响应解析和错误分类器；Tester 产生有版本的 `ProviderProtocolEvidence`；Runtime Adapter 在自身存在后注册兼容要求，Task 启动服务再用 Profile、证据和 Runtime requirement 生成允许、实验性或阻止结论。

**约束与边界：** 本计划只建设协议注册表、测试器和兼容契约，不提前实现尚不存在的 Codex Provider binding；Grok 可以消费已存在 Adapter 的兼容声明，Codex 实际绑定由 P2-04A 的 `app-provider` 分支完成。不宣称“支持全部 OpenAI 兼容模型”，不做万能转发代理，不允许 Renderer 自定义 Header、Query Secret、请求模板或协议实现。

**主要风险：** 相同路径或字段名可能具有不同语义，基础 HTTP 成功也可能不支持流式、工具或 Agent 工作流；每个协议必须使用独立 schema、Mock fixture、能力证据和失效规则，未知协议绝不携带凭据试探。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；协议事实以当期官方 schema 与本地 Mock/实测证据为准。

---

## 实施范围

**前置依赖：**

- 依赖 P1-06；不依赖 P2-01 或任何尚未存在的 Codex Adapter。

**文件范围：**

- 创建 `src/shared/provider-protocol.ts`，只包含可序列化的协议种类、公开能力摘要、证据引用和有限错误码。
- 创建 `src/main/provider/protocols/protocol-registry.ts`、协议专属 tester/parser 及就近测试。
- 修改 Provider Profile store、Provider Tester、设置页协议展示和 P1-05 Grok binding 的兼容声明。
- Codex binding 不在本文件范围内；P2-04A 只在 Codex Adapter 已存在且协议证据满足时注册其 `app-provider` 分支。

**安全策略：**

- 请求 URL、认证承载和请求体由注册表固定实现，Renderer 只提交 Profile ID 和公开测试选项。
- Secret 继续从主进程 Provider Store 解析，不进入 shared DTO、Renderer、日志或测试快照。
- 未知协议、未知认证承载、origin 漂移、证据过期或 schema 不匹配时，在发送带凭据请求前拒绝。
- 所有响应、错误和诊断先限长、脱敏，再生成公开证据摘要。

### 任务 1: 冻结协议注册表与公开契约

**任务目标：**

- 让每个 Profile 的协议、认证方式、模型发现和能力边界可机械判断。

**涉及范围：**

- 共享协议 DTO、主进程注册表、Profile migration 和契约测试。

**前置依赖：**

- P1-06 已提供多 Profile 身份、版本和存储边界。

- [ ] **第 1 步: 定义协议种类与版本**

说明：定义有限的 `protocolKind`、schemaVersion、认证承载、模型发现方式、最小连通请求、流式、工具调用和 Usage 能力；没有实测实现的种类只能存在于枚举或迁移状态，不能标记 enabled。

预期：任一 Profile 都能说明使用哪种协议、证据版本和已验证能力，不存在含义模糊的“OpenAI compatible”。

- [ ] **第 2 步: 定义 ProviderProtocolEvidence**

说明：证据至少包含 profileId、origin、protocolKind、testerVersion、modelId、验证范围、成功/失败分类、能力摘要、verifiedAt、expiresAt 和公开诊断；不保存 Key、Header、完整响应或 Prompt。

预期：origin、协议、模型或 tester 版本变化后旧证据自动失效，不能被其它 Profile 复用。

- [ ] **第 3 步: 定义 RuntimeProviderRequirement**

说明：兼容契约表达 Runtime 接受的 binding kind、protocolKind、必需能力、可选能力和最低证据级别，不包含 Grok/Codex UI 文案或协议私有 payload。

预期：未来 Runtime 只有在 Adapter 真正存在时注册 requirement；P1-07 不反向依赖 P2。

### 任务 2: 实现协议专属 Tester

**任务目标：**

- 用各协议真实请求/响应语义替代通用 URL 拼接和猜测。

**涉及范围：**

- 协议 tester、parser、错误分类、Mock server 和测试。

**前置依赖：**

- 依赖任务 1 的注册表和证据结构。

- [ ] **第 1 步: 保留并收紧 Chat Completions Tester**

说明：把当前 `/models`、手动 modelId 和 `/chat/completions` 验证迁入独立策略，继续覆盖 401/403、404、429、超时、错误结构、流式差异与脱敏。

预期：现有 Grok Provider 基线不回归，基础聊天成功仍只形成对应级别证据。

- [ ] **第 2 步: 按官方 schema 增加其它协议**

说明：Responses、Anthropic Messages 或本地协议分别拥有独立请求 builder、响应 parser、模型发现策略和 fixture；只有官方 schema 与本地 Mock 验证完整后才启用。

预期：不同协议不共享含义不一致的字段，也不会用 Chat Completions 成功推断 Responses 或工具能力。

- [ ] **第 3 步: 固定失败和未知处理**

说明：将认证失败、协议不匹配、模型不存在、能力缺失、限流、超时、上游错误和 malformed response 映射为有限错误码；未知协议在网络请求前拒绝。

预期：失败可理解、可修复且不泄漏响应、请求 Header 或 Secret。

### 任务 3: 建立 Runtime 兼容评估

**任务目标：**

- 让 Runtime/Profile 组合由主进程统一判断，而不是由设置页或 Adapter 试错。

**涉及范围：**

- compatibility evaluator、Grok requirement、能力矩阵和测试。

**前置依赖：**

- 依赖任务 1、任务 2 的 requirement 与证据。

- [ ] **第 1 步: 实现兼容评估器**

说明：输入 Runtime requirement、Profile 公开摘要和 Protocol Evidence，输出 allowed、experimental 或 blocked，以及证据版本、失效时间和有限原因；评估器不读取明文 Key。

预期：协议不匹配、证据缺失/过期和能力不足在 Runtime 启动前被识别。

- [ ] **第 2 步: 注册 Grok 现有兼容要求**

说明：P1-05 的 Grok binding 声明其已验证协议和 Agent 工作流要求，不能把“基础接口可调用”提升为完整 ACP 兼容。

预期：Grok 只消费真实验证过的 Profile，现有单 Provider 路径保持可用。

- [ ] **第 3 步: 保留未来 Runtime 注册点**

说明：注册表允许 Adapter 在接入后提供 requirement；本任务不导入 `runtime/codex`，也不写 Codex 配置。P2-04A 负责 Codex `app-provider` 的具体生成与 Secret 隔离验证。

预期：P1-07 与 P2-01 无依赖循环，新增 Runtime 不需要复制协议测试器。

### 任务 4: 完成 Profile 展示与回归验证

**任务目标：**

- 让用户看见真实协议、证据和限制，而不暴露内部请求或凭据。

**涉及范围：**

- Provider 设置页、Profile 摘要、组件测试和 Electron 走查。

**前置依赖：**

- 依赖任务 1 至任务 3。

- [ ] **第 1 步: 展示协议与验证范围**

说明：Profile 显示 protocolKind、实际模型标签、最近验证时间、已验证能力和限制；未知、过期和 experimental 状态使用持续提示。

预期：用户不会把模型营销名、Runtime 名或 Provider 别名误认为协议证据。

- [ ] **第 2 步: 提供可修复失败路径**

说明：协议不匹配时指向正确 Profile/测试入口；origin 变化要求重新输入 Key，未知协议不提供“仍然尝试”按钮。

预期：UI 不自己重写兼容结论，也不发送旧 Secret 到新 origin。

- [ ] **第 3 步: 完成协议矩阵测试**

说明：覆盖各协议成功、认证失败、404、429、超时、malformed response、错误协议、过期证据、origin 漂移和 Grok requirement 不匹配。

预期：每种组合都得到稳定结论，网络请求次数和 Secret 使用可核对。

## 验收标准

- [ ] Profile 能明确说明 protocolKind、验证范围、证据版本和限制；未知协议不会携带凭据猜测请求。
- [ ] Chat Completions、Responses、Anthropic Messages 和启用的本地协议使用独立 tester/parser，不以基础接口成功推断工具或 Agent 工作流兼容。
- [ ] Runtime 兼容评估只消费公开摘要和证据；Secret 仍只存在于主进程 Provider Store。
- [ ] P1-07 只建设注册表、测试器和兼容契约，不提前实现 Codex binding，也不依赖 P2-01。
- [ ] Grok requirement 与现有能力证据一致；Codex `app-provider` 由 P2-04A 在 Adapter 存在后条件接入。
- [ ] 新增核心函数、协议 parser、Secret/URL 边界和异常降级均有中文 TSDoc；测试只使用假 Key 和本地 Mock。
- [ ] Node.js 20+、pnpm 10.x 下通过目标/完整 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check`，并完成 Profile 协议展示 Electron 走查。

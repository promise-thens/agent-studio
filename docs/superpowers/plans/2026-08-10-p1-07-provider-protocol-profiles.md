# P1-07 Provider 协议 Profile 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P1 / 权重 4（兼容性边界）

**目标：** 显式区分 Chat Completions、Responses、Anthropic Messages 和本地自定义协议，让 Runtime 只选择其真实可用的 Profile。

**核心数据流：** Profile 声明 protocolKind 与受限配置；Tester 按协议执行对应请求；Runtime 能力检查匹配支持的协议，再生成配置或拒绝绑定。

**约束与边界：** 不宣称“全部 OpenAI 兼容”；不把自定义 Header/Query Secret 暴露给 Renderer；首期只实现已确认的协议，不做万能转发代理。

**主要风险：** 同名接口语义不同导致工具调用失败；每种协议独立请求/响应 schema 与 capability 声明，失败明确归类为协议不兼容。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P1-06；Codex Runtime 接入前完成 Responses 分型。

**文件范围：**
- 新增 `src/shared/provider-protocol.ts`、`src/main/provider/protocols/` 下实现与测试；修改 Profile store、Tester、Grok/Codex binding。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 冻结协议注册表

**任务目标：**
- 为每种 protocolKind 定义认证承载、模型发现、最小请求、流式和工具能力的明确契约。

**涉及范围：**
- 新增 `src/shared/provider-protocol.ts`、`src/main/provider/protocols/` 下实现与测试；修改 Profile store、Tester、Grok/Codex binding。

**前置依赖：**
- 依赖 P1-06；Codex Runtime 接入前完成 Responses 分型。

- [ ] **第 1 步: 落地本任务**
说明：为每种 protocolKind 定义认证承载、模型发现、最小请求、流式和工具能力的明确契约。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不宣称“全部 OpenAI 兼容”；不把自定义 Header/Query Secret 暴露给 Renderer；首期只实现已确认的协议，不做万能转发代理。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 拆分测试器实现

**任务目标：**
- 将当前 Chat Completions 测试保留为独立策略；新增 Responses 等协议只在 mock 与官方 schema 验证后启用。

**涉及范围：**
- 新增 `src/shared/provider-protocol.ts`、`src/main/provider/protocols/` 下实现与测试；修改 Profile store、Tester、Grok/Codex binding。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：将当前 Chat Completions 测试保留为独立策略；新增 Responses 等协议只在 mock 与官方 schema 验证后启用。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不宣称“全部 OpenAI 兼容”；不把自定义 Header/Query Secret 暴露给 Renderer；首期只实现已确认的协议，不做万能转发代理。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 约束 Runtime 绑定

**任务目标：**
- Grok 与 Codex 分别声明接受的协议集合，选择不匹配 Profile 时提供可理解阻止而非试错。

**涉及范围：**
- 新增 `src/shared/provider-protocol.ts`、`src/main/provider/protocols/` 下实现与测试；修改 Profile store、Tester、Grok/Codex binding。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：Grok 与 Codex 分别声明接受的协议集合，选择不匹配 Profile 时提供可理解阻止而非试错。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不宣称“全部 OpenAI 兼容”；不把自定义 Header/Query Secret 暴露给 Renderer；首期只实现已确认的协议，不做万能转发代理。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 任何 Profile 都能看出协议类型及限制；Codex 不会接受仅 Chat Completions 的配置；未知协议不会发送带凭据的猜测请求。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

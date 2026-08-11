# P1-03 Provider 模型发现与最小连通验证 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P1 / 权重 4（已有实现，扩展前复核）

**目标：** 将模型列表发现和最小推理验证固化为可解释的 Provider 连通性能力，不把“能请求”误称为 Agent 兼容。

**核心数据流：** 主进程取得经校验的 Profile 与临时凭据；Tester 请求模型列表或执行选择模型的最小调用；返回结构化测试阶段、模型选项和脱敏失败原因。

**约束与边界：** 模型显示仅使用 `displayName ?? modelId`；`/models` 失败允许手填；真实自动测试只使用 local mock，不调用付费服务。

**主要风险：** 兼容服务返回不同结构或无 `/models`；解析器限制响应大小、去重并保留手填路径，区分 401/403/404/429/超时。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P1-01、P1-02。

**文件范围：**
- 复核 `src/main/provider/provider-connection-tester.ts` 与测试、`src/shared/provider.ts`、`ModelSelector.vue`。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 核对阶段与错误码

**任务目标：**
- 确认 validation、models、inference 的成功条件与认证/限流/协议错误的用户说明相符。

**涉及范围：**
- 复核 `src/main/provider/provider-connection-tester.ts` 与测试、`src/shared/provider.ts`、`ModelSelector.vue`。

**前置依赖：**
- 依赖 P1-01、P1-02。

- [ ] **第 1 步: 落地本任务**
说明：确认 validation、models、inference 的成功条件与认证/限流/协议错误的用户说明相符。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 模型显示仅使用 `displayName ?? modelId`；`/models` 失败允许手填；真实自动测试只使用 local mock，不调用付费服务。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 适配 Profile 上下文

**任务目标：**
- 让测试器接收 profileId 对应的受限 runtime config，不在 Renderer 或事件中传递 Key。

**涉及范围：**
- 复核 `src/main/provider/provider-connection-tester.ts` 与测试、`src/shared/provider.ts`、`ModelSelector.vue`。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：让测试器接收 profileId 对应的受限 runtime config，不在 Renderer 或事件中传递 Key。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 模型显示仅使用 `displayName ?? modelId`；`/models` 失败允许手填；真实自动测试只使用 local mock，不调用付费服务。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 扩充 mock 覆盖

**任务目标：**
- 覆盖缺失 models、异常 JSON、超大响应、401/403、404、429、超时与手填模型。

**涉及范围：**
- 复核 `src/main/provider/provider-connection-tester.ts` 与测试、`src/shared/provider.ts`、`ModelSelector.vue`。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：覆盖缺失 models、异常 JSON、超大响应、401/403、404、429、超时与手填模型。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 模型显示仅使用 `displayName ?? modelId`；`/models` 失败允许手填；真实自动测试只使用 local mock，不调用付费服务。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 用户能分辨 URL/认证/模型发现/最小推理在哪一步失败；模型名称不被拼接 Runtime 前缀；测试结果不泄漏请求 Header。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

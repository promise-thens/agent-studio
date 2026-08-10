# P0-05 Grok ACP Adapter 迁移 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0 / 权重 5（保住已用闭环并建立适配器样板）

**目标：** 把 `GrokAgentBridge` 收敛为只负责 ACP 生命周期和协议转换的 `GrokAcpAdapter`，让产品层不再依赖 Grok 专名。

**核心数据流：** Agent 服务按 runtimeId 选择 Grok Adapter；Adapter 连接 ACP、转换事件与权限；统一服务经 Agent IPC 把中性状态交给 Renderer。

**约束与边界：** 本期只抽现有 Grok 实现，不引入第二套 Runtime 目录之外的泛化框架；ACP 消息、GROK_HOME 和专属错误只停留在 Grok 目录。

**主要风险：** 迁移改坏停止、权限或工具状态；以现有 ACP mock 测试覆盖连接、发送、取消、权限、断开五条路径，并采用小步替换。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P0-01 至 P0-04。

**文件范围：**
- 移动/修改 `src/main/grok-agent.ts` 为 `src/main/runtime/grok/grok-acp-adapter.ts`；新增 `src/main/agent/agent-service.ts` 与对应测试；调整 `src/main/index.ts`。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 冻结当前行为清单

**任务目标：**
- 记录连接、选目录、创建会话、发送任务、权限、取消与断开的可观测输入输出，作为迁移回归基线。

**涉及范围：**
- 移动/修改 `src/main/grok-agent.ts` 为 `src/main/runtime/grok/grok-acp-adapter.ts`；新增 `src/main/agent/agent-service.ts` 与对应测试；调整 `src/main/index.ts`。

**前置依赖：**
- 依赖 P0-01 至 P0-04。

- [ ] **第 1 步: 落地本任务**
说明：记录连接、选目录、创建会话、发送任务、权限、取消与断开的可观测输入输出，作为迁移回归基线。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 本期只抽现有 Grok 实现，不引入第二套 Runtime 目录之外的泛化框架；ACP 消息、GROK_HOME 和专属错误只停留在 Grok 目录。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 抽取 Adapter 与服务

**任务目标：**
- 定义最小 `AgentRuntimeAdapter` 接口，Grok Adapter 只实现已验证方法，统一服务持有任务状态。

**涉及范围：**
- 移动/修改 `src/main/grok-agent.ts` 为 `src/main/runtime/grok/grok-acp-adapter.ts`；新增 `src/main/agent/agent-service.ts` 与对应测试；调整 `src/main/index.ts`。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：定义最小 `AgentRuntimeAdapter` 接口，Grok Adapter 只实现已验证方法，统一服务持有任务状态。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 本期只抽现有 Grok 实现，不引入第二套 Runtime 目录之外的泛化框架；ACP 消息、GROK_HOME 和专属错误只停留在 Grok 目录。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 完成迁移验证

**任务目标：**
- 替换注册和事件出口，运行 Adapter 单测及开发版手工任务；确认原 `grok:*` 业务入口不再被 Renderer 调用。

**涉及范围：**
- 移动/修改 `src/main/grok-agent.ts` 为 `src/main/runtime/grok/grok-acp-adapter.ts`；新增 `src/main/agent/agent-service.ts` 与对应测试；调整 `src/main/index.ts`。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：替换注册和事件出口，运行 Adapter 单测及开发版手工任务；确认原 `grok:*` 业务入口不再被 Renderer 调用。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 本期只抽现有 Grok 实现，不引入第二套 Runtime 目录之外的泛化框架；ACP 消息、GROK_HOME 和专属错误只停留在 Grok 目录。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] Grok 首个任务闭环、权限与停止功能不回归；共享类型和 Renderer 不出现 ACP 字段；Grok 专属配置不写入 Provider 通用模块。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

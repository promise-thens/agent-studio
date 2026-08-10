# P1-05 Grok Provider Runtime 绑定复核 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P1 / 权重 5（已有实现，密钥边界关键）

**目标：** 让 Grok ACP 仅消费 App 管理、已验证的 Provider runtime config，同时隔离用户 `~/.grok` 与 Agent 工具子进程环境。

**核心数据流：** Agent 服务取主进程解密后的临时 Provider 配置；Grok Adapter 写 App 专属临时配置并以最小环境启动 ACP；工具子进程使用剥离模型密钥的环境。

**约束与边界：** 不修改 `~/.grok`，不改全局 `process.env`，不让 Bash/Terminal 继承模型 Key；只支持已验证协议，不将基础连通等同完整工作流。

**主要风险：** origin 切换期间错误复用旧 Key 或子进程继承环境；将 config 生成、连接、回滚视为同一事务并通过环境白名单验证。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P1-01、P1-02、P1-03；依赖 P0-05 的 Adapter 迁移。

**文件范围：**
- 复核 `src/main/provider/grok-provider-config.ts`、`src/main/grok-agent.ts`/迁移后 Adapter、相关测试与 `src/main/index.ts`。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 复核配置生成边界

**任务目标：**
- 检查生成位置、文件权限、清理、TOML escaping 与错误脱敏，确认绝不写用户原配置。

**涉及范围：**
- 复核 `src/main/provider/grok-provider-config.ts`、`src/main/grok-agent.ts`/迁移后 Adapter、相关测试与 `src/main/index.ts`。

**前置依赖：**
- 依赖 P1-01、P1-02、P1-03；依赖 P0-05 的 Adapter 迁移。

- [ ] **第 1 步: 落地本任务**
说明：检查生成位置、文件权限、清理、TOML escaping 与错误脱敏，确认绝不写用户原配置。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不修改 `~/.grok`，不改全局 `process.env`，不让 Bash/Terminal 继承模型 Key；只支持已验证协议，不将基础连通等同完整工作流。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 迁移到 Grok Adapter

**任务目标：**
- 将 Provider runtime config 作为受限依赖注入 Adapter，禁止 Renderer 或 Grok UI 文案反向依赖 Provider 实现。

**涉及范围：**
- 复核 `src/main/provider/grok-provider-config.ts`、`src/main/grok-agent.ts`/迁移后 Adapter、相关测试与 `src/main/index.ts`。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：将 Provider runtime config 作为受限依赖注入 Adapter，禁止 Renderer 或 Grok UI 文案反向依赖 Provider 实现。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不修改 `~/.grok`，不改全局 `process.env`，不让 Bash/Terminal 继承模型 Key；只支持已验证协议，不将基础连通等同完整工作流。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 验证隔离和回滚

**任务目标：**
- 用假 Key 检查 ACP 启动环境与工具子进程环境；模拟切换失败，确认旧运行配置与 UI 摘要一致。

**涉及范围：**
- 复核 `src/main/provider/grok-provider-config.ts`、`src/main/grok-agent.ts`/迁移后 Adapter、相关测试与 `src/main/index.ts`。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：用假 Key 检查 ACP 启动环境与工具子进程环境；模拟切换失败，确认旧运行配置与 UI 摘要一致。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不修改 `~/.grok`，不改全局 `process.env`，不让 Bash/Terminal 继承模型 Key；只支持已验证协议，不将基础连通等同完整工作流。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] Grok 能使用受管 Provider 完成已验证的任务；用户原始 Grok 配置不变；运行和工具环境均无多余模型密钥。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

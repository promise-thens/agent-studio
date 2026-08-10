# P2-01 Codex Runtime 认证与生命周期 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P2 / 权重 5（第二 Runtime 的入口）

**目标：** 接入 Codex app-server 的启动、版本协商、账号状态、连接、断连和故障恢复，保持与 Provider 配置概念分离。

**核心数据流：** Agent 服务按 runtimeId 启动受控 app-server 子进程；Codex Adapter 完成初始化并映射账号/连接状态；Renderer 只看摘要并经 agent IPC 发起操作。

**约束与边界：** 不读取或修改用户全局 Codex 配置；账号登录与 API Provider 配置分开；不把 app-server 原始 stdout/stderr 或环境传 Renderer。

**主要风险：** 版本/API 漂移和子进程悬挂；锁定已验证版本范围、握手超时、受控重启、stderr 脱敏与明确“不兼容”状态。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P0-01 至 P0-04、P1-07。

**文件范围：**
- 新增 `src/main/runtime/codex/codex-app-server-adapter.ts`、`codex-process.ts`、测试；修改 Agent service、能力矩阵和设置 UI。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 确定官方协议基线

**任务目标：**
- 以当前 app-server schema 和本机实际版本记录初始化、认证状态、版本协商和关闭语义，不从 UI 推断 API。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-app-server-adapter.ts`、`codex-process.ts`、测试；修改 Agent service、能力矩阵和设置 UI。

**前置依赖：**
- 依赖 P0-01 至 P0-04、P1-07。

- [ ] **第 1 步: 落地本任务**
说明：以当前 app-server schema 和本机实际版本记录初始化、认证状态、版本协商和关闭语义，不从 UI 推断 API。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不读取或修改用户全局 Codex 配置；账号登录与 API Provider 配置分开；不把 app-server 原始 stdout/stderr 或环境传 Renderer。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现受控进程与 Adapter

**任务目标：**
- 使用最小环境、输入输出大小限制、超时和退出清理；映射连接/认证/故障到中性状态。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-app-server-adapter.ts`、`codex-process.ts`、测试；修改 Agent service、能力矩阵和设置 UI。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：使用最小环境、输入输出大小限制、超时和退出清理；映射连接/认证/故障到中性状态。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不读取或修改用户全局 Codex 配置；账号登录与 API Provider 配置分开；不把 app-server 原始 stdout/stderr 或环境传 Renderer。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 验证生命周期

**任务目标：**
- 用 mock server 和开发版测试首次连接、已登录、未登录、版本不匹配、崩溃重启与主动断开。

**涉及范围：**
- 新增 `src/main/runtime/codex/codex-app-server-adapter.ts`、`codex-process.ts`、测试；修改 Agent service、能力矩阵和设置 UI。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：用 mock server 和开发版测试首次连接、已登录、未登录、版本不匹配、崩溃重启与主动断开。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不读取或修改用户全局 Codex 配置；账号登录与 API Provider 配置分开；不把 app-server 原始 stdout/stderr 或环境传 Renderer。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] Codex 未登录或不兼容时不会伪装为可用；进程退出能清理状态；凭据和原始日志不越过主进程。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

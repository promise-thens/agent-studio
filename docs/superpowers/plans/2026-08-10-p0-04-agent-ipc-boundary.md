# P0-04 中性 Agent IPC 边界 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0 / 权重 5（主进程安全与多 Runtime 的阻塞性基础）

**目标：** 将现有 `grok:*` 业务调用收敛为类型化、窄范围的 `agent:*` IPC，并在主进程统一校验调用者和参数。

**核心数据流：** Renderer 调用 `window.agent` 的静态方法；Preload 将类型化参数发送到固定 channel；主进程验证来源、大小和 task 状态，再委托 Runtime 服务并返回脱敏摘要。

**约束与边界：** 保持 `contextIsolation` 与 sandbox；不暴露 `ipcRenderer`、通用 invoke、文件系统或 Runtime 原对象；Provider IPC 保持独立。

**主要风险：** 迁移期双 channel 状态不一致；通过单一服务入口、兼容期适配层和逐项删除旧入口规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P0-01；与 P0-02 并行后汇合。

**文件范围：**
- 修改 `src/preload/index.ts`、`src/preload/index.d.ts`、`src/main/index.ts`；新增 `src/shared/agent-ipc.ts`、`src/main/agent/ipc.ts` 及测试。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 设计静态请求与响应

**任务目标：**
- 为连接、工作目录选择、任务启动/取消、权限响应、会话查询定义大小受限的输入输出；定义稳定错误码。

**涉及范围：**
- 修改 `src/preload/index.ts`、`src/preload/index.d.ts`、`src/main/index.ts`；新增 `src/shared/agent-ipc.ts`、`src/main/agent/ipc.ts` 及测试。

**前置依赖：**
- 依赖 P0-01；与 P0-02 并行后汇合。

- [ ] **第 1 步: 落地本任务**
说明：为连接、工作目录选择、任务启动/取消、权限响应、会话查询定义大小受限的输入输出；定义稳定错误码。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 保持 `contextIsolation` 与 sandbox；不暴露 `ipcRenderer`、通用 invoke、文件系统或 Runtime 原对象；Provider IPC 保持独立。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 集中注册并校验

**任务目标：**
- 编写调用方窗口校验、字符串/数组/正文限制和错误脱敏；所有 Handler 写中文 TSDoc 说明安全边界。

**涉及范围：**
- 修改 `src/preload/index.ts`、`src/preload/index.d.ts`、`src/main/index.ts`；新增 `src/shared/agent-ipc.ts`、`src/main/agent/ipc.ts` 及测试。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：编写调用方窗口校验、字符串/数组/正文限制和错误脱敏；所有 Handler 写中文 TSDoc 说明安全边界。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 保持 `contextIsolation` 与 sandbox；不暴露 `ipcRenderer`、通用 invoke、文件系统或 Runtime 原对象；Provider IPC 保持独立。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 迁移 Preload 与调用点

**任务目标：**
- 先并行接入 `window.agent`，再替换 Renderer 使用点；测试跨窗口调用、非法 taskId 与超长 prompt。

**涉及范围：**
- 修改 `src/preload/index.ts`、`src/preload/index.d.ts`、`src/main/index.ts`；新增 `src/shared/agent-ipc.ts`、`src/main/agent/ipc.ts` 及测试。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：先并行接入 `window.agent`，再替换 Renderer 使用点；测试跨窗口调用、非法 taskId 与超长 prompt。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 保持 `contextIsolation` 与 sandbox；不暴露 `ipcRenderer`、通用 invoke、文件系统或 Runtime 原对象；Provider IPC 保持独立。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] Renderer 无法自选 channel 或读取密钥；非法来源和越界输入被拒绝且不泄漏细节；现有 Grok 主流程经 `agent:*` 可用。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

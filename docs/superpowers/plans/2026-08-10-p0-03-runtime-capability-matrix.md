# P0-03 Runtime 能力矩阵 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P0 / 权重 4（防止 UI 过度承诺）

**目标：** 让每个 Runtime 明确声明会话、计划、工具、Diff、审批和 Usage 的真实能力与成熟度。

**核心数据流：** Adapter 在连接时返回能力描述；主进程汇总为 Runtime 摘要；Renderer 据此显示可操作入口和原因明确的降级说明。

**约束与边界：** 能力是事实声明而非营销标签；不根据 UI 是否能显示就推断后端支持；不提前做插件市场或通用 Runtime 容器。

**主要风险：** 静态枚举与实际版本漂移会误导用户；使用版本范围、运行时探测结果和“尚未验证”状态区分。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P0-01、P0-02。

**文件范围：**
- `src/shared/agent.ts`、`src/main/agent/runtime-capabilities.ts`、`src/renderer/src/composables/useRuntimeCapabilities.ts`。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 列出能力维度

**任务目标：**
- 按连接、会话、流式事件、计划、工具、文件、审批、Usage、恢复定义能力项及 native/simulated/experimental/unsupported 状态。

**涉及范围：**
- `src/shared/agent.ts`、`src/main/agent/runtime-capabilities.ts`、`src/renderer/src/composables/useRuntimeCapabilities.ts`。

**前置依赖：**
- 依赖 P0-01、P0-02。

- [ ] **第 1 步: 落地本任务**
说明：按连接、会话、流式事件、计划、工具、文件、审批、Usage、恢复定义能力项及 native/simulated/experimental/unsupported 状态。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 能力是事实声明而非营销标签；不根据 UI 是否能显示就推断后端支持；不提前做插件市场或通用 Runtime 容器。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现查询与版本关联

**任务目标：**
- 由 Adapter 返回声明和已验证版本，主进程校验形状并为缺失项填充 `unsupported`。

**涉及范围：**
- `src/shared/agent.ts`、`src/main/agent/runtime-capabilities.ts`、`src/renderer/src/composables/useRuntimeCapabilities.ts`。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：由 Adapter 返回声明和已验证版本，主进程校验形状并为缺失项填充 `unsupported`。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 能力是事实声明而非营销标签；不根据 UI 是否能显示就推断后端支持；不提前做插件市场或通用 Runtime 容器。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 接入禁用与说明 UI

**任务目标：**
- 操作入口按矩阵禁用，tooltip 说明真实限制；手工核对 Grok 现有能力没有被隐藏或虚构。

**涉及范围：**
- `src/shared/agent.ts`、`src/main/agent/runtime-capabilities.ts`、`src/renderer/src/composables/useRuntimeCapabilities.ts`。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：操作入口按矩阵禁用，tooltip 说明真实限制；手工核对 Grok 现有能力没有被隐藏或虚构。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 能力是事实声明而非营销标签；不根据 UI 是否能显示就推断后端支持；不提前做插件市场或通用 Runtime 容器。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 每个可点击的 Runtime 操作均可追溯到能力声明；不支持操作有可理解原因；协议未知时采取保守禁用而非尝试执行。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

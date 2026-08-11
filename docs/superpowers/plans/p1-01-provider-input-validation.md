# P1-01 Provider 输入与 URL 校验复核 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P1 / 权重 5（已有实现，验收与扩展前提）

**目标：** 复核并固化 Provider Base URL、认证、模型和请求大小的主进程校验，使扩展配置不会绕开当前安全边界。

**核心数据流：** Renderer 表单只做交互提示；Provider IPC 将原始输入交主进程；校验器规范化 URL 并产生受限配置或稳定错误码。

**约束与边界：** 允许 HTTP 以支持本机/局域网，但持续提示传输风险；禁止 URL 用户信息、query/hash Secret；不按 `sk-` 前缀武断拒绝合法自建 Key。

**主要风险：** 多 Profile 扩展时某个新入口跳过校验；将校验器作为 store、测试器和 IPC 的唯一构造入口。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 现有 `provider-validation.ts`；后续多 Profile 和协议分型依赖它。

**文件范围：**
- 复核 `src/main/provider/provider-validation.ts`、`provider-validation.test.ts`、`src/shared/provider.ts`；后续新增 `provider-profile.ts`。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 核对当前规则与测试

**任务目标：**
- 逐条检查协议、控制字符、origin 变更、空认证、modelId 长度与错误脱敏，补齐实际缺口。

**涉及范围：**
- 复核 `src/main/provider/provider-validation.ts`、`provider-validation.test.ts`、`src/shared/provider.ts`；后续新增 `provider-profile.ts`。

**前置依赖：**
- 现有 `provider-validation.ts`；后续多 Profile 和协议分型依赖它。

- [ ] **第 1 步: 落地本任务**
说明：逐条检查协议、控制字符、origin 变更、空认证、modelId 长度与错误脱敏，补齐实际缺口。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 允许 HTTP 以支持本机/局域网，但持续提示传输风险；禁止 URL 用户信息、query/hash Secret；不按 `sk-` 前缀武断拒绝合法自建 Key。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 提炼可复用受限输入

**任务目标：**
- 让后续 Profile、协议和健康检查都消费 validated 类型，避免重复解析 URL。

**涉及范围：**
- 复核 `src/main/provider/provider-validation.ts`、`provider-validation.test.ts`、`src/shared/provider.ts`；后续新增 `provider-profile.ts`。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：让后续 Profile、协议和健康检查都消费 validated 类型，避免重复解析 URL。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 允许 HTTP 以支持本机/局域网，但持续提示传输风险；禁止 URL 用户信息、query/hash Secret；不按 `sk-` 前缀武断拒绝合法自建 Key。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 完成安全回归

**任务目标：**
- 以假 Key 和本地 mock 验证无效 URL、超长字段、账号密码 URL、query Secret 与 HTTP 提示。

**涉及范围：**
- 复核 `src/main/provider/provider-validation.ts`、`provider-validation.test.ts`、`src/shared/provider.ts`；后续新增 `provider-profile.ts`。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：以假 Key 和本地 mock 验证无效 URL、超长字段、账号密码 URL、query Secret 与 HTTP 提示。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 允许 HTTP 以支持本机/局域网，但持续提示传输风险；禁止 URL 用户信息、query/hash Secret；不按 `sk-` 前缀武断拒绝合法自建 Key。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 所有 Provider 写入与请求路径只能使用已校验输入；错误可定位字段但不回显密钥；HTTP 能用且风险持续可见。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

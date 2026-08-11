# P3-06 Chrome Native Bridge 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P3 / 权重 3（连接用户现有标签页）

**目标：** 通过 Chrome Extension 与 Native Messaging 让用户主动共享单个标签页，而非读取 Chrome Profile 或全浏览器数据。

**核心数据流：** 扩展由用户点击选择 tab；Native Host 只接受签名/固定协议消息；Capability 将 tab 范围和站点授权送 Broker，再转发允许的动作。

**约束与边界：** 只支持用户当前明确选中的 tab；不读取 cookies、history、passwords 或其它标签页；不使用静默全站注入。

**主要风险：** Native Messaging 成为任意本机执行通道；固定 extension id、消息 schema、长度限制、来源校验和最小原生命令。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P3-02、P3-05 的权限模型验证。

**文件范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 设计 tab 授权协议

**任务目标：**
- 定义用户选择、连接、断开、域名变化、权限过期及 runtime/capability 身份绑定。

**涉及范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**前置依赖：**
- 依赖 P3-02、P3-05 的权限模型验证。

- [ ] **第 1 步: 落地本任务**
说明：定义用户选择、连接、断开、域名变化、权限过期及 runtime/capability 身份绑定。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 只支持用户当前明确选中的 tab；不读取 cookies、history、passwords 或其它标签页；不使用静默全站注入。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现受限 Native Host

**任务目标：**
- 校验 extension 来源和请求 schema，仅支持允许的 tab 操作，所有网页副作用仍交 Broker。

**涉及范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：校验 extension 来源和请求 schema，仅支持允许的 tab 操作，所有网页副作用仍交 Broker。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 只支持用户当前明确选中的 tab；不读取 cookies、history、passwords 或其它标签页；不使用静默全站注入。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 端到端安全验证

**任务目标：**
- 验证未选择 tab、切换 tab/域名、扩展断连、伪造消息和敏感表单提交均不能越权。

**涉及范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：验证未选择 tab、切换 tab/域名、扩展断连、伪造消息和敏感表单提交均不能越权。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 只支持用户当前明确选中的 tab；不读取 cookies、history、passwords 或其它标签页；不使用静默全站注入。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 未由用户主动共享的标签页完全不可访问；桥接消息不能触发任意 Shell/文件操作；撤销共享立即生效。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

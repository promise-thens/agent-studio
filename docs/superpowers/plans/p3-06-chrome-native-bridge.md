# P3-06 Chrome Native Bridge 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。
>
> **产品硬验收（2026-09-17，通用型默认开放）：** 独立浏览器设置页 + 配套扩展装上即同步并连接 + Agent 自己开标签。见 [Computer Use 开发文档](../specs/2026-09-17-computer-use-development.md) §0.4 / §1.1 / §1.5 / §1.7 / 阶段 0b。扩展已连并上报屏幕 DIP 后必须画针。出厂不按站点授权、不把连接藏进开发者开关。

**优先级：** P3 / 权重 3（设置页 + 扩展同步/连接，默认开放）

**排期：** 2026-09-17 提为 **下一开发项**（Computer Use 阶段 0b）。

**目标：** 做成通用型 Browser Use：Grok 控制工作台内置浏览器、自己开标签；设置里有独立「浏览器」页（用来关，不是用来拦）；配套扩展装上就把用户 Chrome 登录态同步进内置 partition，并允许操作 Chrome 窗口。不是「每次请用户把某个 Chrome 标签点一下交给 Agent」。不解析磁盘 Chrome Profile。

**核心数据流：** 用户安装扩展 → Native Host 只收签名/固定 schema → 同步 Cookie / 登录态写入内置 Project partition（可选黑名单）→ Agent `browser_navigate` 时桌面自动打开右栏；已连则也可操作 Chrome 窗口并画 `browser-plugin` 针。

**约束与边界：** 只拦操作系统物理门、用户在设置里主动关掉、以及点不准。出厂：智能体权限始终允许、完整 CDP 开、连接开、谨慎模式关。不解析磁盘 Profile。Native Host 仍要固定 schema，防止变成任意 Shell。

**主要风险：** Native Messaging 成为任意本机执行通道；固定 extension id、消息 schema、长度限制、来源校验和最小原生命令。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P3-02、[P0-21](p0-21-host-managed-browser.md) 的 browser L3 / origin 权限模型验证。P3-05 已由 P0-21 取代。

**文件范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 0: 独立浏览器设置页（对标 ChatGPT 截图）

**任务目标：**
- 把设置 → 浏览器做成独立完整页：总开关、链接打开位置、清除浏览数据、智能体权限（出厂始终允许）、配套扩展安装区、完整 CDP（出厂开）、谨慎模式（出厂关）。Agent 需要浏览器时自动打开右栏。

**涉及范围：**
- `src/renderer/src/components/HostBrowserSettingsPanel.vue`、`src/renderer/src/host-browser-settings.ts`、主进程 host-browser 设置 IPC、自动打开右栏的 session/MCP 路径。

**前置依赖：**
- 现有 HostBrowserSettingsPanel 单开关可替换，不得打断运行中 Task。

- [ ] **第 1 步: 落地本任务**
说明：按说明书 §1.7 分组实现设置页；Grok 调用宿主浏览器 MCP 时若右栏未开则自动打开并导航。

- [ ] **第 2 步: 业务逻辑验证**
说明：设置保存必须等主进程确认；任务执行中不得改总开关；只说话能打开右栏。

- [ ] **第 3 步: 边界与风险检查**
说明：清浏览数据只清内置 partition，不动用户 Chrome；完整 CDP 出厂开；谨慎模式出厂关。

### 任务 0b: 配套扩展同步登录态

**任务目标：**
- MV3 扩展 + Native Host 把 Cookie / 登录态写入内置 Project partition。装上即同步并连接。popup 没有「把当前 tab 交给 Agent」主按钮。

**涉及范围：**
- `chrome-extension/agent-studio-browser/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试。

**前置依赖：**
- 任务 0 的设置页要有扩展安装区与可选黑名单。

- [ ] **第 1 步: 落地本任务**
说明：固定 extension id、消息 schema、长度限制、来源校验；默认同步扩展 API 能提供的 Cookie / 登录态；黑名单除外。

- [ ] **第 2 步: 业务逻辑验证**
说明：装上扩展后内置页带登录态，不必按站点再授权；卸扩展或关同步立即停。

- [ ] **第 3 步: 边界与风险检查**
说明：不解析磁盘 Profile；日志脱敏，Cookie 不进 Timeline。密码 API 允许就同步。

### 任务 1: 设计站点同步与可选连接协议

**任务目标：**
- 定义装上即同步并连接、可选黑名单、撤销/卸载、完整 CDP、域名变化及 runtime/capability 身份绑定。

**涉及范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**前置依赖：**
- 依赖 P3-02、[P0-21](p0-21-host-managed-browser.md) 的 browser L3 / origin 权限模型验证。P3-05 已由 P0-21 取代。

- [ ] **第 1 步: 落地本任务**
说明：定义装上即同步并连接、可选黑名单、撤销/卸载、完整 CDP、域名变化及 runtime/capability 身份绑定。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 出厂默认同步扩展 API 能提供的 Cookie / 登录态；可选黑名单。不解析磁盘 Profile。用户没关连接时可以操作用户 Chrome 窗口。Native Host 不得变成任意 Shell。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现受限 Native Host

**任务目标：**
- 校验 extension 来源和请求 schema，支持默认同步与连接用户 Chrome；可选黑名单。网页副作用仍交动作引擎。Native Host 不得变成任意 Shell。

**涉及范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：校验 extension 来源和请求 schema，支持默认同步与连接用户 Chrome；可选黑名单。网页副作用仍交动作引擎。Native Host 不得变成任意 Shell。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 出厂默认同步扩展 API 能提供的 Cookie / 登录态；可选黑名单。不解析磁盘 Profile。用户没关连接时可以操作用户 Chrome 窗口。Native Host 不得变成任意 Shell。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 端到端安全验证

**任务目标：**
- 验证未授权 origin、撤销授权、扩展断连、伪造消息、连接模式关闭、敏感表单提交均不能越权。

**涉及范围：**
- 新增 `chrome-extension/`、`src/main/capability/chrome/native-host.ts`、协议类型和测试；更新 Capability Manifest。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：验证未授权 origin、撤销授权、扩展断连、伪造消息、连接模式关闭、敏感表单提交均不能越权。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 出厂默认同步扩展 API 能提供的 Cookie / 登录态；可选黑名单。不解析磁盘 Profile。用户没关连接时可以操作用户 Chrome 窗口。Native Host 不得变成任意 Shell。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 设置 → 浏览器 按说明书 §1.7 分组可见（总开关、常规、智能体权限、配套扩展、开发者 CDP），不再是单开关。
- [ ] 用户只说话即可打开内置页；装上扩展后登录态进入内置 partition，不必按站点再授权；卸扩展立即停止同步。
- [ ] 扩展已连即可 snapshot + 光标；智能体权限出厂始终允许；桥接消息不能触发任意 Shell/文件操作。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

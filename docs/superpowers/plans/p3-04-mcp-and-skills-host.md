# P3-04 MCP 与 Skills Host 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P3 / 权重 4（标准能力接入）

**目标：** 以 Manifest 管理 MCP Server 与 Skills 的发现、启动、工具声明、生命周期和故障隔离。

**核心数据流：** Capability Registry 加载受控配置；Host 启动单个 MCP/Skill 进程或读取静态 Skill；工具调用经 Broker 转发并以事件返回 Runtime。

**约束与边界：** 不让 Runtime/Renderer 任意指定可执行文件或工具 URL；不导入用户未明确安装的 Skill；首期不做远程市场与自动更新。

**主要风险：** MCP 子进程卡死、工具 schema 过大或输出含密钥；设置启动超时、资源限制、stdout/stderr 脱敏与工具参数大小限制。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P3-01、P3-02。

**文件范围：**
- 新增 `src/main/capability/mcp-host.ts`、`skill-host.ts`、测试；修改 Manifest 类型、Capability executor 与设置 UI。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 建立受控配置模型

**任务目标：**
- Manifest 声明 MCP 启动方式、工具范围与 Skill 路径，主进程规范化路径并禁止目录逃逸。

**涉及范围：**
- 新增 `src/main/capability/mcp-host.ts`、`skill-host.ts`、测试；修改 Manifest 类型、Capability executor 与设置 UI。

**前置依赖：**
- 依赖 P3-01、P3-02。

- [ ] **第 1 步: 落地本任务**
说明：Manifest 声明 MCP 启动方式、工具范围与 Skill 路径，主进程规范化路径并禁止目录逃逸。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不让 Runtime/Renderer 任意指定可执行文件或工具 URL；不导入用户未明确安装的 Skill；首期不做远程市场与自动更新。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现生命周期与调用桥

**任务目标：**
- 每个 Host 独立启动/停止/重启，工具调用预校验 schema 后交 Broker，错误映射为中性事件。

**涉及范围：**
- 新增 `src/main/capability/mcp-host.ts`、`skill-host.ts`、测试；修改 Manifest 类型、Capability executor 与设置 UI。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：每个 Host 独立启动/停止/重启，工具调用预校验 schema 后交 Broker，错误映射为中性事件。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不让 Runtime/Renderer 任意指定可执行文件或工具 URL；不导入用户未明确安装的 Skill；首期不做远程市场与自动更新。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 验证隔离

**任务目标：**
- 覆盖不存在入口、异常退出、超时、工具拒绝、超大输出和一个 Runtime 无权限调用的情况。

**涉及范围：**
- 新增 `src/main/capability/mcp-host.ts`、`skill-host.ts`、测试；修改 Manifest 类型、Capability executor 与设置 UI。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：覆盖不存在入口、异常退出、超时、工具拒绝、超大输出和一个 Runtime 无权限调用的情况。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不让 Runtime/Renderer 任意指定可执行文件或工具 URL；不导入用户未明确安装的 Skill；首期不做远程市场与自动更新。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] MCP/Skill 的来源、状态和请求权限均可见；单个 Host 故障不影响主进程或其它能力；Renderer 不获得子进程控制权。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

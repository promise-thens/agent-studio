# P3-01 Capability Pack Manifest 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P3 / 权重 4（可扩展能力的最小契约）

**目标：** 定义本地 Capability Pack 的 Manifest、版本、能力声明、兼容性与启停生命周期，为内置能力建立可审计边界。

**核心数据流：** 主进程从受控目录读取 Manifest 并 schema 校验；注册表生成可用能力；Runtime 请求能力时先检查兼容性，再经 Broker 执行。

**约束与边界：** 首期只管理内置/本地显式安装能力，不做第三方市场、远程下载安装或复杂签名体系；Manifest 不能声明任意 IPC/Shell 权限。

**主要风险：** Manifest 夸大权限或版本不兼容；固定 schema、能力白名单、版本协商和未知字段拒绝。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P0-01、P0-03、P0-08。

**文件范围：**
- 新增 `src/shared/capability.ts`、`src/main/capability/manifest.ts`、`registry.ts` 与测试；新增 `capabilities/` 内置样例。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 定义 Manifest schema

**任务目标：**
- 包含 id、version、displayName、entry、supportedRuntimes、requestedOperations、数据敏感级别和兼容范围。

**涉及范围：**
- 新增 `src/shared/capability.ts`、`src/main/capability/manifest.ts`、`registry.ts` 与测试；新增 `capabilities/` 内置样例。

**前置依赖：**
- 依赖 P0-01、P0-03、P0-08。

- [ ] **第 1 步: 落地本任务**
说明：包含 id、version、displayName、entry、supportedRuntimes、requestedOperations、数据敏感级别和兼容范围。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 首期只管理内置/本地显式安装能力，不做第三方市场、远程下载安装或复杂签名体系；Manifest 不能声明任意 IPC/Shell 权限。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现受控发现与注册

**任务目标：**
- 限定安装根目录、解析大小和数量，校验路径不逃逸，生成不可变注册表和失败摘要。

**涉及范围：**
- 新增 `src/shared/capability.ts`、`src/main/capability/manifest.ts`、`registry.ts` 与测试；新增 `capabilities/` 内置样例。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：限定安装根目录、解析大小和数量，校验路径不逃逸，生成不可变注册表和失败摘要。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 首期只管理内置/本地显式安装能力，不做第三方市场、远程下载安装或复杂签名体系；Manifest 不能声明任意 IPC/Shell 权限。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 为内置能力验证

**任务目标：**
- 用只读示例验证启用、禁用、schema 失败、版本不兼容与权限声明过宽的拒绝。

**涉及范围：**
- 新增 `src/shared/capability.ts`、`src/main/capability/manifest.ts`、`registry.ts` 与测试；新增 `capabilities/` 内置样例。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：用只读示例验证启用、禁用、schema 失败、版本不兼容与权限声明过宽的拒绝。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 首期只管理内置/本地显式安装能力，不做第三方市场、远程下载安装或复杂签名体系；Manifest 不能声明任意 IPC/Shell 权限。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 每项能力都能说明来源、版本、Runtime 兼容性和请求权限；非法 Manifest 无法加载或取得执行入口。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

# P1-02 Provider 凭据安全存储复核 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P1 / 权重 5（已有实现，扩展前必须守住）

**目标：** 复核并扩展现有 safeStorage、版本化文件和原子写入策略，确保每个 Provider Profile 的密钥只在主进程可用。

**核心数据流：** 主进程在 ready 后注入 safeStorage；Store 加密 Key 并写入 userData；Renderer 只读取摘要；Runtime 在启动/请求的最小窗口获得临时配置。

**约束与边界：** Linux `basic_text` 或无安全后端仅限会话；不得把密钥写入 TOML、日志、测试快照或 history；不自研加密算法。

**主要风险：** 解密失败、原子写入中断或旧 schema 导致误清除；保留旧文件、返回 corrupt 状态、让用户重新输入而非丢失其它配置。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P1-01；多 Profile 之前完成。

**文件范围：**
- 复核 `src/main/provider/provider-config-store.ts`、测试和 `src/main/security/sensitive-redaction.ts`；后续拆分 `provider-credential-store.ts`。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 验证安全存储契约

**任务目标：**
- 检查 ready 时机、0600/0700 权限、加密可用性、重启读取、清除和损坏配置路径。

**涉及范围：**
- 复核 `src/main/provider/provider-config-store.ts`、测试和 `src/main/security/sensitive-redaction.ts`；后续拆分 `provider-credential-store.ts`。

**前置依赖：**
- 依赖 P1-01；多 Profile 之前完成。

- [ ] **第 1 步: 落地本任务**
说明：检查 ready 时机、0600/0700 权限、加密可用性、重启读取、清除和损坏配置路径。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 Linux `basic_text` 或无安全后端仅限会话；不得把密钥写入 TOML、日志、测试快照或 history；不自研加密算法。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 为多 Profile 建立隔离键空间

**任务目标：**
- 按稳定 profileId 保存密文和元数据，禁止通过 Provider 名称或 Renderer 参数访问任意凭据。

**涉及范围：**
- 复核 `src/main/provider/provider-config-store.ts`、测试和 `src/main/security/sensitive-redaction.ts`；后续拆分 `provider-credential-store.ts`。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：按稳定 profileId 保存密文和元数据，禁止通过 Provider 名称或 Renderer 参数访问任意凭据。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 Linux `basic_text` 或无安全后端仅限会话；不得把密钥写入 TOML、日志、测试快照或 history；不自研加密算法。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 回归与泄漏扫描

**任务目标：**
- 使用假 Key 覆盖保存、读取、异常、basic_text 和原子失败，搜索日志/错误对象/序列化结果确认无明文。

**涉及范围：**
- 复核 `src/main/provider/provider-config-store.ts`、测试和 `src/main/security/sensitive-redaction.ts`；后续拆分 `provider-credential-store.ts`。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：使用假 Key 覆盖保存、读取、异常、basic_text 和原子失败，搜索日志/错误对象/序列化结果确认无明文。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 Linux `basic_text` 或无安全后端仅限会话；不得把密钥写入 TOML、日志、测试快照或 history；不自研加密算法。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 任何 Renderer API 都不能取得 API Key；不可安全持久化时没有明文落盘；单个配置损坏不会导致静默数据丢失。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

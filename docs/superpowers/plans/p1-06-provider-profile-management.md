# P1-06 多 Provider Profile 管理 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**优先级：** P1 / 权重 4（开放模型配置的产品核心）

**目标：** 从单一活动 Provider 升级为多个独立 Profile 的创建、编辑、复制、测试、启用和删除，并保持运行中绑定稳定。

**核心数据流：** Renderer 管理不含密钥的 Profile 摘要；主进程以 profileId 操作验证、密钥和测试；任务在启动时固定 profileId 与 modelId，运行中不得静默改变。

**约束与边界：** 不做云同步、团队共享或 Provider 市场；删除活动/被任务引用的 Profile 必须先断开或提示替换；名称不作为权限或存储键。

**主要风险：** 切换活动配置影响正在执行任务；以任务快照绑定、主进程确认切换与删改前引用检查规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；需要 Runtime 协议时以当期官方 schema 与本机实测为准。

---

## 实施范围

**前置依赖：**
- 依赖 P1-01 至 P1-05；P0 Agent 服务稳定后接入绑定。

**文件范围：**
- 新增 `src/shared/provider-profile.ts`、`src/main/provider/provider-profile-store.ts`、测试；修改 Provider IPC、设置组件和 runtime config 选择逻辑。

**安全策略：**
- 安全是与操作风险匹配的护栏：低风险只读操作可在任务范围授权；写入与命令需展示目标和影响；删除、外发数据、登录态、屏幕和剪贴板始终显式确认。
- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据须可序列化、限长并脱敏。

### 任务 1: 定义 Profile 与状态模型

**任务目标：**
- 包含 profileId、displayName、protocol、baseUrl、credential 状态、模型和验证摘要；迁移现有单配置为默认 Profile。

**涉及范围：**
- 新增 `src/shared/provider-profile.ts`、`src/main/provider/provider-profile-store.ts`、测试；修改 Provider IPC、设置组件和 runtime config 选择逻辑。

**前置依赖：**
- 依赖 P1-01 至 P1-05；P0 Agent 服务稳定后接入绑定。

- [ ] **第 1 步: 落地本任务**
说明：包含 profileId、displayName、protocol、baseUrl、credential 状态、模型和验证摘要；迁移现有单配置为默认 Profile。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不做云同步、团队共享或 Provider 市场；删除活动/被任务引用的 Profile 必须先断开或提示替换；名称不作为权限或存储键。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 2: 实现主进程 CRUD

**任务目标：**
- 所有输入复用验证与凭据存储；限制 Profile 数量、字段长度和删除范围，并原子维护活动 Profile 引用。

**涉及范围：**
- 新增 `src/shared/provider-profile.ts`、`src/main/provider/provider-profile-store.ts`、测试；修改 Provider IPC、设置组件和 runtime config 选择逻辑。

**前置依赖：**
- 依赖本计划任务 1 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：所有输入复用验证与凭据存储；限制 Profile 数量、字段长度和删除范围，并原子维护活动 Profile 引用。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不做云同步、团队共享或 Provider 市场；删除活动/被任务引用的 Profile 必须先断开或提示替换；名称不作为权限或存储键。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

### 任务 3: 实现设置与任务绑定

**任务目标：**
- 在设置页提供明确测试/保存结果；启动任务时锁定快照，验证编辑、删除、切换和旧任务恢复。

**涉及范围：**
- 新增 `src/shared/provider-profile.ts`、`src/main/provider/provider-profile-store.ts`、测试；修改 Provider IPC、设置组件和 runtime config 选择逻辑。

**前置依赖：**
- 依赖本计划任务 2 的可验证输出。

- [ ] **第 1 步: 落地本任务**
说明：在设置页提供明确测试/保存结果；启动任务时锁定快照，验证编辑、删除、切换和旧任务恢复。

- [ ] **第 2 步: 业务逻辑验证**
说明：使用单元测试、受控 mock 或开发版手工路径验证主流程。
预期：输入、状态与输出符合本计划的数据流，不出现未声明的副作用。

- [ ] **第 3 步: 边界与风险检查**
说明：检查 不做云同步、团队共享或 Provider 市场；删除活动/被任务引用的 Profile 必须先断开或提示替换；名称不作为权限或存储键。
预期：失败路径有明确、脱敏的反馈，既不越权也不阻断正常低风险流程。

## 验收标准

- [ ] 多个 Profile 凭据完全隔离；运行中的任务继续使用启动快照；删除或切换不会造成密钥错发或 UI 假成功。
- [ ] 相关新增核心函数、IPC Handler、密钥/权限边界均有中文注释，且新增测试只使用假凭据和本地 Mock。
- [ ] 目标文件 ESLint、相关 Vitest、`pnpm typecheck`、`pnpm build` 与 `git diff --check` 在 Node.js 20+、pnpm 10.x 下完成；UI/Electron 改动另有对应开发版手工走查记录。

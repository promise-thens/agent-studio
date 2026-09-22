# 会话状态与无项目聊天实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标：** 修复权限指令污染标题，落实应用级权限偏好，并支持无需添加项目直接聊天。

**核心数据流：** Renderer 经窄 Preload API 请求创建会话和修改权限，主进程持久化应用偏好、分配执行目录并驱动 AgentService；Renderer 只消费任务摘要和实际生效状态。

**约束与边界：** 对应问题 1.1、1.2、1.3、1.5。2026-09-20 用户确认所有对话统一权限、跨重启保持，运行中不重启，空闲后应用；无项目聊天使用应用托管目录。首次未选择权限仍默认询问。不改用户全局 Grok 配置，不放松凭据隔离，不实现多执行槽。

**主要风险：** 控制回合抢占标题；全局期望值被误当成 session 已生效；托管目录误用配置目录；切项目异步响应覆盖新选择。分别以标题来源、独立实际状态、独立工作目录和请求代次约束。

**技术栈：** Electron 39、Vue 3、TypeScript、Vitest、现有 TaskStore / ProjectRegistry。

**状态：** 工作区已有控制回合标题隔离、应用级权限偏好及托管聊天实现，尚未完成全部 GUI 验收。2026-09-20 补齐所有退出 Plan 入口：Normal 开关、重选完全访问、批准/放弃计划均撤销主进程临时覆盖；执行中只登记 pending，槽释放后恢复全局权限，不取消当前轮；失败不乐观显示 Normal。快照显式传递 false，供 Renderer 确认退出。

**本轮验证：** Node 22.22.0 / pnpm 10.33.0；权限服务及 Composer 目标测试 70/70、typecheck、build:unpack、diff-check 已过。全量 `pnpm test` 为 196 文件 / 1926 测试通过，但 `autoTest/workbench-repair/workbench-repair.spec.ts` 被 Vitest 错误收集，Playwright beforeEach 报错，整体未通过。未修改无关旧 lint 错误。真实 GUI 已有证据为 3 过 1 失败，并非本次 Plan 修复的新 GUI 验收；浮层 Proxy 克隆根因已修，系统焦点导致隐藏及停止后 failed 仍未收口。

---

## 任务 1：控制回合不参与自动命名

**文件：** `src/main/agent/task-store.ts`、`task-store.test.ts`；如需记录标题来源，同步 `src/shared` 中现有 Task 历史契约及测试。

**证据：** `createTurn` 无条件按 `turnCount === 0` 派生标题；`takeover-control` 已传入，但只用于隐藏历史。不能仅跳过控制回合命名而保留首轮计数判断。

- [ ] 增加失败回归：首个控制回合后标题仍是默认标题，首次真实用户消息成为标题，连续控制回合和重启不改变结果。
- [ ] 自动命名以首个非控制回合为依据，保持审计回合及计数含义不变；手动标题始终优先。
- [ ] 对旧污染标题，仅在能证明为自动生成且未手动重命名时修复；不能证明时不覆盖用户标题，保留手动重命名入口。
- [ ] 验证恢复历史、失败回合、附件首轮、显式 slash 用户消息，禁止把所有 slash 消息一概当内部命令。

**完成标志：** 内部权限切换不会出现在标题中，真实用户标题可跨重启保存，手动命名不丢失。

## 任务 2：应用级权限偏好

**文件：** 新增 `src/main/agent/permission-preferences.ts` 及就近测试；修改 `agent-service.ts`、`agent/ipc.ts`、`src/shared/agent-ipc.ts`、`src/preload/desktop-api.ts`、`App.vue`、`TaskTakeoverConfirmDialog.vue` 与相关权限测试。

**数据流：** 用户选择 → IPC 校验 → 版本化偏好原子写入 → AgentService 在可应用时更新 session → 返回期望模式、实际模式及 pending/failed 状态。

- [ ] 主进程持久化全局模式，处理缺失、损坏、写入失败；写入失败不宣称已保存。
- [ ] 新任务及旧任务激活时读取同一偏好；迁移旧 Task 模式为运行状态，不再作为独立用户偏好。
- [ ] 正在执行时记录待应用值，不取消或重启当前轮；空闲后应用，失败保留重试反馈，不乐观显示已生效。
- [ ] 从完全访问降权时，pending/failed 必须阻止下一轮按旧高权限启动；应用与发送共用主进程准入顺序，补终态后立即发送的竞态测试。
- [ ] 授权确认文案明确“所有对话、重启后保留、如何关闭”；确认一次后切换和新建对话不重复询问，不再声称仅当前任务。
- [ ] `takeoverApplied` 仍归 session；重复选择、重连和失败重试不得盲目重复调用 toggle，避免关闭已开启的接管。
- [ ] Plan 若与接管互斥，作为当前 session 临时有效模式展示，不静默改全局偏好；关闭 Plan 后恢复全局模式。
- [ ] 补新旧任务、切换、重启、快速连续选择、控制回合失败、运行中修改与 Plan 互斥测试。
- [ ] 实现时同步 `AGENTS.md` 和 `CLAUDE.md` 的旧 Task-only 快照，保留“期望行为”与“已验收行为”的区别。

**完成标志：** 所有对话读取一致的全局选择，实际执行状态可追踪，失败不会造成权限显示与 Runtime 相反。

## 任务 3：无项目聊天与项目准备提示

**文件：** `src/main/project/project-registry.ts`、新建托管聊天目录服务及测试、`src/main/agent/agent-service.ts`、相关 IPC/Preload、`App.vue`、`useTaskWorkbench.ts`、`useTaskHistory.ts`、`task-composer-actions.ts` 及就近测试。

- [ ] 主进程自动准备持久化聊天工作区，置于独立工作目录，不使用 `userData` 根或凭据目录作为 cwd；继续复用内部 Project/Task 身份。
- [ ] 零项目时显示“新对话”，无需选择目录；托管聊天以独立分组显示历史，不伪装用户添加的项目。
- [ ] 复用现有 Task 创建、附件、Runtime 恢复与历史流程；创建失败明确报错，重复点击只创建一次。
- [ ] 用户项目的添加/切换仍保留发送门禁，将阻塞提示改为轻量“正在准备项目”，取消和异常后正确恢复。
- [ ] 不实现聊天中途迁移 execution root；之后打开项目创建另一个 Task，避免历史与文件归属串线。
- [ ] 验证零项目、多个托管对话、重启恢复、切到真实项目再返回、目录不可写和乱序响应。

**完成标志：** 未添加项目也能发起和恢复聊天，用户项目目录与托管聊天目录不混用。

## 验证与验收

- [ ] 每次符号编辑前运行 GitNexus upstream impact，报告直接调用方与执行流；HIGH/CRITICAL 先提示。
- [ ] 目标 Vitest、目标 ESLint 后运行完整 `pnpm test`、`pnpm exec eslint . --no-cache`、`pnpm typecheck`、`pnpm build`、`git diff --check`。
- [ ] 若修改主进程入口，运行 `pnpm build:unpack`。
- [ ] 开发版用独立测试数据目录和 Mock Runtime 走查新建、发送、切换、停止、重启。不得使用真实 Key 或付费调用完成自动化。
- [ ] 在问题清单旁记录每项自动验证与 GUI 验证状态，不将本计划保存视为修复完成。

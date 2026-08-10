# P0-02 Agent 事件归一化 实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。
>
> **状态：** 已完成（2026-08-10）

**优先级：** P0 / 权重 5（统一时间线与历史的基础）

**目标：** 将 Grok ACP 与后续 Runtime 的已脱敏流式输出标准化为有序、有限、可恢复消费的 `AgentEvent`。

**核心数据流：** Grok Adapter 将 ACP 对象逐字段映射为已脱敏的中性事件草稿；每次 Prompt 创建本地 task/turn 上下文；主进程事件归一器附加 `taskId`、`turnId`、`sequence` 与 `observedAt`，执行限长和状态保护后，经现有 IPC 推送给 Renderer。历史写入由 P0-06 接入本事件流，本阶段不提前实现。

**约束与边界：** 当前最小语义为“一次 Prompt 对应一个 task 和一个 turn”；sequence 从 `1` 开始，仅表示主进程接受顺序，不伪装为 ACP 原生顺序；不按文本、`messageId` 或内容哈希猜测重复；保留 `native`、`simulated`、`experimental`、`unsupported` 能力标记；不把完整请求、密钥、原始 stderr、协议 `_meta` 或异常堆栈写入事件。

**非目标：** 不迁移 `window.grok` 或 `grok:*` IPC；不移动 `GrokAgentBridge` 目录；不实现本地历史、执行时间线、Permission Broker、多 Turn 任务聚合或 Grok 不支持的暂停能力。

**主要风险：** 旧会话事件污染当前任务、工具状态倒退、取消与进程退出重复终结、超大正文阻塞 IPC，以及把本地 sequence 误解为协议去重能力。通过 active turn 身份门禁、首个终态获胜、UTF-8 字节限长和 Renderer 的 `(taskId, sequence)` 防重复消费规避。

**技术栈：** Electron 39、Vue 3、TypeScript、electron-vite、pnpm 10、Node.js 20+、Vitest；Runtime 协议以当前 `@agentclientprotocol/sdk` schema 与本机实测为准。

---

## 实施范围

**前置依赖：**

- P0-01 的中性 Agent 领域契约和 Grok ACP 显式映射已经完成。

**文件范围：**

- 修改 `src/shared/agent.ts`、`src/shared/agent.test.ts`。
- 新增 `src/main/agent/event-normalizer.ts`、`src/main/agent/event-normalizer.test.ts`。
- 修改 `src/main/grok-agent.ts`、`src/main/grok-agent.test.ts`。
- 新增 Renderer 事件顺序守卫及测试，并在 `src/renderer/src/App.vue` 接入。
- 同步本计划、路线索引和 `AGENTS.md` 当前进度。

**排序、去重与状态规则：**

- `AgentEvent` 必须包含 `taskId`、`turnId`、从 `1` 连续递增的 `sequence` 和主进程接受时间 `observedAt`。
- 被忽略、非法或重复的事件不占用 sequence；排序和重放防重复只使用 `(taskId, sequence)`。
- 相同文本 chunk 即使内容和 `messageId` 相同也必须保留；ACP 没有可用于 chunk 去重的原生 sequence。
- 工具终态 `completed`、`failed`、`cancelled` 不得回退到 `pending` 或 `in_progress`；完全相同的工具 no-op 可丢弃。
- 第一个 `turn-complete` 锁定 Turn；普通 `error` 只提供诊断，不自行锁定；终态后的普通事件和重复终态必须丢弃。
- 权限请求继续走独立控制通道，但必须绑定当前 `taskId` 和 `turnId`；权限审计事件由 P0-08 完成。

**载荷限制：**

- 单个序列化事件不超过 `256 KiB`；message/thought 不超过 `64 KiB`。
- 工具标题和错误信息不超过 `4 KiB`，错误码不超过 `128 B`。
- 权限标题和选项展示名称不超过 `4 KiB`，完整权限请求不超过 `256 KiB`；ACP 标识符不截断，整体超限时安全拒绝该权限请求。
- Plan 最多 `100` 项、每项正文不超过 `2 KiB`。
- Diff 最多 `20` 项，路径数组最多 `100` 项，Diff 正文共享 `192 KiB` 预算。
- 所有限制按 UTF-8 bytes 计算并遵循“先脱敏，后截断”；发生截断时设置 `truncated: true`。裁剪后仍超限时替换为不含原载荷的 `event-payload-too-large` 安全错误事件。

**协议兼容边界：**

- 当前 schema 中已知但暂不展示的 update 必须显式忽略且不消耗 sequence。
- Mapper 对测试构造的未知 update 生成一次不含原始类型或载荷的可恢复提示。
- SDK 会在 Adapter 前校验真正的未来 discriminant；这类 schema 不兼容通过连接或 Prompt 失败路径形成明确 `error + turn-complete(failed)`，不宣称任务一定可以继续。

**安全策略：**

- Renderer 不接触密钥、任意 IPC、文件系统或子进程；所有跨进程数据必须可序列化、限长并在主进程脱敏。
- 自动化测试只使用明显的假 Key 和本地 Mock；用户授权的真实 API 仅用于开发版手工联调，不写入源码、测试、日志或快照。
- 当前 Provider Base URL 为 HTTP 时，手工验收必须如实记录 API Key 与请求内容没有传输加密。

### 任务 1: 落地事件封套与归一器

- [x] **第 1 步: 收紧共享事件契约**
说明：将 `taskId`、`turnId`、`sequence`、`observedAt` 设为跨进程事件必填字段，补充 `truncated` 标记，并让权限请求必定关联 task/turn。

- [x] **第 2 步: 实现主进程归一器**
说明：实现 sequence、UTF-8 限长、工具状态迁移、首个终态获胜和安全超限降级；归一器只消费已经脱敏的中性草稿。

- [x] **第 3 步: 覆盖归一器边界测试**
说明：验证连续 sequence、非法事件不占号、相同文本不误删、工具回退、重复终态、中文/emoji 截断、Plan/Diff 上限和可序列化边界。

### 任务 2: 接入 Grok ACP Turn 生命周期

- [x] **第 1 步: 建立 active turn 上下文**
说明：每次 Prompt 创建 taskId、turnId 和归一器，快照 connection/runtimeSessionId，并拒绝并发 Prompt 和旧会话事件。

- [x] **第 2 步: 收口取消、权限与失败终态**
说明：取消时先取消当前 Turn 的待处理权限并继续接收最终工具更新；Prompt reject、当前进程异常退出和显式断开分别形成唯一 failed/cancelled 终态。

- [x] **第 3 步: 校准 ACP 映射边界**
说明：复用 P0-01 已完成的逐字段映射，显式忽略当前 schema 中不展示的 update；未知测试输入只生成安全提示，不重新引入 raw payload。

### 任务 3: 防重复消费并完成验收

- [x] **第 1 步: 接入 Renderer 顺序守卫**
说明：Renderer 按 `(taskId, sequence)` 拒绝重复和旧事件，终态后不再消费该 task 的事件，并使用 taskId 组合消息与工具稳定 key。

- [x] **第 2 步: 完成自动化与构建验证**
说明：依次运行目标 ESLint、专项 Vitest、完整 ESLint、`pnpm test`、`pnpm typecheck`、`pnpm build` 和 `git diff --check`。

- [x] **第 3 步: 完成开发版手工走查**
说明：验证连接、真实 Prompt 流、工具/终态、取消和错误反馈；真实 API 只通过应用安全存储使用，记录 HTTP 传输风险且不输出 Key。

## 验收标准

- [x] 同一任务输出的事件具有连续 sequence；同一归一化事件重复投递不重复渲染；旧 session、工具回退、重复终态和终态后事件不会污染当前 UI。
- [x] 文本、Plan、Diff 和整体事件均有 UTF-8 字节上限与截断标记；当前 schema 已知忽略项不中断任务，未知或 schema 不兼容路径不泄漏 API Key、环境变量、原始对象或堆栈。
- [x] 新增核心函数与安全边界有中文注释；自动化测试只用假凭据；Node.js 20+、pnpm 10.x 下目标/全量 ESLint、Vitest、typecheck、build、diff-check 和开发版对应手工走查均有真实验证证据。

## 实现与验证证据

- 共享契约与主进程：`AgentEvent` 已具备必填 task/turn/sequence/observedAt 封套；归一器完成 UTF-8 限长、工具状态保护、首个终态获胜和安全超限降级。
- Grok 生命周期：每次 Prompt 创建独立 active turn；旧连接与旧 session 更新被拒绝；取消后继续接收最终工具更新；任一 Turn 终态统一取消待处理权限；Prompt、进程退出和显式断开只形成一个终态。
- Renderer：新增纯 TypeScript 顺序守卫，按 taskId 记录最大 sequence，拒绝重复、晚到及终态后事件；消息和工具 key 均包含 taskId。
- 自动验证环境：Node.js `v22.22.0`、pnpm `10.33.0`。
- 自动验证结果：目标 ESLint 与专项 Vitest 通过；完整 `pnpm exec eslint . --no-cache`、`pnpm test`（`9` 个文件、`77` 个测试）、`pnpm typecheck`、`pnpm build` 和 `git diff --check` 全部通过。
- 开发版走查：在 `/Users/huyaohang/Documents/agentStudioTest` 完成 Runtime 连接、真实流式 Prompt、目录文件名 List 工具、正常终态、取消、进程异常退出反馈与重连；取消后的流式输出稳定停止，未继续消费晚到事件。
- 传输风险：当前 Provider 使用 HTTP，API Key 与请求内容没有传输加密；手工联调仅发送无敏感信息的测试文案，不读取文件内容，不输出或记录 API Key。

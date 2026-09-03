# P0-19h 上下文用量 signals 桥接实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标：** 让 Agent Studio 在 Grok ACP 没有发送 `usage_update` 时，仍能从当前 Grok 会话的 `signals.json` 读取真实上下文窗口用量，并沿用现有中性 Usage 事件链显示在 Composer。

**核心数据流：** 主进程根据当前 Task 绑定的 `workspace`、`runtimeSessionId` 和 App 专属 Managed `GROK_HOME` 定位 `sessions/<encodeURIComponent(workspace)>/<runtimeSessionId>/signals.json`。主进程只读取并校验有限数值字段，转换成现有 `AgentContextUsage`，再通过 `AgentEventNormalizer` 和既有 `AgentEvent` sink 发布 `kind: 'usage'`；Renderer 继续消费原有 Timeline reducer 与 Composer presentation，不新增 IPC 或直接读盘。

**约束与边界：**

- 只读取 App 管理的 `userData/grok-home`，不得读取用户 `~/.grok`、任意 workspace 或任意 session。
- 只允许 `contextTokensUsed`、`contextWindowTokens`、`contextWindowUsage` 等已确认字段进入产品逻辑；忽略未知字段、原始 JSON、模型请求内容和密钥。
- 当前 ACP `usage_update` 仍是首选来源；signals 只作同一 session/turn 生命周期内的补充来源，不能制造重复的等值事件。
- 文件不存在、JSON 损坏、字段缺失/非有限数值、超限或路径越界时安全返回 `null`，不阻塞 Turn，也不向 Renderer 暴露错误细节。
- 不修改另一个聊天窗口正在编辑的 `App.vue`、`TaskComposer.vue`、`task-*`、`shared/task-*` 与历史/Timeline 文件；不新增通用 Runtime 框架或宽泛 IPC。

**主要风险：**

- **串读其他会话：** 仅用 Adapter 已验证的当前 session/workspace，并校验解析后的最终路径位于 Managed `GROK_HOME` 内；测试覆盖相邻 workspace、相邻 session 和路径编码。
- **重复或倒退事件：** 当前 Turn 记录已发布 signals 快照的稳定键/最后值，重复轮询不重复发布；旧文件或晚到读取必须经过 active connection/session/Turn 校验。
- **Runtime 写入竞态：** 读取使用有界 `readFile` + JSON 解析；半写入或损坏内容按 `null` 处理，下一次合法快照可恢复。
- **UI 回归：** 不改 Renderer 末端展示，只验证新事件能到达既有 reducer/Composer；自动测试与开发版 GUI 结果分开记录。

**技术栈：** Electron 主进程、Node `fs/promises`、TypeScript、Vitest、现有 Grok ACP Adapter / AgentEventNormalizer / Timeline Usage 事件链。

---

### 任务 1: 冻结信号文件契约与安全读取器

**任务目标：** 新增一个只服务 `runtime/grok` 的主进程模块，安全读取当前 Grok session 的上下文用量快照。

**文件：**

- 创建: `src/main/runtime/grok/grok-session-signals.ts`
- 创建: `src/main/runtime/grok/grok-session-signals.test.ts`

**前置依赖：**

- 依赖 `getManagedGrokHome(userDataPath)` 的 App 专属目录规则。
- 依赖已观察到的 `signals.json` 字段：`contextTokensUsed`、`contextWindowTokens`、`contextWindowUsage`。

**数据流/接口梳理：**

- 输入为 `grokHome`、`workspace`、`runtimeSessionId`；模块内部用 `encodeURIComponent(workspace)` 拼接会话目录，不接受 Renderer 路径。
- 先确认 sessionId/workspace 为有限长度非空字符串，再解析路径并验证 `signals.json` 的 `realpath`/父级关系仍位于 Managed `GROK_HOME`。
- 以有限文件大小读取 JSON；只投影 `usedTokens`、`limitTokens`，百分比仅作为校验/观察字段，不扩展 `AgentContextUsage`。
- 输出为 `AgentContextUsage | null`，失败返回 `null`；禁止抛出带路径、原始 JSON 或密钥的错误。

- [x] **第 1 步: 实现安全路径与字段投影**
  说明：加入中文 TSDoc，固定目录编码、大小上限、数值范围和未知字段丢弃规则；不得把 `contextWindowUsage` 直接当作分母或展示字符串。

- [x] **第 2 步: 覆盖读取边界测试**
  说明：使用临时 Managed `grok-home` fixture 覆盖合法快照、缺文件、损坏 JSON、未知字段、负数/小数/NaN、窗口为零、超大文件、相邻 workspace/session 和目录越界。
  预期：合法输入得到稳定 `AgentContextUsage`；所有异常输入均为 `null` 且不会泄漏原文。

- [x] **第 3 步: 业务逻辑验证**
  说明：断言 `usedTokens <= limitTokens`、`limitTokens > 0`、百分比与 token 值不一致时采用 token 字段的保守策略，并确认返回对象不包含 Runtime 原始字段。

### 任务 2: 接入 Grok Adapter 的当前 session/turn 事件链

**任务目标：** 在 ACP 未发 `usage_update` 的真实路径中，把合法 signals 快照发布为现有 `kind: 'usage'` context 事件。

**文件：**

- 修改: `src/main/runtime/grok/grok-acp-adapter.ts`
- 修改: `src/main/runtime/grok/grok-acp-adapter.test.ts`

**前置依赖：**

- 依赖任务 1 的读取器。
- 依赖现有 `ActiveTurn` 的 connection/session generation 和 `emitDraft` 终点校验。
- 依赖现有 `AgentEventNormalizer`，不得绕过中性事件归一化。

**数据流/接口梳理：**

- Adapter 在当前 Turn 生命周期的两个受控节点读取 signals：prompt 前先给 Composer 一个已知基线，prompt 返回并等待 session update 队列后、发 turn-complete 前再补读最新值；不做无界轮询。
- 每次读取前校验 `isActiveTurnCurrent(activeTurn)`、workspace 和 runtimeSessionId；读取失败或无变化直接跳过。
- 将读取结果组装成 `createGrokEventBase(..., 'experimental') + { kind: 'usage', usage }`，交给 `emitDraft`，复用能力验证和 sink。
- 以当前 Turn 内的快照指纹去重；若 ACP 原生 `usage_update` 已发布同值，禁止 signals 再重复发布；若值增长则只发布最新合法快照。
- 不新增 IPC，不修改 Renderer，不把 signals 文件路径或 Runtime 模型名写进事件。

- [x] **第 1 步: 运行 GitNexus upstream impact**
  说明：修改 `GrokAcpAdapter.startTurn`、`processSessionUpdate` 或新增调用点前，对实际目标符号执行 `impact({direction: 'upstream'})`，记录直接调用者、受影响流程和风险；若为 HIGH/CRITICAL，先停下汇报并缩小改动。

- [x] **第 2 步: 接入受控读取与去重**
  说明：只新增最小状态字段/私有方法；中文注释说明 signals 是 Runtime 内部补充事实、为何必须绑定当前 session/turn，以及为何失败静默降级。

- [x] **第 3 步: 补 Adapter 测试**
  说明：使用注入的临时 `userDataPath` 和 signals fixture，验证无 ACP usage_update 时 sink 收到 context usage；重复读取不重复发；session/Turn 失效、其他 workspace/session、坏文件不发事件；原生 usage_update 与 signals 同值只保留一条。

- [x] **第 4 步: 业务逻辑验证**
  说明：检查事件经过 normalizer 后仍携带服务层 taskId/turnId、scope 为 `context`、source 为 `experimental`，并能触发已有 capability `usage.context`；确认 Turn 终态和取消路径不被阻塞。

### 任务 3: 既有 Renderer 链路回归与开发版验收

**任务目标：** 证明方案二只补数据源，现有上下文圆环即可显示，不重复改动另一窗口的 Renderer 代码。

**文件：**

- 只读检查: `src/renderer/src/task-timeline-reducer.ts`
- 只读检查: `src/renderer/src/App.vue`
- 只读检查: `src/renderer/src/components/TaskComposer.vue`
- 只读检查: `src/renderer/src/task-composer-actions.ts`

**前置依赖：**

- 依赖任务 2 已能通过 sink 发布合法 `kind: 'usage'` 事件。
- 依赖另一个窗口的 Composer/Timeline 改动保持不被覆盖。

**数据流/接口梳理：**

- `App.vue` 从 Timeline facts 取最新 context usage。
- `task-composer-actions.ts` 将 token/limit 转为现有 presentation。
- `TaskComposer.vue` 仅在 usage 非空时显示圆环，因此 Renderer 不需要知道 signals.json。

- [x] **第 1 步: 自动回归**
  说明：运行目标 Vitest、目标 ESLint、`pnpm typecheck`、`pnpm build` 和 `git diff --check`；不得因为另一个窗口的未提交改动而做全量格式化或清理。

- [ ] **第 2 步: 开发版 GUI 走查**
  说明：不重启/杀掉现有开发版和其他任务进程；在当前 Grok Runtime 产生一轮上下文变化后观察 Composer 圆环和数值，确认显示的是当前 Task 的 session，而非另一 workspace/session。
  预期：合法 signals 快照出现后显示用量；文件暂时不存在时保持原空态；Runtime 断开或切换 Task 后旧数值不串台。

- [x] **第 3 步: 变更范围检查**
  说明：提交前执行 GitNexus `detect_changes()`（当前工作区以 diff scope 检查）并人工检查 `git diff`，确认只涉及本计划新增 Runtime 文件和 Adapter 接入，不包含另一个窗口的脏改动。

## 验收标准

- [ ] 合法 `signals.json` 能在 ACP 没有 `usage_update` 时产生一条现有 `AgentContextUsage` 事件。
- [ ] 事件只绑定当前 Task 的 `workspace + runtimeSessionId + turnId`，其他 workspace/session 永不进入 Composer。
- [ ] 重复快照、同值原生 ACP usage 与损坏/缺失文件均不会造成重复、崩溃或错误提示刷屏。
- [ ] Renderer 不新增文件读取、IPC 或协议字段；既有 Composer 圆环在收到事件后可见。
- [ ] 自动验证全部通过；GUI 结果单独记录，未走查前不宣称视觉验收完成。
- [ ] `git diff --check` 通过，且未覆盖另一个聊天窗口已有的 staged/unstaged 修改。

## 自我审查

- 需求覆盖：包含当前上下文用量显示、方案二 signals 来源、主进程安全边界、其他任务隔离、异常/重复处理、自动验证和 GUI 验收。
- 任务闭环：读取器 → Adapter 事件 → 既有 Renderer 回归，顺序满足依赖且每项都有完成标志。
- 范围控制：没有引入新的 IPC、通用 Runtime 抽象或 Renderer 重写。
- 一致性：统一使用 `contextTokensUsed`/`contextWindowTokens` 输入和 `AgentContextUsage.usedTokens`/`limitTokens` 输出；ACP 原生 usage 仍为首选事实来源。

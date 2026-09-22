# 当前轮补充消息实施计划

> **致执行者：** 优先按任务顺序逐项落地，并在每个任务完成后做业务逻辑验证。步骤使用复选框 (`- [ ]`) 语法进行跟踪。

**目标：** 当前轮执行过程中，用户发送的补充消息可在该轮下一安全间隙被 Grok 消费，不用排队下一轮冒充。

**核心数据流：** Composer 补充文本 → 独立窄 IPC → AgentService 校验当前执行身份 → Grok Adapter 扩展请求 → 经验证的确认事件 → 同一 Turn 的持久化补充记录和界面状态。

**约束与边界：** 对应问题 1.6，2026-09-20 用户明确选择立即补充当前轮。保留单执行槽；不取消当前轮、不并发创建新 Turn、不写用户 PTY、不猜 `_meta`、不使用真实 Key 或付费调用做自动验证。该计划从已关闭的 P0-09 测试门之后开始，不改旧测试时间线。

**主要风险：** 扩展请求名字不等于已验证契约；已接收不等于已消费；结束竞态可能使 Grok 将补充降级为下一轮；重复发送和事件乱序造成重复消息。

**技术栈：** Grok 1.0.34、ACP SDK 1.3.0、TypeScript、Vitest、本地 Mock Provider。

**状态：** 真实 Grok ACP 探针已证明 active 阶段 interjection 可在同一轮消费；但 terminal 竞态下 fallback 会启动新的 prompt，未满足“不排队、不创建下一轮”硬门槛。**生产入口保持关闭**，不得把 active 成功描述成完整支持当前轮补充。后续须证明可禁止 terminal fallback，再评估接入；本轮只同步已有观察结论，未重新运行真实探针。

---

## 已有证据

- 当前 IPC 仅允许 ready，TaskExecutor 排他准入，Adapter 存在 activeTurn 时拒绝普通 prompt。
- 本机官方 `grok --version` 为 `1.0.34 (3736acbc8658)`。
- 程序内嵌说明：`follow_up_behavior = "steer"` 在下一工具或模型安全间隙注入。
- 程序包含 `x.ai/interject`、`InterjectRequest`、`x.ai/session/interjection` 及当前轮 synthetic user message 的实现字符串。
- 程序也有 stranded interjection 转为 queued prompt turn 的字符串，必须测试终态竞态。
- SDK 没有标准 steer 方法，但有扩展请求入口；不能据此推断普通第二次 `session/prompt` 可以注入。

## 任务 1：冻结版本与协议契约

**文件：** 新增 `scripts/observe-grok-interjection.mjs`、本地 Mock Provider 测试夹具及 `src/main/runtime/grok/grok-interjection-contract.test.ts`；脱敏证据写入本计划。

- [ ] 隔离临时 HOME/GROK_HOME，去除所有真实凭据继承，使用明显假 Key；只准本地 Mock Provider，禁止真实插件/工具副作用和外网。
- [ ] 从官方公开 schema、帮助或扩展能力响应确定请求参数及通知形状；仅把 `x.ai/interject` 作为待证实候选，不猜参数上线。
- [ ] Mock 挂住首个模型响应，在原轮未结束时发唯一补充标记，再释放到下一工具/模型安全间隙。
- [ ] 断言原轮没有取消、没有结束、没有新轮，且该轮后续模型请求实际包含标记；保存脱敏请求、确认及轮次顺序。
- [ ] 对照普通第二次 prompt；测试补充时原轮结束、连续补充、取消、断连、方法不存在、超时。
- [ ] 必须证明补充与终态竞态不会自动创建/排队下一轮；若 Grok 扩展无法禁止该降级，本版本不得开放该入口，仅有 UI 失败提示不算满足“不排队”。
- [ ] 若无法证明同轮消费，记录精确失败证据并停止生产接入，不做排队降级替代；其他 P0-23 修复不被此门阻塞。

**完成标志：** 有可重复的本地协议证据、明确参数/确认语义及版本边界；仅字符串证据不算通过。

## 任务 2：独立补充消息通路

**前置依赖：** 任务 1 通过，并等待 P0-23A 权限准入及持久化契约稳定；未通过时不得开放生产入口。与 P0-23C/D 的 Composer 改动串行整合，协议探针可独立并行。

**文件：** `src/main/agent/agent-runtime-adapter.ts`、`agent-service.ts`、`agent/ipc.ts`、`src/main/runtime/grok/grok-acp-adapter.ts`、共享 Agent IPC/事件契约、`src/preload/desktop-api.ts`、TaskStore 相关记录与就近测试。

- [ ] 新增中性 `agent:interject-turn` 窄请求，携带 taskId、turnId、客户端消息 ID 和有界文本；session 私有 ID 由主进程解析，不交给 Renderer。
- [ ] 必须匹配真实 active execution；过期轮、跨 Task、取消中和已结束明确拒绝，不能转到新轮。
- [ ] 复用原执行身份调用已经冻结的 Grok 扩展，不进入 createTurn / startTurn admission，也不移除现有普通 prompt 排他门禁。
- [ ] 补充消息有独立 accepted/consumed/failed 或可证实等价状态；主进程持久化后发布，重启后不自动重发未确认消息。
- [ ] 按消息 ID 去重，未知交付结果不盲目重试；只能使用任务 1 已证明不会自动降级到下一轮的契约，发现违反立即禁用当前版本能力并保留证据。
- [ ] 附件仅在协议已验证支持时开放补充，否则明确保留草稿并提示，不悄悄丢附件。

**完成标志：** 同一 Turn 中能可靠记录、发送和确认补充，生命周期与原执行槽不受破坏。

## 任务 3：Composer 与对话反馈

**文件：** `TaskComposer.vue`、`task-composer-actions.ts`、`App.vue`、`TaskConversation.vue`、相关时间线投影及测试。

- [ ] 当前任务执行时允许输入，发送动作明确为“补充当前任务”；停止按钮独立保留，不与补充动作互相替代。
- [ ] 尚未收到确认显示发送中/等待安全间隙；只有证据支持才显示已送达当前轮。
- [ ] 失败或旧版本不支持保留草稿，解释原因；禁止偷偷排队或取消原任务。
- [ ] 支持输入法、快速连续发送、切 Task 后返回、取消竞态与键盘快捷键，绑定的仍是发送时的 Task/Turn。

**完成标志：** 用户能在当前轮补充并看到真实结果，不混淆排队或中断重发。

## 验证与验收

- [ ] GitNexus impact 覆盖 Adapter、AgentService、持久化与事件投影；HIGH/CRITICAL 在编辑前提示。
- [ ] 目标及完整 Vitest、ESLint、typecheck、build、`git diff --check`；入口变动补 `build:unpack`。
- [ ] 本地 Mock Provider 协议试验和开发版 GUI 两层都通过；自动化产物放 `autoTest/active-turn-interjection/`。
- [ ] “原轮后续请求含补充标记”是硬验收，按钮可点击、RPC 成功或队列创建均不算完成。
